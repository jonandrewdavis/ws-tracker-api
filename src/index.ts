import { DurableObject } from 'cloudflare:workers';
import { TurnHelper } from './turn';

export interface Env {
	ASSETS: Fetcher;
	TURN_API_ID: string;
	TURN_SECRET_KEY: string;
	WEBSOCKET_SERVER: any;
	readonly MY_FIRST_QUEUE: Queue;
}

const ALLOWED_ORIGINS = ['https://html-classic.itch.zone', 'https://androodev.com', 'https://www.androodev.com', 'https://bewe.me'];

function handleCors(request: Request<unknown>, response: Response) {
	const origin = request.headers.get('Origin');
	if (origin && ALLOWED_ORIGINS.includes(origin)) {
		response.headers.set('Access-Control-Allow-Origin', origin);
	}
	// Set other necessary CORS headers
	response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
	response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
	response.headers.set('Access-Control-Max-Age', '86400'); // Cache preflight requests for 24 hours
	return response;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		if (request.method === 'OPTIONS') {
			const response = new Response(null, {
				status: 204, // No Content for OPTIONS request
			});

			return handleCors(request, response);
		}

		const url = new URL(request.url);

		// Serve root-level static files (favicon.ico, robots.txt) directly.
		// Hashed assets under /assets/* skip the Worker entirely via run_worker_first.
		if (url.pathname.match(/\.\w+$/) && !url.pathname.endsWith('.html')) {
			return env.ASSETS.fetch(request);
		}

		// TODO: Any other path names we need here? I'm not confident this is the best way to route these worker requests.
		if (url.pathname.endsWith('turn') || url.pathname.endsWith('turn/')) {
			const options = { headers: { 'content-type': 'application/json' } };

			try {
				const response = await TurnHelper.generate(env.TURN_SECRET_KEY, env.TURN_SECRET_KEY);
				if (response != null) {
					const turnResponse = new Response(JSON.stringify(response), options);
					return handleCors(request, turnResponse);
				} else {
					const nothing = { response: 'not found' };
					var nothingResponse = new Response(JSON.stringify(nothing), options);
					return handleCors(request, nothingResponse);
				}
			} catch {}
		}

		if (url.pathname.endsWith('matchmaking') || url.pathname.endsWith('matchmaking/')) {
			const message = {
				url: request.url,
				method: request.method,
				headers: Object.fromEntries(request.headers),
			};

			await env.MY_FIRST_QUEUE.send(message); // This will throw an exception if the send fails for any reason
			const response = new Response('Sent!');
			return handleCors(request, response);
		}

		if (request.url.endsWith('/websocket')) {
			// Expect to receive a WebSocket Upgrade request.
			// If there is one, accept the request and return a WebSocket Response.
			const upgradeHeader = request.headers.get('Upgrade');
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
				return new Response('Worker expected Upgrade: websocket', {
					status: 426,
				});
			}

			if (request.method !== 'GET') {
				return new Response('Worker expected GET method', {
					status: 400,
				});
			}

			// Since we are hard coding the Durable Object ID by providing the constant name 'foo',
			// all requests to this Worker will be sent to the same Durable Object instance.
			let id = env.WEBSOCKET_SERVER.idFromName('foo');
			let stub = env.WEBSOCKET_SERVER.get(id);

			return stub.fetch(request);
		}

		const options = { headers: { 'content-type': 'application/json' } };
		const nothing = { response: 'not found' };
		var response = new Response(JSON.stringify(nothing), options);
		return handleCors(request, response);
	},

	async queue(batch, env, ctx): Promise<void> {
		console.log('DEBUG: New batch');
		// Do something with messages in the batch
		// i.e. write to R2 storage, D1 database, or POST to an external API
		for (const msg of batch.messages) {
			// Process each message
			console.log(msg.body);
			let id = env.WEBSOCKET_SERVER.idFromName('foo');
			env.WEBSOCKET_SERVER.get(id);
		}
	},
} satisfies ExportedHandler<Env>;

export class WebSocketServer extends DurableObject {
	// Keeps track of all WebSocket connections
	sessions: Map<WebSocket, { [key: string]: string }>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sessions = new Map();
	}

	async fetch(request: Request): Promise<Response> {
		// Creates two ends of a WebSocket connection.
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		// Calling `accept()` tells the runtime that this WebSocket is to begin terminating
		// request within the Durable Object. It has the effect of "accepting" the connection,
		// and allowing the WebSocket to send and receive messages.
		server.accept();

		// Generate a random UUID for the session.
		const id = crypto.randomUUID();
		// Add the WebSocket connection to the map of active sessions.
		this.sessions.set(server, { id });

		this.env.MY_FIRST_QUEUE.send(id);

		server.addEventListener('message', (event) => {
			this.handleWebSocketMessage(server, event.data);
		});

		// If the client closes the connection, the runtime will close the connection too.
		server.addEventListener('close', () => {
			this.handleConnectionClose(server);
		});

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async handleWebSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		const connection = this.sessions.get(ws)!;

		// Reply back with the same message to the connection
		ws.send(
			`[Durable Object] message: ${message}, from: ${connection.id}, to: the initiating client. Total connections: ${this.sessions.size}`,
		);

		// Broadcast the message to all the connections,
		// except the one that sent the message.
		this.sessions.forEach((_, session) => {
			if (session !== ws) {
				session.send(
					`[Durable Object] message: ${message}, from: ${connection.id}, to: all clients except the initiating client. Total connections: ${this.sessions.size}`,
				);
			}
		});

		// Broadcast the message to all the connections,
		// including the one that sent the message.
		this.sessions.forEach((_, session) => {
			session.send(
				`[Durable Object] message: ${message}, from: ${connection.id}, to: all clients. Total connections: ${this.sessions.size}`,
			);
		});
	}

	async handleConnectionClose(ws: WebSocket) {
		this.sessions.delete(ws);
		ws.close(1000, 'Durable Object is closing WebSocket');
	}
}
