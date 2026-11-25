import {
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  MESSAGE_ROLES,
  MESSAGE_TEXT_LIMIT,
  PLATFORMS,
} from './db.js';
import { HttpError, PROTOCOL, clipText, isIsoDate, readJson, safeEqual, sendJson } from './util.js';
import { WS_PATH, rejectUpgrade } from './ws.js';

const MAX_ID_LENGTH = 200;

/**
 * Build the /api/v1 request handlers. These endpoints are additive: the legacy
 * /v1 routes keep their original behaviour and share the same instance token.
 *
 * @param {{
 *   db: import('./db.js').RelayDb,
 *   ws: import('./ws.js').WebSocketHub,
 *   instanceToken: string,
 *   bodyLimit?: number,
 * }} options
 */
/** 配对码有效期:10 分钟。 */
const PAIRING_TTL_MS = 10 * 60 * 1000;
/** 认领接口限流:每分钟最多 12 次,防止暴力猜 6 位码。 */
const CLAIM_LIMIT_PER_MINUTE = 12;

export function createApiV1(options) {
  const { db, ws, instanceToken } = options;
  const bodyLimit = options.bodyLimit ?? 16 * 1024 * 1024;

  // 滑动窗口限流:只记最近一分钟的认领尝试。
  let claimAttempts = [];

  function claimAllowed() {
    const now = Date.now();
    claimAttempts = claimAttempts.filter((t) => now - t < 60_000);
    if (claimAttempts.length >= CLAIM_LIMIT_PER_MINUTE) return false;
    claimAttempts.push(now);
    return true;
  }

  /** @param {import('node:http').IncomingMessage} req @param {URL} url */
  function tokenOf(req, url) {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
    // Browsers cannot set an Authorization header on a WebSocket handshake, so
    // the same token may be supplied as a query parameter.
    return url.searchParams.get('token') ?? '';
  }

  /**
   * REST 请求只认 Authorization 头。query 参数形式仅保留给 WebSocket 握手(浏览器
   * 无法在握手时设置自定义头),否则 token 会出现在 URL、代理日志与浏览器历史里。
   * @param {import('node:http').IncomingMessage} req
   */
  function requireToken(req) {
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token || !safeEqual(token, instanceToken)) {
      throw new HttpError(401, 'unauthorized', 'instance token required');
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {{url: URL, path: string, method: string}} route
   * @returns {Promise<boolean>}
   */
  async function handle(req, res, route) {
    const { url, path, method } = route;
    if (path !== '/api/v1' && !path.startsWith('/api/v1/')) return false;

    // 配对认领必须免鉴权:新设备此刻还没有任何凭据。配对码本身即一次性凭据。
    if (method === 'POST' && path === '/api/v1/pairing/claim') {
      const body = await readBody(req);
      const code = requiredString(body.code, 'code', 16);
      if (!/^[0-9]{6}$/.test(code)) {
        throw new HttpError(400, 'invalid_code', 'pairing code must be 6 digits');
      }
      if (!claimAllowed()) {
        throw new HttpError(429, 'rate_limited', 'too many pairing attempts, wait a minute');
      }
      if (!db.claimPairingCode(code)) {
        throw new HttpError(404, 'pairing_code_invalid', 'code is wrong, used, or expired');
      }
      sendJson(res, 200, { protocol: PROTOCOL, token: instanceToken });
      return true;
    }

    // Authenticate before routing so unauthenticated probes cannot tell which
    // /api/v1 paths exist.
    requireToken(req);

    if (method === 'POST' && path === '/api/v1/pairing/code') {
      const payload = db.createPairingCode(PAIRING_TTL_MS);
      sendJson(res, 200, { code: payload.code, expires_at: payload.expires_at, ttl_seconds: Math.floor(PAIRING_TTL_MS / 1000) });
      return true;
    }

    if (method === 'POST' && path === '/api/v1/devices/heartbeat') {
      const body = await readBody(req);
      const deviceId = requiredString(body.device_id, 'device_id', MAX_ID_LENGTH);
      const deviceName = requiredString(body.device_name, 'device_name', MAX_ID_LENGTH);
      const platform = requiredString(body.platform, 'platform', 20);
      if (!PLATFORMS.has(platform)) {
        throw new HttpError(400, 'invalid_platform', `platform must be one of ${[...PLATFORMS].join(', ')}`);
      }

      const device = db.upsertDevice({ deviceId, deviceName, platform });
      ws.broadcast({
        type: 'device_updated',
        device_id: device.device_id,
        status: device.status,
        last_seen_at: device.last_seen_at,
      });
      sendJson(res, 200, { device });
      return true;
    }

    if (method === 'POST' && path === '/api/v1/sessions/sync') {
      const body = await readBody(req);
      const deviceId = requiredString(body.device_id, 'device_id', MAX_ID_LENGTH);
      if (!Array.isArray(body.sessions)) throw new HttpError(400, 'invalid_sessions', 'sessions array required');

      const sessions = body.sessions.map((session, index) => {
        if (!session || typeof session !== 'object' || Array.isArray(session)) {
          throw new HttpError(400, 'invalid_session', `sessions[${index}] must be an object`);
        }
        const sessionId = requiredString(session.session_id, 'session_id', MAX_ID_LENGTH);
        if (session.title !== undefined && typeof session.title !== 'string') {
          throw new HttpError(400, 'invalid_title', `sessions[${index}].title must be a string`);
        }
        if (session.updated_at !== undefined && !isIsoDate(session.updated_at)) {
          throw new HttpError(400, 'invalid_updated_at', `sessions[${index}].updated_at must be ISO8601`);
        }
        return { session_id: sessionId, title: session.title ?? '', updated_at: session.updated_at };
      });

      const result = db.syncSessions({ deviceId, sessions });
      for (const sessionId of result.accepted) {
        const session = db.getSession(sessionId);
        if (!session) continue;
        ws.broadcast({
          type: 'session_updated',
          device_id: session.device_id,
          session_id: session.session_id,
          latest_seq: session.latest_seq,
          updated_at: session.updated_at,
        });
      }
      sendJson(res, 200, result);
      return true;
    }

    const messagesMatch = /^\/api\/v1\/sessions\/([^/]+)\/messages$/.exec(path);
    if (messagesMatch && method === 'POST') {
      const sessionId = decodeSessionId(messagesMatch[1]);
      const body = await readBody(req);
      const deviceId = requiredString(body.device_id, 'device_id', MAX_ID_LENGTH);
      if (!Array.isArray(body.messages)) throw new HttpError(400, 'invalid_messages', 'messages array required');

      // 会话必须先由 sessions/sync 建立;否则任意拼一个 session_id 都能凭空造出会话。
      if (!db.getSession(sessionId)) {
        throw new HttpError(404, 'session_not_found', `session ${sessionId} is unknown`);
      }

      const messages = body.messages.map((message, index) => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          throw new HttpError(400, 'invalid_message', `messages[${index}] must be an object`);
        }
        if (!MESSAGE_ROLES.has(message.role)) {
          throw new HttpError(400, 'invalid_role', `messages[${index}].role must be user or assistant`);
        }
        if (typeof message.content !== 'string') {
          throw new HttpError(400, 'invalid_content', `messages[${index}].content must be a string`);
        }
        if (message.created_at !== undefined && !isIsoDate(message.created_at)) {
          throw new HttpError(400, 'invalid_created_at', `messages[${index}].created_at must be ISO8601`);
        }
        return {
          msg_id: requiredString(message.msg_id, 'msg_id', MAX_ID_LENGTH),
          role: message.role,
          content: clipText(message.content, MESSAGE_TEXT_LIMIT),
          created_at: message.created_at,
        };
      });

      const result = db.insertMessages({ sessionId, deviceId, messages });
      const session = db.getSession(sessionId);

      for (const message of result.inserted) {
        ws.broadcast({
          type: 'new_message',
          device_id: deviceId,
          session_id: sessionId,
          seq: message.seq,
          msg_id: message.msg_id,
          role: message.role,
          created_at: message.created_at,
        });
      }
      if (result.inserted.length > 0 && session) {
        ws.broadcast({
          type: 'session_updated',
          device_id: session.device_id,
          session_id: sessionId,
          latest_seq: result.latest_seq,
          updated_at: result.updated_at,
        });
      }

      sendJson(res, 200, {
        inserted: result.inserted.map((message) => ({ msg_id: message.msg_id, seq: message.seq })),
        duplicates: result.duplicates,
        latest_seq: result.latest_seq,
      });
      return true;
    }

    if (messagesMatch && method === 'GET') {
      const sessionId = decodeSessionId(messagesMatch[1]);
      const sinceSeq = integerParam(url.searchParams.get('since_seq'), 0, 'since_seq', 0, Number.MAX_SAFE_INTEGER);
      const limit = integerParam(url.searchParams.get('limit'), DEFAULT_MESSAGE_LIMIT, 'limit', 1, MAX_MESSAGE_LIMIT);
      sendJson(res, 200, db.listMessages({ sessionId, sinceSeq, limit }));
      return true;
    }

    if (method === 'GET' && path === '/api/v1/sidebar') {
      sendJson(res, 200, { devices: db.sidebar() });
      return true;
    }

    throw new HttpError(404, 'not_found', `${method} ${path}`);
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:net').Socket} socket
   * @param {Buffer} head
   * @returns {boolean}
   */
  function handleUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://relay.local');
    } catch {
      rejectUpgrade(socket, 400, 'invalid_request');
      return true;
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path !== WS_PATH) {
      rejectUpgrade(socket, 404, 'not_found', `upgrade path ${path} is not a websocket endpoint`);
      return true;
    }

    let token;
    try {
      token = tokenOf(req, url);
    } catch {
      token = '';
    }
    if (!token || !safeEqual(token, instanceToken)) {
      rejectUpgrade(socket, 401, 'unauthorized', 'instance token required');
      return true;
    }

    const deviceId = (url.searchParams.get('device_id') ?? '').trim();
    if (!deviceId || deviceId.length > MAX_ID_LENGTH) {
      rejectUpgrade(socket, 400, 'invalid_device_id', 'device_id query parameter required');
      return true;
    }

    ws.accept(req, socket, head, { deviceId });
    return true;
  }

  /** @param {import('node:http').IncomingMessage} req */
  async function readBody(req) {
    const body = await readJson(req, bodyLimit);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'invalid_body', 'JSON object body required');
    }
    return body;
  }

  return { handle, handleUpgrade };
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} maxLength
 * @returns {string}
 */
function requiredString(value, name, maxLength) {
  if (typeof value !== 'string') throw new HttpError(400, `invalid_${name}`, `${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new HttpError(400, `invalid_${name}`, `${name} must be 1-${maxLength} characters`);
  }
  return trimmed;
}

/** @param {string} raw */
function decodeSessionId(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'invalid_session_id');
  }
}

/**
 * Parse a query parameter as an integer. Values above max are clamped (the
 * contract caps limit at 500); malformed or below-min values are a 400.
 * @param {string | null} raw
 * @param {number} fallback
 * @param {string} name
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function integerParam(raw, fallback, name, min, max) {
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new HttpError(400, `invalid_${name}`, `${name} must be an integer >= ${min}`);
  }
  return Math.min(value, max);
}
