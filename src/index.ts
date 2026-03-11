import { TurnHelper } from './turn';

export interface Env {
	ASSETS: Fetcher;
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

		// TODO: Any other path names we need here?
		if (url.pathname.endsWith('turn') || url.pathname.endsWith('turn/')) {
			const options = { headers: { 'content-type': 'application/json' } };
			// const url = 'https://jsonplaceholder.typicode.com/todos/1';

			// // gatherResponse returns both content-type & response body as a string
			// async function gatherResponse(response: any) {
			// 	const { headers } = response;
			// 	const contentType = headers.get('content-type') || '';
			// 	if (contentType.includes('application/json')) {
			// 		return { contentType, result: JSON.stringify(await response.json()) };
			// 	}
			// 	return { contentType, result: response.text() };
			// }

			try {
				const response = await TurnHelper.generate(env.TURN_SECRET_KEY);
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
