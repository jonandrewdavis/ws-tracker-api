const TURN_API_ID = 'a11e40ec8d548f278468046b27538534'; // Replace with your TURN Key ID
// const TURN_SECRET_KEY = ''; // Replace with your Secret API token

const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_API_ID}/credentials/generate-ice-servers`;

const body = JSON.stringify({
	ttl: 86400,
});

interface TurnResponse {
	urls: String[];
	username: String;
	credential: String;
}

// TODO: construct this at init and inject env.TURN_SECRET_KEY in it so it always has it, rather than passing it in.
export class TurnHelper {
	/**
	 *
	 * @param message
	 */
	public static async generate(TURN_SECRET_KEY: String): Promise<TurnResponse | null> {
		const fetchTurnCredentials = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${TURN_SECRET_KEY}`,
				'Content-Type': 'application/json',
			},
			body: body,
		})
			.then((response: Response) => response.json())
			.then((data: TurnResponse) => data)
			.catch((_error: Error) => null);

		return fetchTurnCredentials;
	}
}
