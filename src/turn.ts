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
		const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_API_ID}/credentials/generate-ice-servers`;

		// TODO: Avoid casting "data as TurnResponse"
		const fetchTurnCredentials = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${TURN_SECRET_KEY}`,
				'Content-Type': 'application/json',
			},
			body: body,
		})
			.then((response: Response) => response.json())
			.then((data) => this.filterTurnToTCP(data as TurnResponse))
			.catch((error: Error) => {
				console.log('Error fetching TURN:', error);
				return null;
			});

		return fetchTurnCredentials;
	}

	public static filterTurnToTCP({ iceServers }: TurnResponse): TurnResponse {
		//
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
