import { chmodSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes, randomInt } from 'node:crypto';

/** token 只以 sha256 摘要形式落库。 */
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HttpError, clipText } from './util.js';

export const DB_FILENAME = 'bridge.sqlite';
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
-- 每台设备自己的凭据:token 只存 sha256 摘要,泄漏数据库也拿不到可用 token。
CREATE TABLE IF NOT EXISTS device_tokens (
  token_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_device ON device_tokens(device_id);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
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
 * Open (and migrate) bridge.sqlite in the hub data directory.
 * @param {{dataDir: string, now?: () => Date | string | number}} options
 * @returns {HubDb}
 */
export function openDatabase(options) {
  return new HubDb(options);
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
 * Durability contract: WAL mode plus one transaction per mutation. The hub is
 * single-process by design (as is the JSON store), so DatabaseSync's synchronous
 * API is enough and keeps request ordering deterministic.
 */
export class HubDb {
  /**
   * @param {{dataDir: string, now?: () => Date | string | number}} options
   */
  constructor(options) {
    this.dataDir = options.dataDir;
    this.file = join(options.dataDir, DB_FILENAME);
    this.clock = options.now ?? (() => new Date());
    this.closed = false;

    // 数据目录只给服务用户:里面是明文会话内容,同机其他用户不该读到。
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(this.file, { timeout: 5000 });
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* 文件系统不支持时忽略 */
    }
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
          title = excluded.title,
          updated_at = CASE
            WHEN sessions.updated_at IS NULL THEN excluded.updated_at
            WHEN excluded.updated_at IS NULL THEN sessions.updated_at
            WHEN excluded.updated_at > sessions.updated_at THEN excluded.updated_at
            ELSE sessions.updated_at
          END
        -- 归属不可被覆盖:否则 B 用自己合法的凭据提交 A 的 session_id 就能抢走会话。
        -- 条件不成立时 changes=0,由 syncSessions 记为 rejected。
        WHERE sessions.device_id = excluded.device_id
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
      insertDeviceToken: this.database.prepare(
        'INSERT INTO device_tokens (token_hash, device_id, scopes, created_at) VALUES (?, ?, ?, ?)',
      ),
      getDeviceToken: this.database.prepare('SELECT * FROM device_tokens WHERE token_hash = ?'),
      touchDeviceToken: this.database.prepare('UPDATE device_tokens SET last_used_at = ? WHERE token_hash = ?'),
      revokeDeviceToken: this.database.prepare(
        'UPDATE device_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
      ),
      listDeviceTokens: this.database.prepare(
        'SELECT device_id, scopes, created_at, last_used_at, revoked_at FROM device_tokens ORDER BY created_at DESC',
      ),
      insertPairing: this.database.prepare(
        'INSERT INTO pairing_codes (code, created_at, expires_at, used_at) VALUES (?, ?, ?, NULL)',
      ),
      getPairing: this.database.prepare('SELECT * FROM pairing_codes WHERE code = ?'),
      consumePairing: this.database.prepare(
        'UPDATE pairing_codes SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?',
      ),
      purgePairings: this.database.prepare('DELETE FROM pairing_codes WHERE expires_at <= ?'),
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
    const rejected = [];
    const seen = new Set();

    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const session of input.sessions) {
        const sessionId = session.session_id;
        const title = clipText(typeof session.title === 'string' ? session.title : '', SESSION_TITLE_LIMIT);
        const updatedAt = normalizeIso(session.updated_at, now);
        const result = this.statements.upsertSession.run(sessionId, input.deviceId, title, updatedAt);
        if (Number(result.changes) === 0) {
          // 会话已存在且属于别的设备,拒绝而不是静默覆盖。
          if (!rejected.includes(sessionId)) rejected.push(sessionId);
          continue;
        }
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

    return { accepted, updated: accepted.length, rejected };
  }

  /** @param {string} sessionId */
  getSession(sessionId) {
    const row = this.statements.getSession.get(sessionId);
    return row ? publicSession(row) : null;
  }

  /**
   * 给一台设备发放独立凭据。只在这里返回明文,库里永远只有摘要。
   * @param {string} deviceId
   * @param {string} scopes 逗号分隔,如 'read:all,write:self'
   * @returns {{ token: string, token_hash: string }}
   */
  createDeviceToken(deviceId, scopes) {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    this.statements.insertDeviceToken.run(tokenHash, deviceId, scopes, new Date().toISOString());
    return { token, token_hash: tokenHash };
  }

  /**
   * 按明文 token 查凭据。未吊销才返回。
   * @param {string} token
   * @returns {{ device_id: string, scopes: string } | null}
   */
  findDeviceToken(token) {
    const tokenHash = hashToken(token);
    const row = this.statements.getDeviceToken.get(tokenHash);
    if (!row || row.revoked_at) return null;
    this.statements.touchDeviceToken.run(new Date().toISOString(), tokenHash);
    return { device_id: row.device_id, scopes: row.scopes };
  }

  /** @param {string} token */
  revokeDeviceToken(token) {
    return Number(this.statements.revokeDeviceToken.run(new Date().toISOString(), hashToken(token)).changes) === 1;
  }

  listDeviceTokens() {
    return this.statements.listDeviceTokens.all();
  }

  /**
   * 生成一次性配对码。码本身即凭据:短时效、单次使用,由已认证设备发起。
   * @param {number} ttlMs
   * @returns {{ code: string, expires_at: string }}
   */
  createPairingCode(ttlMs) {
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + ttlMs).toISOString();
    this.statements.purgePairings.run(createdAt);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      try {
        this.statements.insertPairing.run(code, createdAt, expiresAt);
        return { code, expires_at: expiresAt };
      } catch {
        /* 撞码,重试 */
      }
    }
    throw new HttpError(500, 'pairing_code_failed', 'could not allocate a pairing code');
  }

  /**
   * 认领配对码。单次成功,过期或已用返回 null。
   * @param {string} code
   * @returns {boolean}
   */
  claimPairingCode(code) {
    const nowIso = new Date().toISOString();
    const result = this.statements.consumePairing.run(nowIso, code, nowIso);
    return Number(result.changes) === 1;
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
