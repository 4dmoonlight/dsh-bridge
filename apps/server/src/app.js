import { createServer } from 'node:http';
import { Store } from './store.js';
import { EventHub } from './events.js';
import { HubHub } from './hub.js';
import { summaryOf } from './model.js';
import { openDatabase } from './db.js';
import { WebSocketHub } from './ws.js';
import { createApiV1 } from './api-v1.js';
import { HttpError, PROTOCOL, nowIso, readJson, safeEqual, sendEmpty, sendJson } from './util.js';

export const VERSION = '0.1.0';

/**
 * @param {{
 *   dataDir: string,
 *   instanceToken: string,
 *   logger?: {info: Function, error: Function},
 *   bodyLimitBytes?: number,
 *   commandTimeoutMs?: number,
 *   db?: import('./db.js').HubDb,
 *   now?: () => Date | string | number,
 *   wsPingIntervalMs?: number,
 *   wsPongTimeoutMs?: number,
 * }} options
 */
export async function createHubApp(options) {
  const bodyLimit = options.bodyLimitBytes ?? 16 * 1024 * 1024;
  const logger = options.logger ?? console;
  const store = await new Store({ dataDir: options.dataDir }).load();
  const events = new EventHub();
  const hub = new HubHub({ commandTimeoutMs: options.commandTimeoutMs ?? 10000 });
  // The SQLite store and WebSocket hub are created here by default so tests and
  // the CLI share one wiring path; index.js may pass its own db for startup
  // logging. The hub owns only in-memory state.
  const db = options.db ?? openDatabase({ dataDir: options.dataDir, now: options.now });
  const ws = new WebSocketHub({
    logger,
    pingIntervalMs: options.wsPingIntervalMs,
    pongTimeoutMs: options.wsPongTimeoutMs,
  });
  const api = createApiV1({ db, ws, instanceToken: options.instanceToken, bodyLimit });
  const startedAt = Date.now();
  let closed = false;

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => fail(res, error, logger));
  });
  server.on('upgrade', (req, socket, head) => {
    try {
      api.handleUpgrade(req, socket, head);
    } catch (error) {
      logger.error?.(error);
      socket.destroy();
    }
  });

  /** @param {import('node:http').IncomingMessage} req */
  function tokenOf(req) {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
    const url = new URL(req.url ?? '/', 'http://hub.local');
    return url.searchParams.get('token') ?? '';
  }

  /** @param {import('node:http').IncomingMessage} req */
  function requireInstance(req) {
    const token = tokenOf(req);
    if (!token || !safeEqual(token, options.instanceToken)) {
      throw new HttpError(401, 'unauthorized', 'instance token required');
    }
    return { kind: 'instance' };
  }

  /** @param {import('node:http').IncomingMessage} req */
  function requireDevice(req) {
    const device = store.findDeviceByToken(tokenOf(req));
    if (!device) throw new HttpError(401, 'unauthorized', 'device token required');
    return device;
  }

  /** @param {import('node:http').IncomingMessage} req */
  function authorizeClient(req) {
    const token = tokenOf(req);
    if (token && safeEqual(token, options.instanceToken)) return { kind: 'instance', deviceId: null };
    const device = store.findDeviceByToken(token);
    if (device) return { kind: 'device', deviceId: device.id };
    throw new HttpError(401, 'unauthorized');
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://hub.local');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    // HTTP requires HEAD to behave like GET without a body. Node already marks the
    // response bodyless for HEAD requests, so mapping the method is enough — and it
    // keeps health checks that use `curl -I` from seeing a spurious 404.
    const method = req.method === 'HEAD' ? 'GET' : (req.method ?? 'GET');

    if (method === 'OPTIONS') {
      return sendEmpty(res, 204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
      });
    }

    if (path === '/api/v1' || path.startsWith('/api/v1/')) {
      const handled = await api.handle(req, res, { url, path, method });
      if (handled) return;
    }

    if (method === 'GET' && path === '/healthz') {
      return sendJson(res, 200, {
        ok: true,
        protocol: PROTOCOL,
        version: VERSION,
        serverTime: nowIso(),
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        devices: store.listDevices().length,
        sessions: Object.keys(store.state.sessions).length,
      });
    }

    if (method === 'GET' && path === '/v1/meta') {
      return sendJson(res, 200, {
        protocol: PROTOCOL,
        version: VERSION,
        capabilities: {
          sessionSync: true,
          fullSync: true,
          sse: true,
          hostCommands: true,
          hubFallback: 'stored',
        },
      });
    }

    if (method === 'POST' && path === '/v1/devices/register') {
      requireInstance(req);
      const body = await readJson(req, bodyLimit);
      const { device, token, rotated } = await store.registerDevice(body ?? {});
      events.publish('device.updated', { device: { ...device, online: true } });
      return sendJson(res, 201, { protocol: PROTOCOL, device, token, rotated });
    }

    if (method === 'GET' && path === '/v1/devices') {
      requireInstance(req);
      const devices = store.listDevices().map((device) => ({ ...device, online: hub.isOnline(device.id) }));
      return sendJson(res, 200, { devices });
    }

    if (method === 'PUT' && path === '/v1/devices/self') {
      const device = requireDevice(req);
      const body = await readJson(req, bodyLimit).catch(() => null);
      if (body && typeof body === 'object' && body.capabilities && typeof body.capabilities === 'object') {
        device.capabilities = body.capabilities;
      }
      hub.markSeen(device.id);
      store.touchDevice(device.id);
      return sendEmpty(res, 204);
    }

    if (method === 'POST' && path === '/v1/sessions/sync') {
      const device = requireDevice(req);
      const body = await readJson(req, bodyLimit);
      if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid_body');
      if (body.protocol && body.protocol !== PROTOCOL) {
        throw new HttpError(400, 'protocol_mismatch', `expected ${PROTOCOL}`);
      }
      const result = await store.syncSessions({
        deviceId: device.id,
        sessions: body.sessions ?? [],
        deleted: body.deleted ?? [],
        full: body.full === true,
      });
      for (const id of result.accepted) {
        events.publish('session.updated', { session: summaryOf(store.getSession(id)), deviceId: device.id });
      }
      for (const id of result.removed) {
        events.publish('session.deleted', { id, deviceId: device.id });
      }
      if (result.accepted.length || result.removed.length) {
        events.publish('device.updated', {
          device: { ...store.listDevices().find((d) => d.id === device.id), online: true },
        });
      }
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (method === 'GET' && path === '/v1/sessions') {
      const auth = authorizeClient(req);
      const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
      const cursor = clampInt(url.searchParams.get('cursor'), 0, 0, Number.MAX_SAFE_INTEGER);
      const deviceId = auth.kind === 'device' ? auth.deviceId : url.searchParams.get('device') ?? undefined;
      const page = store.listSessions({ deviceId, query: url.searchParams.get('q') ?? undefined, limit, cursor });
      return sendJson(res, 200, { protocol: PROTOCOL, ...page });
    }

    const sessionMatch = /^\/v1\/sessions\/([^/]+)$/.exec(path);
    if (sessionMatch && method === 'GET') {
      authorizeClient(req);
      const session = store.getSession(decodeURIComponent(sessionMatch[1]));
      if (!session) throw new HttpError(404, 'session_not_found');
      return sendJson(res, 200, { protocol: PROTOCOL, session });
    }

    if (sessionMatch && method === 'DELETE') {
      const auth = authorizeClient(req);
      const id = decodeURIComponent(sessionMatch[1]);
      const owner = store.getSession(id);
      if (owner && auth.kind === 'device' && owner.deviceId !== auth.deviceId) {
        throw new HttpError(403, 'forbidden');
      }
      const deleted = await store.deleteSession(id);
      if (!deleted) throw new HttpError(404, 'session_not_found');
      events.publish('session.deleted', { id, deviceId: owner?.deviceId ?? null });
      return sendEmpty(res, 204);
    }

    if (method === 'GET' && path === '/v1/events') {
      const auth = authorizeClient(req);
      const deviceId = auth.kind === 'device' ? auth.deviceId : null;
      events.subscribe(res, { deviceId: null });
      events.publish('ready', { ok: true, at: nowIso() }, { deviceId });
      return;
    }

    if (method === 'GET' && path === '/v1/host/commands') {
      const device = requireDevice(req);
      // `wait` is seconds (protocol: clamped 0-55 s), not milliseconds. Reading it
      // as ms made a 20 s poll expire after 20 ms, so the host was almost never
      // parked and live dispatch kept answering 409 host_offline.
      const waitSeconds = clampInt(url.searchParams.get('wait'), 25, 0, 55);
      // Withdraw the poll as soon as the host's connection drops, so a dead host
      // reports host_offline (and falls back to stored) instead of swallowing a
      // dispatched command and returning host_timeout.
      const withdrawn = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) withdrawn.abort();
      };
      res.on('close', onClose);
      let result;
      try {
        result = await hub.park(device.id, waitSeconds * 1000, withdrawn.signal);
      } finally {
        res.off('close', onClose);
      }
      if (!result) return sendEmpty(res, 204);
      return sendJson(res, 200, { command: result.command });
    }

    const commandResultMatch = /^\/v1\/host\/commands\/([^/]+)\/result$/.exec(path);
    if (commandResultMatch && method === 'POST') {
      const device = requireDevice(req);
      const body = await readJson(req, bodyLimit);
      if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean') {
        throw new HttpError(400, 'invalid_body', 'ok boolean required');
      }
      hub.complete(decodeURIComponent(commandResultMatch[1]), device.id, {
        ok: body.ok,
        result: body.result,
        error: body.error,
      });
      return sendEmpty(res, 204);
    }

    const hubMatch = /^\/v1\/hub\/sessions\/([^/]+)(\/fetch)?$/.exec(path);
    if (hubMatch && method === 'POST') {
      requireInstance(req);
      const sessionId = decodeURIComponent(hubMatch[1]);
      const body = (await readJson(req, bodyLimit).catch(() => null)) ?? {};
      const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
      if (!deviceId) throw new HttpError(400, 'device_id_required');
      const stored = store.getSession(sessionId);

      if (!hub.hasPoll(deviceId)) {
        if (stored && body.fallback === 'stored') return sendJson(res, 200, { source: 'stored', session: stored });
        throw new HttpError(409, 'host_offline', `device ${deviceId} is not connected`);
      }
      const timeoutMs = clampInt(body.timeoutMs, 8000, 500, 30000);
      let payload;
      try {
        payload = await hub.dispatch(deviceId, 'session.fetch', { sessionId }, timeoutMs);
      } catch (error) {
        // Behind a proxy (a Cloudflare tunnel, say) the hub never sees the host's
        // socket close, so a dead host keeps its parked poll until the wait elapses.
        // For a caller that asked for the stored copy, a host that does not answer is
        // as good as an offline one — better than surfacing a timeout.
        if (stored && body.fallback === 'stored' && error instanceof HttpError && error.code === 'host_timeout') {
          return sendJson(res, 200, { source: 'stored', session: stored });
        }
        throw error;
      }
      const ok = /** @type {any} */ (payload).ok;
      if (!ok) {
        const error = /** @type {any} */ (payload).error;
        throw new HttpError(502, error?.code ?? 'host_error', error?.message ?? 'host failed to fetch session', {
          deviceId,
        });
      }
      return sendJson(res, 200, { source: 'live', session: /** @type {any} */ (payload).result?.session ?? null });
    }

    throw new HttpError(404, 'not_found', `${method} ${path}`);
  }

  return {
    server,
    store,
    events,
    hub,
    db,
    ws,
    version: VERSION,
    async listen(port = 8787, host = '127.0.0.1') {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(undefined);
        });
      });
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      return { port: actualPort, url: `http://${host}:${actualPort}` };
    },
    async close() {
      if (closed) return;
      closed = true;
      events.closeAll();
      hub.close();
      // Close upgraded sockets first: server.close() waits for connections it
      // knows about, but WebSocket tunnels are not tracked by the HTTP server.
      ws.close();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      db.close();
    },
  };
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} error
 * @param {{error: Function}} logger
 */
function fail(res, error, logger) {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof HttpError) {
    return sendJson(res, error.status, { error: { code: error.code, message: error.message, details: error.details } });
  }
  logger.error?.(error);
  return sendJson(res, 500, { error: { code: 'internal_error' } });
}
