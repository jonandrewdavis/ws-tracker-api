import { TurnHelper } from './turn';

export interface Env {
	ASSETS: Fetcher;
	TURN_API_ID: string;
	TURN_SECRET_KEY: string;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
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
					return new Response(JSON.stringify(response), options);
				} else {
					const nothing = { response: 'not found' };
					return new Response(JSON.stringify(nothing), options);
				}
			} catch {}
		}

		const options = { headers: { 'content-type': 'application/json' } };
		const nothing = { response: 'not found' };
		return new Response(JSON.stringify(nothing), options);
	},
} satisfies ExportedHandler<Env>;
