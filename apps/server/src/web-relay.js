import { HttpError, randomId, readJson, sendJson } from './util.js';
import { bearerOf } from './web-api.js';
import { acceptHandshake, PING_INTERVAL_MS, PONG_TIMEOUT_MS, rejectUpgrade } from './ws.js';
import { MAX_CHUNK_BYTES, RateLimit, RelaySocket } from './web-relay-socket.js';

export const RELAY_PATH = '/api/v1/web/relay';
const MAX_LEASE_TTL = 30 * 60_000;
// Leave room for small clock differences at the target without exceeding its cap.
const DEFAULT_LEASE_TTL = MAX_LEASE_TTL - 60_000;
const MAX_LEASES = 1024;
const HOST_LEASE_LIMIT = 16;
const VIEWER_LEASE_LIMIT = 8;
const HOST_STREAM_LIMIT = 32;
const LEASE_STREAM_LIMIT = 8;
const MAX_SOCKETS = 1024;
const MAX_UNAUTHENTICATED = 64;
const OPEN_WINDOW = 60_000;
const OPEN_LIMIT = 30;
const GLOBAL_OPEN_LIMIT = 512;
const MAX_B64_CHUNK = 4 * Math.ceil(MAX_CHUNK_BYTES / 3);
const BASE64_CHUNK = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/;

function after(ms, fn) {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return timer;
}

