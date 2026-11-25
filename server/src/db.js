import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HttpError, clipText } from './util.js';

export const DB_FILENAME = 'relay.sqlite';
export const OFFLINE_AFTER_MS = 60_000;
export const MESSAGE_TEXT_LIMIT = 20_000;
export const DEFAULT_MESSAGE_LIMIT = 100;
export const MAX_MESSAGE_LIMIT = 500;
export const SESSION_TITLE_LIMIT = 300;

export const MESSAGE_ROLES = new Set(['user', 'assistant']);
export const PLATFORMS = new Set(['macos', 'windows', 'ios']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline'
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  latest_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id TEXT UNIQUE NOT NULL,
  session_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_sessions_device_updated ON sessions(device_id, updated_at DESC);
`;

/**
 * Online/offline is derived from last_seen_at, never trusted from the column:
 * a process that dies cannot mark itself offline, so readers must compute it.
 * @param {string | null | undefined} lastSeenAt
 * @param {number} [nowMs]
 * @returns {'online' | 'offline'}
 */
export function deviceStatus(lastSeenAt, nowMs = Date.now()) {
  if (typeof lastSeenAt !== 'string') return 'offline';
  const seen = Date.parse(lastSeenAt);
  if (!Number.isFinite(seen)) return 'offline';
  return nowMs - seen > OFFLINE_AFTER_MS ? 'offline' : 'online';
}

/**
 * Open (and migrate) relay.sqlite in the relay data directory.
 * @param {{dataDir: string, now?: () => Date | string | number}} options
 * @returns {RelayDb}
 */
export function openDatabase(options) {
  return new RelayDb(options);
}

/**
 * Coerce a value to an ISO8601 UTC string, falling back to the given time.
 * @param {unknown} value
 * @param {string} fallback
 */
export function normalizeIso(value, fallback) {
  if (typeof value === 'string') {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  return fallback;
}

/** @param {string} value */
function emptyToNull(value) {
  return typeof value === 'string' ? value : null;
}

/**
 * SQLite-backed cross-device store.
 *
 * Durability contract: WAL mode plus one transaction per mutation. The relay is
 * single-process by design (as is the JSON store), so DatabaseSync's synchronous
 * API is enough and keeps request ordering deterministic.
 */
export class RelayDb {
  /**
   * @param {{dataDir: string, now?: () => Date | string | number}} options
   */
  constructor(options) {
    this.dataDir = options.dataDir;
    this.file = join(options.dataDir, DB_FILENAME);
    this.clock = options.now ?? (() => new Date());
    this.closed = false;

    mkdirSync(this.dataDir, { recursive: true });
    this.database = new DatabaseSync(this.file, { timeout: 5000 });
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA synchronous = NORMAL');
    this.database.exec(SCHEMA);

    this.statements = {
      upsertDevice: this.database.prepare(`
        INSERT INTO devices (device_id, device_name, platform, last_seen_at, status)
        VALUES (?, ?, ?, ?, 'online')
        ON CONFLICT(device_id) DO UPDATE SET
          device_name = excluded.device_name,
          platform = excluded.platform,
          last_seen_at = excluded.last_seen_at,
          status = 'online'
      `),
      getDevice: this.database.prepare('SELECT * FROM devices WHERE device_id = ?'),
      listDevices: this.database.prepare('SELECT * FROM devices ORDER BY device_name ASC, device_id ASC'),
      upsertSession: this.database.prepare(`
        INSERT INTO sessions (session_id, device_id, title, latest_seq, updated_at)
        VALUES (?, ?, ?, 0, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          device_id = excluded.device_id,
          title = excluded.title,
          updated_at = CASE
            WHEN sessions.updated_at IS NULL THEN excluded.updated_at
            WHEN excluded.updated_at IS NULL THEN sessions.updated_at
            WHEN excluded.updated_at > sessions.updated_at THEN excluded.updated_at
            ELSE sessions.updated_at
          END
      `),
      getSession: this.database.prepare('SELECT * FROM sessions WHERE session_id = ?'),
      ensureSession: this.database.prepare(`
        INSERT INTO sessions (session_id, device_id, title, latest_seq, updated_at)
        VALUES (?, ?, '', 0, ?)
        ON CONFLICT(session_id) DO NOTHING
      `),
      listDeviceSessions: this.database.prepare(`
        SELECT session_id, title, latest_seq, updated_at
        FROM sessions
        WHERE device_id = ?
        ORDER BY updated_at DESC, session_id ASC
      `),
      // 先查存在性:INSERT OR IGNORE 仍会消耗 AUTOINCREMENT 计数,导致 seq 跳号。
      messageExists: this.database.prepare('SELECT 1 AS present FROM messages WHERE msg_id = ?'),
      insertMessage: this.database.prepare(`
        INSERT OR IGNORE INTO messages (msg_id, session_id, device_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      latestMessageSeq: this.database.prepare(
        'SELECT COALESCE(MAX(seq), 0) AS latest FROM messages WHERE session_id = ?',
      ),
      updateSessionAfterMessages: this.database.prepare(
        'UPDATE sessions SET latest_seq = ?, updated_at = ? WHERE session_id = ?',
      ),
      listMessages: this.database.prepare(`
        SELECT seq, msg_id, device_id, role, content, created_at
        FROM messages
        WHERE session_id = ? AND seq > ?
        ORDER BY seq ASC
        LIMIT ?
      `),
    };
  }

  /** @returns {Date} */
  #date() {
    const value = typeof this.clock === 'function' ? this.clock() : this.clock;
    const date = value instanceof Date ? value : new Date(value ?? Date.now());
    return Number.isFinite(date.getTime()) ? date : new Date();
  }

  /** @returns {string} */
  nowIso() {
    return this.#date().toISOString();
  }

  /** @param {{deviceId: string, deviceName: string, platform: string}} input */
  upsertDevice(input) {
    const lastSeenAt = this.nowIso();
    this.statements.upsertDevice.run(input.deviceId, input.deviceName, input.platform, lastSeenAt);
    return this.getDevice(input.deviceId);
  }

  /** @param {string} deviceId */
  getDevice(deviceId) {
    const row = this.statements.getDevice.get(deviceId);
    return row ? publicDevice(row, this.#date().getTime()) : null;
  }

  listDevices() {
    const nowMs = this.#date().getTime();
    return this.statements.listDevices.all().map((row) => publicDevice(row, nowMs));
  }

  /**
   * Upsert session metadata. Replaying the same batch is a no-op apart from
   * touching the same rows; latest_seq is never lowered.
   * @param {{deviceId: string, sessions: Array<{session_id: string, title?: string, updated_at?: string}>}} input
   */
  syncSessions(input) {
    const now = this.nowIso();
    const accepted = [];
    const seen = new Set();

    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const session of input.sessions) {
        const sessionId = session.session_id;
        const title = clipText(typeof session.title === 'string' ? session.title : '', SESSION_TITLE_LIMIT);
        const updatedAt = normalizeIso(session.updated_at, now);
        this.statements.upsertSession.run(sessionId, input.deviceId, title, updatedAt);
        if (!seen.has(sessionId)) {
          seen.add(sessionId);
          accepted.push(sessionId);
        }
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    return { accepted, updated: accepted.length };
  }

  /** @param {string} sessionId */
  getSession(sessionId) {
    const row = this.statements.getSession.get(sessionId);
    return row ? publicSession(row) : null;
  }

  /**
   * Insert messages with msg_id idempotency. A duplicate msg_id is reported and
   * consumes no sequence number, so the global AUTOINCREMENT stream has no gaps
   * caused by retries.
   * @param {{sessionId: string, deviceId: string, messages: Array<{msg_id: string, role: string, content: string, created_at?: string}>}} input
   */
  insertMessages(input) {
    const now = this.nowIso();
    const inserted = [];
    const duplicates = [];

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.statements.ensureSession.run(input.sessionId, input.deviceId, now);

      for (const message of input.messages) {
        const createdAt = normalizeIso(message.created_at, now);
        // 重复消息不能消耗 seq:先查,命中就直接记为重复。
        if (this.statements.messageExists.get(message.msg_id)) {
          duplicates.push(message.msg_id);
          continue;
        }
        const result = this.statements.insertMessage.run(
          message.msg_id,
          input.sessionId,
          input.deviceId,
          message.role,
          message.content,
          createdAt,
        );
        if (Number(result.changes) === 0) {
          duplicates.push(message.msg_id);
          continue;
        }
        inserted.push({
          msg_id: message.msg_id,
          seq: Number(result.lastInsertRowid),
          role: message.role,
          created_at: createdAt,
        });
      }

      if (inserted.length > 0) {
        const latest = Number(this.statements.latestMessageSeq.get(input.sessionId)?.latest ?? 0);
        this.statements.updateSessionAfterMessages.run(latest, now, input.sessionId);
      }

      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    const session = this.getSession(input.sessionId);
    return {
      inserted,
      duplicates,
      latest_seq: session ? Number(session.latest_seq) : 0,
      updated_at: session?.updated_at ?? now,
    };
  }

  /**
   * @param {{sessionId: string, sinceSeq?: number, limit?: number}} input
   */
  listMessages(input) {
    const session = this.getSession(input.sessionId);
    if (!session) throw new HttpError(404, 'session_not_found');

    const sinceSeq = input.sinceSeq ?? 0;
    const limit = input.limit ?? DEFAULT_MESSAGE_LIMIT;
    // Fetch one extra row to answer has_more without a second COUNT query.
    const rows = this.statements.listMessages.all(input.sessionId, sinceSeq, limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const latest = Math.max(Number(session.latest_seq), Number(this.statements.latestMessageSeq.get(input.sessionId)?.latest ?? 0));

    return {
      session_id: input.sessionId,
      latest_seq: latest,
      messages: page.map(publicMessage),
      has_more: hasMore,
    };
  }

  /**
   * Devices (name ascending) with each device's sessions (updated_at descending).
   * Status is recomputed here so a stale 'online' row cannot leak out.
   */
  sidebar() {
    const nowMs = this.#date().getTime();
    return this.statements.listDevices.all().map((row) => ({
      ...publicDevice(row, nowMs),
      sessions: this.statements.listDeviceSessions.all(row.device_id).map(publicSession),
    }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}

/** @param {{device_id: string, device_name: string | null, platform: string | null, last_seen_at: string | null, status: string | null}} row */
function publicDevice(row, nowMs) {
  return {
    device_id: row.device_id,
    device_name: emptyToNull(row.device_name),
    platform: emptyToNull(row.platform),
    last_seen_at: emptyToNull(row.last_seen_at),
    status: deviceStatus(row.last_seen_at, nowMs),
  };
}

/** @param {{session_id: string, title: string | null, latest_seq: number | null, updated_at: string | null}} row */
function publicSession(row) {
  return {
    session_id: row.session_id,
    // device_id 必须暴露:WS 的 session_updated 事件要带它,前面遗漏导致字段被
    // JSON.stringify 直接丢掉,客户端无法判断事件来自哪台设备。
    device_id: row.device_id ?? null,
    title: row.title ?? '',
    latest_seq: Number(row.latest_seq ?? 0),
    updated_at: row.updated_at ?? null,
  };
}

/** @param {{seq: number, msg_id: string, device_id: string | null, role: string | null, content: string | null, created_at: string | null}} row */
function publicMessage(row) {
  return {
    seq: Number(row.seq),
    msg_id: row.msg_id,
    device_id: row.device_id,
    role: row.role,
    content: row.content ?? '',
    created_at: row.created_at,
  };
}
