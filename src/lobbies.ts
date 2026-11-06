import { DurableObject } from 'cloudflare:workers';

// Hosts heartbeat every ~5s; anything silent for longer than this is swept.
const LOBBY_TTL_MS = 15_000;
const SWEEP_INTERVAL_MS = 10_000;
const MAX_LOBBIES_PER_APP = 200;
const MAX_NAME_LENGTH = 32;
const MAX_PLAYERS_LIMIT = 64;
const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 64;

export interface LobbyInput {
	app_id: string;
	session_id: string;
	name: string;
	cur_players: number;
	max_players: number;
	joinable: boolean;
	version?: string;
}

export interface Lobby {
	session_id: string;
	name: string;
	cur_players: number;
	max_players: number;
}

export type RegistryResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
	const n = Math.floor(Number(value));
	return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const cleanString = (value: unknown, maxLength: number) => (typeof value === 'string' ? value.trim().slice(0, maxLength) : '');

/**
 * Single global registry of publicly listed lobbies for backends (e.g. Tube) that have no discovery of their own.
 * Hosts pick their own secret token and send their whole listing on every heartbeat, so a swept listing simply reappears.
 * Removing a listing only closes it until the sweep, so a heartbeat still in flight can't bring it back.
 */
export class LobbyRegistry extends DurableObject {
	sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		// TODO: remove once deployed; drops the table from the old create/heartbeat protocol.
		this.sql.exec('DROP TABLE IF EXISTS lobbies');
		this.sql.exec(`CREATE TABLE IF NOT EXISTS listings (
			host_token TEXT PRIMARY KEY,
			app_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			name TEXT NOT NULL,
			cur_players INTEGER NOT NULL,
			max_players INTEGER NOT NULL,
			joinable INTEGER NOT NULL,
			version TEXT NOT NULL,
			last_seen INTEGER NOT NULL,
			closed INTEGER NOT NULL DEFAULT 0,
			UNIQUE (app_id, session_id)
		)`);
		this.sql.exec('CREATE INDEX IF NOT EXISTS listings_app ON listings (app_id, version)');
	}

	/** Inserts or refreshes the listing owned by [token]. */
	async upsert(token: string, input: LobbyInput): Promise<RegistryResult<{ created: boolean }>> {
		if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
			return { ok: false, status: 401, error: 'invalid host token' };
		}
		const app_id = cleanString(input.app_id, 64);
		const session_id = cleanString(input.session_id, 64);
		if (!app_id || !session_id) return { ok: false, status: 400, error: 'app_id and session_id are required' };

		const max_players = clampInt(input.max_players, 1, MAX_PLAYERS_LIMIT, 4);
		const name = cleanString(input.name, MAX_NAME_LENGTH) || 'Lobby';
		const cur_players = clampInt(input.cur_players, 1, max_players, 1);
		const joinable = input.joinable ? 1 : 0;
		const now = Date.now();

		const existing = this.sql.exec('SELECT 1 FROM listings WHERE host_token = ?', token).toArray().length > 0;
		if (existing) {
			this.sql.exec(
				'UPDATE listings SET name = ?, cur_players = ?, max_players = ?, joinable = ?, last_seen = ? WHERE host_token = ? AND closed = 0',
				name,
				cur_players,
				max_players,
				joinable,
				now,
				token,
			);
			await this.ensureAlarm();
			return { ok: true, value: { created: false } };
		}

		this.sweep();
		const count = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM listings WHERE app_id = ?', app_id).one().n;
		if (count >= MAX_LOBBIES_PER_APP) return { ok: false, status: 429, error: 'too many lobbies' };
		const taken = this.sql.exec('SELECT 1 FROM listings WHERE app_id = ? AND session_id = ?', app_id, session_id).toArray().length > 0;
		if (taken) return { ok: false, status: 409, error: 'session already listed' };

		this.sql.exec(
			`INSERT INTO listings (host_token, app_id, session_id, name, cur_players, max_players, joinable, version, last_seen)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			token,
			app_id,
			session_id,
			name,
			cur_players,
			max_players,
			joinable,
			cleanString(input.version, 32),
			now,
		);
		await this.ensureAlarm();
		return { ok: true, value: { created: true } };
	}

	async remove(token: string): Promise<RegistryResult<null>> {
		this.sql.exec('UPDATE listings SET closed = 1 WHERE host_token = ?', token);
		return { ok: true, value: null };
	}

	async list(app_id: string, version: string): Promise<Lobby[]> {
		return this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT session_id, name, cur_players, max_players FROM listings
				WHERE app_id = ? AND version = ? AND closed = 0 AND joinable = 1 AND cur_players < max_players AND last_seen >= ?
				ORDER BY last_seen DESC LIMIT 100`,
				app_id,
				version,
				Date.now() - LOBBY_TTL_MS,
			)
			.toArray() as unknown as Lobby[];
	}

	async alarm(): Promise<void> {
		this.sweep();
		await this.ensureAlarm();
	}

	sweep() {
		this.sql.exec('DELETE FROM listings WHERE last_seen < ?', Date.now() - LOBBY_TTL_MS);
	}

	// Keep sweeping only while there are listings; an empty registry costs nothing.
	async ensureAlarm() {
		const remaining = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM listings').one().n;
		if (remaining > 0 && (await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
		}
	}
}
