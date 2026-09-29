import { DurableObject } from 'cloudflare:workers';

// Hosts heartbeat every ~5s; anything silent for longer than this is swept.
const LOBBY_TTL_MS = 15_000;
const SWEEP_INTERVAL_MS = 10_000;
const MAX_LOBBIES_PER_APP = 200;
const MAX_NAME_LENGTH = 32;
const MAX_PLAYERS_LIMIT = 64;

export interface LobbyInput {
	app_id: string;
	session_id: string;
	name: string;
	cur_players: number;
	max_players: number;
	joinable: boolean;
	version?: string;
}

export interface LobbyUpdate {
	cur_players?: number;
	joinable?: boolean;
	name?: string;
}

export interface Lobby {
	id: string;
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

/** Single global registry of publicly listed lobbies for backends (e.g. Tube) that have no discovery of their own. */
export class LobbyRegistry extends DurableObject {
	sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`CREATE TABLE IF NOT EXISTS lobbies (
			id TEXT PRIMARY KEY,
			app_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			name TEXT NOT NULL,
			cur_players INTEGER NOT NULL,
			max_players INTEGER NOT NULL,
			joinable INTEGER NOT NULL,
			version TEXT NOT NULL,
			host_token TEXT NOT NULL,
			last_seen INTEGER NOT NULL
		)`);
		this.sql.exec('CREATE INDEX IF NOT EXISTS lobbies_app ON lobbies (app_id, version)');
	}

	async create(input: LobbyInput): Promise<RegistryResult<{ lobby_id: string; host_token: string }>> {
		const app_id = cleanString(input.app_id, 64);
		const session_id = cleanString(input.session_id, 64);
		if (!app_id || !session_id) return { ok: false, status: 400, error: 'app_id and session_id are required' };

		this.sweep();
		const count = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM lobbies WHERE app_id = ?', app_id).one().n;
		if (count >= MAX_LOBBIES_PER_APP) return { ok: false, status: 429, error: 'too many lobbies' };

		const max_players = clampInt(input.max_players, 1, MAX_PLAYERS_LIMIT, 4);
		const lobby_id = crypto.randomUUID();
		const host_token = crypto.randomUUID();
		// A host re-publishing the same session replaces its old entry.
		this.sql.exec('DELETE FROM lobbies WHERE app_id = ? AND session_id = ?', app_id, session_id);
		this.sql.exec(
			'INSERT INTO lobbies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
			lobby_id,
			app_id,
			session_id,
			cleanString(input.name, MAX_NAME_LENGTH) || 'Lobby',
			clampInt(input.cur_players, 1, max_players, 1),
			max_players,
			input.joinable ? 1 : 0,
			cleanString(input.version, 32),
			host_token,
			Date.now(),
		);
		await this.ensureAlarm();
		return { ok: true, value: { lobby_id, host_token } };
	}

	async heartbeat(id: string, token: string, update: LobbyUpdate): Promise<RegistryResult<null>> {
		const row = this.sql.exec<{ max_players: number }>('SELECT max_players FROM lobbies WHERE id = ? AND host_token = ?', id, token).toArray()[0];
		if (!row) return { ok: false, status: 404, error: 'lobby not found' };

		const sets = ['last_seen = ?'];
		const values: (string | number)[] = [Date.now()];
		if (update.cur_players !== undefined) {
			sets.push('cur_players = ?');
			values.push(clampInt(update.cur_players, 1, row.max_players, 1));
		}
		if (update.joinable !== undefined) {
			sets.push('joinable = ?');
			values.push(update.joinable ? 1 : 0);
		}
		if (typeof update.name === 'string' && cleanString(update.name, MAX_NAME_LENGTH)) {
			sets.push('name = ?');
			values.push(cleanString(update.name, MAX_NAME_LENGTH));
		}
		this.sql.exec(`UPDATE lobbies SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
		await this.ensureAlarm();
		return { ok: true, value: null };
	}

	async remove(id: string, token: string): Promise<RegistryResult<null>> {
		const cursor = this.sql.exec('DELETE FROM lobbies WHERE id = ? AND host_token = ?', id, token);
		return cursor.rowsWritten > 0 ? { ok: true, value: null } : { ok: false, status: 404, error: 'lobby not found' };
	}

	async list(app_id: string, version: string): Promise<Lobby[]> {
		return this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT id, session_id, name, cur_players, max_players FROM lobbies
				WHERE app_id = ? AND version = ? AND joinable = 1 AND cur_players < max_players AND last_seen >= ?
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
		this.sql.exec('DELETE FROM lobbies WHERE last_seen < ?', Date.now() - LOBBY_TTL_MS);
	}

	// Keep sweeping only while there are lobbies; an empty registry costs nothing.
	async ensureAlarm() {
		const remaining = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM lobbies').one().n;
		if (remaining > 0 && (await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
		}
	}
}
