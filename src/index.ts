import { DurableObject } from 'cloudflare:workers';
import { TurnHelper } from './turn';

export interface Env {
	ASSETS: Fetcher;
	TURN_API_ID: string;
	TURN_SECRET_KEY: string;
	WEBSOCKET_SERVER: any;
	readonly MY_FIRST_QUEUE: Queue;
}

enum Actions {
	CONNECT = 'connect',
	WAIT = 'wait',
	LOBBY = 'lobby',
	ERROR = 'error',
}

interface Message {
	action: Actions;
	payload?: LobbyPayload | ErrorPayload;
}

interface LobbyPayload {
	sessionIds: string[];
	host: string;
	room_id: string;
}

interface ErrorPayload {
	message: string;
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
			} catch {
				// TODO: Error for turn
				console.log('Error for turn')
			}
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

	// Queue processes every 2 items
	// Queue always acks the message regardless of success or failure
	// It's up to the websocket to handle the message and requeue if necessary
	async queue(batch, env, _ctx): Promise<void> {
		let id = env.WEBSOCKET_SERVER.idFromName('foo');
		let stub = env.WEBSOCKET_SERVER.get(id);

		try {
			const sessionIds: string[] = [];

			for (const msg of batch.messages) {
				sessionIds.push(msg.body as string);
			}

			const message: Message = {
				action: Actions.LOBBY,
				payload: {
					sessionIds,
					host: sessionIds[0],
					room_id: crypto.randomUUID(),
				}
			}

			// NOTE: Does not expect a response. Just process it.
			await stub.fetch(new Request('http://internal/broadcast', {
				method: 'POST',
				body: JSON.stringify(message)
			}));
		} catch (err) {
			console.error("Failed to proces message queue :", err);
		} finally {
			for (const msg of batch.messages) {
				// console.log('DEBUG: Ack - ', batch.messages.length, msg)
				msg.ack();
			}
		}
	},
} satisfies ExportedHandler<Env>;

export class WebSocketServer extends DurableObject {
	// Keeps track of all WebSocket connections
	sessions: Map<WebSocket, { [key: string]: string }>;
	sessionLookup: Map<string, WebSocket>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sessions = new Map();
		this.sessionLookup = new Map();
	}

	async fetch(request: Request): Promise<Response> {
		const upgradeHeader = request.headers.get('Upgrade');
		if (!upgradeHeader || upgradeHeader !== 'websocket') {
			if (request.method === 'POST') {
				this.handleQueue(request)
			}
			return new Response('Durable Object expected Upgrade: websocket', { status: 426 });
		}

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

	// Incoming from Godot client
	// Can queue or request a retry
	async handleWebSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		const connection = this.sessions.get(ws)!;

		if (message == "connect" && !this.sessionLookup.has(connection.id)) {
			ws.send(JSON.stringify({ action: Actions.WAIT }));
			this.env.MY_FIRST_QUEUE.send(connection.id);
			this.sessionLookup.set(connection.id, ws);
			return;
		}

		// TODO: Better retry 
		if (message == "retry" && this.sessionLookup.has(connection.id)) {
			ws.send(JSON.stringify({ action: Actions.WAIT }));
			this.env.MY_FIRST_QUEUE.send(connection.id);
			return;
		}
		// Reply back with the same message to the connection
	}

	async handleQueue(request: Request) {
		try {
			const message: Message = await request.json();
			try {
				if (this._validateMessage(message) === false) {
					throw new Error('Error: Queue validation failed: ' + JSON.stringify(message));
				}

				// We passed the validation. Send the payload and that's the best we can do
				var payload = message.payload as LobbyPayload
				payload.sessionIds.forEach((sessionId) => {
					const session = this.sessionLookup.get(sessionId)
					if (session) {
						const host = sessionId === payload.host
						session.send(JSON.stringify({ action: Actions.LOBBY, payload: { ...payload, host } }));
					}
				});
			} catch (err) {
				// Here we notify any waiting clients that there was an error
				console.error('Sending to clients:', err);
				if (message.payload && 'sessionIds' in message.payload) {
					message.payload.sessionIds.forEach((sessionId) => {
						const session = this.sessionLookup.get(sessionId)
						if (session) {
							const newErrorMessage: Message = { action: Actions.ERROR, payload: { message: 'Matchmaking failed, please try again' } }
							session.send(JSON.stringify(newErrorMessage));
						}
					});
				} else {
					console.error('Nothing sent to clients: ' + JSON.stringify(message));
				}
			}
		} catch (err) {
			console.error('CRITICAL: : own error handling queue:', err);
		}
	}

	// 1. Must be Lobby action
	// 2. Must have exactly 2 session ids
	// 3. Must not be the same. 
	// 4. Must be in the session look up
	// 5. Must have an active connection to websocket
	_validateMessage(message: Message): boolean {
		if (message.action !== Actions.LOBBY) {
			return false;
		}

		var payload = message.payload as LobbyPayload
		if (payload.sessionIds.length !== 2) {
			return false;
		}

		if (payload.sessionIds[0] === payload.sessionIds[1]) {
			return false;
		}

		if (payload.host !== payload.sessionIds[0]) {
			return false;
		}

		for (const sessionId of payload.sessionIds) {
			if (!this.sessionLookup.has(sessionId)) {
				return false;
			}
		}


		for (const sessionId of payload.sessionIds) {
			const ws = this.sessionLookup.get(sessionId);
			if (!ws) {
				return false;
			}
			const connection = this.sessions.get(ws);
			if (!connection) {
				return false;
			}
		}

		return true;
	}

	async handleConnectionClose(ws: WebSocket) {
		const connection = this.sessions.get(ws)!;
		this.sessions.delete(ws);
		this.sessionLookup.delete(connection.id);
		ws.close(1000, 'Durable Object is closing WebSocket');
	}
}
