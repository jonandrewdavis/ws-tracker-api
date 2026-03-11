export interface Env {
	TURN_KEY: string;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		// Serve root-level static files (favicon.ico, robots.txt) directly.
		// Hashed assets under /assets/* skip the Worker entirely via run_worker_first.
		if (url.pathname.match(/\.\w+$/) && !url.pathname.endsWith('.html')) {
			return env.ASSETS.fetch(request);
		}

		// gatherResponse returns both content-type & response body as a string
		async function gatherResponse(response) {
			const { headers } = response;
			const contentType = headers.get('content-type') || '';
			if (contentType.includes('application/json')) {
				return { contentType, result: JSON.stringify(await response.json()) };
			}
			return { contentType, result: response.text() };
		}

		const response = await fetch(url);
		const { contentType, result } = await gatherResponse(response);

		const options = { headers: { 'content-type': contentType } };
		return new Response(result, options);
	},
} satisfies ExportedHandler<Env>;
