import { DurableObject } from 'cloudflare:workers';
import { TurnHelper } from './turn';

export interface Env {
	ASSETS: Fetcher;
	TURN_API_ID: string;
	TURN_SECRET_KEY: string;
	WEBSOCKET_SERVER: DurableObjectNamespace<WebSocketServer>;
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

const ALLOWED_ORIGINS = [
	'https://html-classic.itch.zone',
	'https://andoodev.com',
	'https://www.andoodev.com',
	'https://androodev.com',
	'https://www.androodev.com',
	'https://bewe.me',
	'https://orbitals.dev.bewe.me',
];

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
				const response = await TurnHelper.generate(env.TURN_API_ID, env.TURN_SECRET_KEY);
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
				console.log('Error for turn');
			}
		}

		if (request.url.endsWith('websocket') || request.url.endsWith('websocket/')) {
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
			const origin = request.headers.get('Origin');
			if (origin && !ALLOWED_ORIGINS.includes(origin)) {
				return new Response('Forbidden', { status: 403 });
			}
			return stub.fetch(request);
		}

		const options = { headers: { 'content-type': 'application/json' } };
		const nothing = { response: 'not found' };
		var response = new Response(JSON.stringify(nothing), options);
		return handleCors(request, response);
	},
} satisfies ExportedHandler<Env>;

export class WebSocketServer extends DurableObject {
	// Keeps track of all WebSocket connections
	sessions: Map<WebSocket, { [key: string]: string }>;
	sessionLookup: Map<string, WebSocket>;
	waitingSessions: string[];

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sessions = new Map();
		this.sessionLookup = new Map();
		this.waitingSessions = [];
	}

	async fetch(request: Request): Promise<Response> {
		const upgradeHeader = request.headers.get('Upgrade');
		if (!upgradeHeader || upgradeHeader !== 'websocket') {
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

	// Incoming from Godot client request for queue with "connect"
	async handleWebSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		const connection = this.sessions.get(ws);
		if (!connection) return;

		if (message === 'connect') {
			if (!this.sessionLookup.has(connection.id)) {
				this.sessionLookup.set(connection.id, ws);
			}

			if (!this.waitingSessions.includes(connection.id)) {
				this.waitingSessions.push(connection.id);
				ws.send(JSON.stringify({ action: Actions.WAIT }));
			}

			this.tryMatchmaking();
			return;
		}
	}

	tryMatchmaking() {
		// Filter out any sessions that are no longer present in sessionLookup
		// or whose WebSocket connection is not in the OPEN state.
		this.waitingSessions = this.waitingSessions.filter((id) => {
			const ws = this.sessionLookup.get(id);
			return ws !== undefined && ws.readyState === 1; // 1 represents WebSocket.READY_STATE_OPEN
		});

		while (this.waitingSessions.length >= 2) {
			const player1Id = this.waitingSessions.shift()!;
			const player2Id = this.waitingSessions.shift()!;

			const ws1 = this.sessionLookup.get(player1Id)!;
			const ws2 = this.sessionLookup.get(player2Id)!;

			const room_id = crypto.randomUUID().slice(0, 8);
			const sessionIds = [player1Id, player2Id];

			let p1Success = false;
			let p2Success = false;

			// Try to send the match details to Player 1
			try {
				ws1.send(
					JSON.stringify({
						action: Actions.LOBBY,
						payload: { sessionIds, host: true, room_id },
					}),
				);
				p1Success = true;
			} catch (err) {
				console.error(`Failed to send lobby payload to player 1 (${player1Id}):`, err);
				this.handleFailedMatchPlayer(player1Id, ws1);
			}

			// Try to send the match details to Player 2
			try {
				ws2.send(
					JSON.stringify({
						action: Actions.LOBBY,
						payload: { sessionIds, host: false, room_id },
					}),
				);
				p2Success = true;
			} catch (err) {
				console.error(`Failed to send lobby payload to player 2 (${player2Id}):`, err);
				this.handleFailedMatchPlayer(player2Id, ws2);
			}

			// Handle recovery if one of the sends failed
			if (p1Success && !p2Success) {
				// Player 2 failed, re-queue Player 1 and notify them
				this.waitingSessions.push(player1Id);
				try {
					ws1.send(JSON.stringify({ action: Actions.WAIT }));
				} catch {}
			} else if (!p1Success && p2Success) {
				// Player 1 failed, re-queue Player 2 and notify them
				this.waitingSessions.push(player2Id);
				try {
					ws2.send(JSON.stringify({ action: Actions.WAIT }));
				} catch {}
			}
		}
	}

	handleFailedMatchPlayer(id: string, ws: WebSocket) {
		this.sessionLookup.delete(id);
		this.sessions.delete(ws);
		try {
			ws.close(1011, 'Matchmaking transmission failed');
		} catch {}
	}

	async handleConnectionClose(ws: WebSocket) {
		const connection = this.sessions.get(ws);
		if (connection) {
			this.sessions.delete(ws);
			this.sessionLookup.delete(connection.id);
			this.waitingSessions = this.waitingSessions.filter((id) => id !== connection.id);
		}
		try {
			ws.close(1000, 'Durable Object is closing WebSocket');
		} catch {}
	}
}
