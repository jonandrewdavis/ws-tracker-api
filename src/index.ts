import { TurnHelper } from './turn';

export interface Env {
	ASSETS: Fetcher;
	TURN_API_ID: string;
	TURN_SECRET_KEY: string;
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

		const options = { headers: { 'content-type': 'application/json' } };
		const nothing = { response: 'not found' };
		var response = new Response(JSON.stringify(nothing), options);
		return handleCors(request, response);
	},
} satisfies ExportedHandler<Env>;