function hasKeys(value, ...keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validAuthority(value) {
  if (typeof value !== 'string') return false;
  const match = /^[a-f0-9]{32}\.dsh-relay\.localhost:([1-9][0-9]{0,4})$/.exec(value);
  return match !== null && match[0] === value && Number(match[1]) <= 65535 && Number(match[1]) !== 80;
}

function validGrantHash(value) {
  // A SHA-256 digest has 32 bytes, including the final canonical base64url character.
  return typeof value === 'string' && value.length === 43 && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
}

function newId() {
  return randomId('', 24);
}

function validId(value) {
  return typeof value === 'string' && value.length === 32 && /^[A-Za-z0-9_-]+$/.test(value);
}

/** In-memory rendezvous only: Hub never dials a target or handles plaintext application data. */
export class WebRelay {
  constructor({ db, bodyLimit, leaseTtlMs = DEFAULT_LEASE_TTL, authTimeoutMs = 5000, joinTimeoutMs = 10_000,
    ackTimeoutMs = 30_000, pingIntervalMs = PING_INTERVAL_MS, pongTimeoutMs = PONG_TIMEOUT_MS }) {
    this.db = db;
    this.bodyLimit = Math.min(2048, bodyLimit);
    this.leaseTtlMs = Math.min(leaseTtlMs, MAX_LEASE_TTL);
    this.authTimeoutMs = authTimeoutMs;
    this.joinTimeoutMs = joinTimeoutMs;
    this.ackTimeoutMs = ackTimeoutMs;
    this.pingIntervalMs = pingIntervalMs;
    this.pongTimeoutMs = pongTimeoutMs;
    this.sockets = new Set();
    this.unauthenticated = new Set();
    this.hosts = new Map();
    this.leases = new Map();
    this.pending = new Map();
    this.openAttempts = [];
    this.closed = false;
  }

  #authorize(token) {
    const identity = typeof token === 'string' && token.length <= 256 && this.db.lookupRelayIdentity(token);
    if (!identity) throw new HttpError(401, 'unauthorized');
    if (!identity.subject_hash) throw new HttpError(403, 'google_binding_required');
    return identity;
  }

  async handleHttp(req, res, url) {
    const list = req.method === 'GET' && url.pathname === RELAY_PATH + '/devices';
    const open = req.method === 'POST' && url.pathname === RELAY_PATH + '/open';
    const close = req.method === 'POST' && url.pathname === RELAY_PATH + '/close';
    if (!list && !open && !close) throw new HttpError(404, 'not_found');
    if (url.searchParams.has('token') || url.searchParams.has('access_token')) throw new HttpError(401, 'unauthorized');
    if (this.closed) throw new HttpError(503, 'server_closed');
    const token = bearerOf(req);
    let identity = this.#authorize(token);
    if (list) {
      const devices = this.db.listGoogleDevices(identity.subject_hash, identity.device_id).map((row) => ({
        ...row, web_enabled: Boolean(this.#activeHost(row.device_id, identity.subject_hash)),
      }));
      return sendJson(res, 200, {
        devices, control_ready: Boolean(this.#activeHost(identity.device_id, identity.subject_hash)),
      });
    }
    const body = await readJson(req, this.bodyLimit);
    if (this.closed) throw new HttpError(503, 'server_closed');
    identity = this.#authorize(token);
    if (close) {
      if (!hasKeys(body, 'lease_id') || !validId(body.lease_id)) throw new HttpError(400, 'invalid_body');
      const lease = this.leases.get(body.lease_id);
      if (lease && lease.viewer.device_id === identity.device_id && lease.viewer.subject_hash === identity.subject_hash) {
        this.#closeLease(lease, 'viewer_closed');
      }
      return sendJson(res, 200, { closed: true });
    }
    if (!hasKeys(body, 'device_id', 'authority', 'grant_hash')) throw new HttpError(400, 'invalid_body');
    if (typeof body.device_id !== 'string' || !body.device_id || body.device_id.length > 200) {
      throw new HttpError(400, 'invalid_device_id');
    }
    if (!validAuthority(body.authority)) throw new HttpError(400, 'invalid_authority');
    if (!validGrantHash(body.grant_hash)) throw new HttpError(400, 'invalid_grant_hash');
    return sendJson(res, 200, this.#openLease(identity, body));
  }

  #openLease(viewer, { device_id, authority, grant_hash }) {
    if (device_id === viewer.device_id || this.db.findGoogleSubject(device_id) !== viewer.subject_hash) {
      throw new HttpError(404, 'device_not_found');
    }
    const host = this.#activeHost(device_id, viewer.subject_hash);
    if (!host) throw new HttpError(409, 'web_not_enabled');
    let viewerLeases = 0;
    for (const lease of this.leases.values()) {
      if (this.#liveLease(lease) && lease.viewer.device_id === viewer.device_id) viewerLeases += 1;
    }
    const now = performance.now();
    this.openAttempts = this.openAttempts.filter((attempt) => now - attempt.at < OPEN_WINDOW);
    const viewerOpens = this.openAttempts.filter((attempt) => attempt.viewer === viewer.device_id).length;
    if (viewerLeases >= VIEWER_LEASE_LIMIT || host.leases.size >= HOST_LEASE_LIMIT || this.leases.size >= MAX_LEASES ||
        viewerOpens >= OPEN_LIMIT || this.openAttempts.length >= GLOBAL_OPEN_LIMIT) {
      throw new HttpError(429, 'rate_limited');
    }
    if (this.#activeHost(device_id, viewer.subject_hash) !== host) throw new HttpError(409, 'web_not_enabled');
    this.openAttempts.push({ viewer: viewer.device_id, at: now });
    const lease = {
      id: newId(), host, viewer, authority, grantHash: grant_hash,
      expiresAt: this.db.now() + this.leaseTtlMs,
      deadline: now + this.leaseTtlMs,
      streams: new Set(), starts: new RateLimit(16, 16), closed: false,
    };
    lease.timer = after(this.leaseTtlMs, () => this.#closeLease(lease, 'lease_expired'));
    this.leases.set(lease.id, lease);
    host.leases.add(lease);
    return { lease_id: lease.id, fingerprint: host.fingerprint, expires_at: lease.expiresAt };
  }

  handleUpgrade(req, socket, head) {
    // Match the raw request target, not a URL that can normalize slashes/dot segments.
    if (req.url?.split('?', 1)[0] !== RELAY_PATH) return false;
    if (req.url !== RELAY_PATH) {
      rejectUpgrade(socket, 400, 'invalid_request');
      return true;
    }
    if (req.headers.origin !== undefined) {
      rejectUpgrade(socket, 403, 'origin_forbidden');
      return true;
    }
    if (this.closed) {
      rejectUpgrade(socket, 503, 'server_closed');
      return true;
    }
    if (this.sockets.size >= MAX_SOCKETS || this.unauthenticated.size >= MAX_UNAUTHENTICATED) {
      rejectUpgrade(socket, 429, 'rate_limited');
      return true;
    }
    if (!acceptHandshake(req, socket, { strictKey: true })) return true;
    const conn = new RelaySocket(socket, {
      onMessage: (c, m) => this.#message(c, m),
      onClose: (c) => this.#socketClosed(c),
      onDispose: (c) => this.#socketDisposed(c),
    });
    this.sockets.add(conn);
    this.unauthenticated.add(conn);
    conn.authDeadline = performance.now() + this.authTimeoutMs;
    conn.authTimer = after(this.authTimeoutMs, () => conn.close(1008, 'auth_timeout'));
    if (!this.pingTimer) {
      this.pingTimer = setInterval(() => this.#heartbeat(), this.pingIntervalMs);
      this.pingTimer.unref();
    }
    if (head?.length) conn.feedData(head);
    return true;
  }

  #message(conn, message) {
    if (conn.role !== 'auth') {
      if (conn.role === 'host') return conn.close(1008, 'invalid_message');
      return this.#streamMessage(conn, message);
    }
    if (performance.now() >= conn.authDeadline) return conn.close(1008, 'auth_timeout');
    const fields = { host: 'fingerprint', viewer: 'lease_id', join: 'connection_id' };
    const mode = message?.type;
    if (typeof mode !== 'string' || !Object.hasOwn(fields, mode) || !hasKeys(message, 'type', 'token', fields[mode])) {
      return conn.close(1008, 'invalid_auth');
    }
    let identity;
    try {
      identity = this.#authorize(message.token);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return conn.close(1008, error.code);
    }
    clearTimeout(conn.authTimer);
    this.unauthenticated.delete(conn);
    conn.role = mode;
    if (mode === 'host') return this.#registerHost(conn, identity, message.fingerprint);
    if (mode === 'viewer') return this.#startViewer(conn, identity, message.lease_id);
    return this.#join(conn, identity, message.connection_id);
  }

  #registerHost(conn, identity, fingerprint) {
    if (typeof fingerprint !== 'string' || fingerprint.length !== 64 || !/^[0-9a-f]+$/.test(fingerprint)) {
      return conn.close(1008, 'invalid_fingerprint');
    }
    // The object itself is the control generation; replacements revoke rather than migrate leases.
    this.hosts.get(identity.device_id)?.conn.close(1001, 'host_replaced');
    const host = {
      conn, identity, fingerprint, leases: new Set(), streams: 0, starts: new RateLimit(64, 64),
    };
    conn.host = host;
    this.hosts.set(identity.device_id, host);
    if (!conn.send({ type: 'ready' })) conn.close(1008, 'backpressure');
  }

  #activeHost(deviceId, subjectHash) {
    const host = this.hosts.get(deviceId);
    if (!host || host.conn.closed || host.identity.subject_hash !== subjectHash) return null;
    if (performance.now() - host.conn.lastPongAt >= this.pongTimeoutMs) {
      host.conn.close(1001, 'pong_timeout');
      return null;
    }
    return host;
  }

  #liveLease(lease) {
    if (lease.closed) return false;
    if (performance.now() >= lease.deadline || this.db.now() >= lease.expiresAt) {
      this.#closeLease(lease, 'lease_expired');
      return false;
    }
    const { identity } = lease.host;
    if (this.#activeHost(identity.device_id, identity.subject_hash) !== lease.host) {
      this.#closeLease(lease, 'host_closed');
      return false;
    }
    return true;
  }

  #startViewer(conn, viewer, id) {
    const lease = validId(id) && this.leases.get(id);
    if (!lease || viewer.device_id !== lease.viewer.device_id || viewer.subject_hash !== lease.viewer.subject_hash ||
        !this.#liveLease(lease)) return conn.close(1008, 'lease_not_found');
    const host = lease.host;
    if (this.db.findGoogleSubject(host.identity.device_id) !== viewer.subject_hash) {
      host.conn.close(1008, 'google_binding_required');
      return conn.close(1008, 'lease_not_found');
    }
    if (lease.streams.size >= LEASE_STREAM_LIMIT || host.streams >= HOST_STREAM_LIMIT ||
        !lease.starts.take() || !host.starts.take()) return conn.close(1008, 'rate_limited');
    const stream = {
      id: newId(), lease, viewer: conn, join: null, closed: false,
      deadline: performance.now() + this.joinTimeoutMs,
    };
    stream.joinTimer = after(this.joinTimeoutMs, () => this.#closeStream(stream, 1008, 'join_timeout'));
    conn.stream = stream;
    lease.streams.add(stream);
    host.streams += 1;
    this.pending.set(stream.id, stream);
    if (!host.conn.send({ type: 'incoming', connection_id: stream.id, lease_id: lease.id,
      authority: lease.authority, grant_hash: lease.grantHash, expires_at: lease.expiresAt })) {
      host.conn.close(1008, 'backpressure');
    }
  }

  #join(conn, identity, id) {
    const stream = validId(id) && this.pending.get(id);
    if (!stream || identity.device_id !== stream.lease.host.identity.device_id ||
        identity.subject_hash !== stream.lease.host.identity.subject_hash) return conn.close(1008, 'connection_not_found');
    if (performance.now() >= stream.deadline) this.#closeStream(stream, 1008, 'join_timeout');
    if (stream.closed || !this.#liveLease(stream.lease)) return conn.close(1008, 'connection_not_found');
    if (this.db.findGoogleSubject(stream.lease.viewer.device_id) !== identity.subject_hash) {
      this.#closeLease(stream.lease, 'google_binding_required');
      return conn.close(1008, 'connection_not_found');
    }
    this.pending.delete(stream.id); // Consume before either endpoint can send frames.
    clearTimeout(stream.joinTimer);
    stream.join = conn;
    conn.stream = stream;
    if (!conn.send({ type: 'connected' }) || !stream.viewer.send({ type: 'connected' })) {
      this.#closeStream(stream, 1008, 'backpressure');
    }
  }

  #streamMessage(conn, message) {
    const stream = conn.stream;
    if (!stream?.join || stream.closed) return conn.close(1008, 'stream_not_connected');
    if (!this.#liveLease(stream.lease)) return;
    const peer = conn.role === 'viewer' ? stream.join : stream.viewer;
    const fail = (reason, code = 1008) => this.#closeStream(stream, code, reason);
    if ((conn.ackTimer && performance.now() >= conn.ackDeadline) ||
        (peer.ackTimer && performance.now() >= peer.ackDeadline)) return fail('ack_timeout');
    if (message?.type === 'data' && hasKeys(message, 'type', 'data')) {
      if (conn.ended) return fail('stream_ended');
      if (conn.ackTimer) return fail('backpressure');
      const data = message.data;
      if (typeof data !== 'string' || !data.length || data.length % 4 !== 0) return fail('invalid_data', 1007);
      if (data.length > MAX_B64_CHUNK || data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0) > MAX_CHUNK_BYTES) {
        return fail('chunk_too_large', 1009);
      }
      if (/\s/.test(data) || !BASE64_CHUNK.test(data)) return fail('invalid_data', 1007);
      conn.ackDeadline = performance.now() + this.ackTimeoutMs;
      conn.ackTimer = after(this.ackTimeoutMs, () => fail('ack_timeout'));
      if (!peer.send({ type: 'data', data })) return fail('backpressure');
      return;
    }
    if (message?.type === 'ack' && hasKeys(message, 'type')) {
      if (!peer.ackTimer) return fail('unexpected_ack');
      clearTimeout(peer.ackTimer);
      peer.ackTimer = null;
      if (!peer.send({ type: 'ack' })) return fail('backpressure');
      return;
    }
    if (message?.type === 'end' && hasKeys(message, 'type')) {
      if (conn.ended) return fail('stream_ended');
      if (conn.ackTimer) return fail('backpressure');
      conn.ended = true;
      if (!peer.send({ type: 'end' })) return fail('backpressure');
      if (peer.ended) this.#closeStream(stream, 1000, '');
      return;
    }
    return fail('invalid_message');
  }

  #closeStream(stream, code, reason) {
    if (stream.closed) return;
    stream.closed = true;
    clearTimeout(stream.joinTimer);
    this.pending.delete(stream.id);
    stream.lease.streams.delete(stream);
    stream.lease.host.streams -= 1;
    for (const conn of [stream.viewer, stream.join]) {
      if (!conn) continue;
      clearTimeout(conn.ackTimer);
      conn.close(code, reason);
    }
  }

  #closeLease(lease, reason) {
    if (lease.closed) return;
    lease.closed = true;
    clearTimeout(lease.timer);
    this.leases.delete(lease.id);
    lease.host.leases.delete(lease);
    for (const stream of lease.streams) this.#closeStream(stream, 1001, reason);
  }

  #socketClosed(conn) {
    clearTimeout(conn.authTimer);
    this.unauthenticated.delete(conn);
    if (conn.host) {
      const { host } = conn;
      if (this.hosts.get(host.identity.device_id) === host) this.hosts.delete(host.identity.device_id);
      for (const lease of host.leases) this.#closeLease(lease, 'host_closed');
    }
    if (conn.stream) this.#closeStream(conn.stream, 1001, 'peer_closed');
  }

  #socketDisposed(conn) {
    this.sockets.delete(conn);
    if (!this.sockets.size) this.#stopHeartbeat();
  }

  #heartbeat() {
    const now = performance.now();
    for (const conn of this.sockets) {
      if (conn.closed || conn.role === 'auth') continue;
      if (now - conn.lastPongAt >= this.pongTimeoutMs) conn.close(1001, 'pong_timeout');
      else if (conn.host && this.db.findGoogleSubject(conn.host.identity.device_id) !== conn.host.identity.subject_hash) {
        conn.close(1008, 'google_binding_required');
      } else conn.ping();
    }
    for (const lease of this.leases.values()) {
      if (this.#liveLease(lease) && this.db.findGoogleSubject(lease.viewer.device_id) !== lease.viewer.subject_hash) {
        this.#closeLease(lease, 'google_binding_required');
      }
    }
  }

  #stopHeartbeat() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.#stopHeartbeat();
    for (const conn of this.sockets) conn.terminate();
    this.openAttempts = [];
  }
}
