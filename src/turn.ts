// const TURN_API_ID = ''; // Replace with your TURN Key ID
// const TURN_SECRET_KEY = ''; // Replace with your Secret API token

const body = JSON.stringify({
	ttl: 86400,
});

interface TurnResponse {
	iceServers: IceServer[];
}

interface IceServer {
	urls: String[];
	username?: String;
	credential?: String;
}

// TODO: construct this at init and inject env.TURN_SECRET_KEY in it so it always has it, rather than passing it in.
export class TurnHelper {
	/**
	 * @param TURN_API_ID
	 * @param TURN_SECRET_KEY
	 */
	public static async generate(TURN_API_ID: String, TURN_SECRET_KEY: String): Promise<TurnResponse | null> {
		// The most common failure: env vars unset in this environment (they only
		// live in .dev.vars locally and are NOT uploaded by `wrangler deploy`).
		// Without this guard the URL gets `undefined` and the API 404s.
		if (!TURN_API_ID || !TURN_SECRET_KEY) {
			console.log('TURN config missing: TURN_API_ID/TURN_SECRET_KEY not set in this environment');
			return null;
		}

		const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_API_ID}/credentials/generate-ice-servers`;

		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${TURN_SECRET_KEY}`,
					'Content-Type': 'application/json',
				},
				body: body,
			});

			if (!response.ok) {
				const detail = await response.text();
				console.log(`TURN request failed: ${response.status} ${detail.slice(0, 200)}`);
				return null;
			}

			const data = (await response.json()) as TurnResponse;
			return this.filterTurnToTCP(data);
		} catch (error) {
			console.log('Error fetching TURN:', error);
			return null;
		}
	}

	public static filterTurnToTCP({ iceServers }: TurnResponse): TurnResponse | null {
		// Guard a malformed/error body so a bad response degrades to null
		// instead of throwing `Cannot read properties of undefined (reading 'length')`.
		if (!Array.isArray(iceServers)) {
			console.log('TURN response missing iceServers array');
			return null;
		}

		if (iceServers.length == 2) {
			const turnOnTCP = iceServers[1];
			turnOnTCP.urls = ['turns:turn.cloudflare.com:443?transport=tcp'];
			return {
				iceServers: [iceServers[0], turnOnTCP],
			};
		}

		console.log('Warning: TURN had unexpected length, ICE is missing');

		return {
			iceServers,
		};
	}
}
