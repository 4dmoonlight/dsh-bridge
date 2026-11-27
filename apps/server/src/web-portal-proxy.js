import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto';
import http from 'node:http';
import { Duplex, Transform } from 'node:stream';
import { connect as connectTls } from 'node:tls';

const ENTRY = '/dsh-relay-enter';
export const PORTAL_DATA_MUX_PATH = '/api/remote.mux';
const MAX_STREAMS = 6;
const MAX_OPERATIONS = 30; // Includes bounded queue for the browser's parallel asset requests.
const CONNECT_MS = 8000; // Queue, rendezvous, and TLS share one deadline.
const UPGRADE_MS = 8000;
const HTTP_MS = 120_000;
const WS_IDLE_MS = 60_000;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_LEASE_SECONDS = 30 * 60;
const SECRET = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
// Exact lease cookie issued by the plugin. No Domain, duplicate attributes, or other cookies.
const TARGET_COOKIE = /^(dsh-relay-[a-f0-9]{32}=[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]); HttpOnly; SameSite=Strict; Path=\/; Max-Age=([1-9][0-9]{0,3})$/;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const READ = new Set(['GET', 'HEAD']);
const SHELL = new Set([
  '/', '/index.html', '/manifest.webmanifest', '/favicon.ico', '/favicon.svg', '/favicon-dark.svg',
  '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png',
]);
const API_READ = new Set([
  '/api/file', '/api/session.export', '/api/session.markdown', '/api/changes.summary',
  '/api/changes.diff', '/api/changes.open', '/api/present.host', '/api/present.open',
]);
const API_WRITE = new Set(['/api/changes.open', '/api/present.open']);
const BINARY_UPLOAD = new Set(['/api/session/uploadFileBinary', '/api/deepseek-chat-import/archive']);
// Ordinary Typert endpoints use exactly /api/<namespace>/<method>. Native DSH
// still decides which Remote methods exist and applies its owner authorization.
const RPC_PATH = /^\/api\/[A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+$/;
const HTTP_REQUEST_HEADERS = [
  'accept', 'accept-encoding', 'accept-language', 'content-type', 'content-encoding', 'content-length',
  'range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since', 'if-range', 'last-event-id',
];
const HTTP_RESPONSE_HEADERS = [
  'accept-ranges', 'content-type', 'content-encoding', 'content-length', 'content-range', 'content-disposition',
  'etag', 'last-modified', 'content-security-policy', 'cross-origin-embedder-policy', 'cross-origin-opener-policy',
  'cross-origin-resource-policy', 'permissions-policy', 'x-frame-options',
];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_HEADERS = ['host', 'origin', 'cookie', 'sec-fetch-site', 'content-length', 'transfer-encoding'];

export const PORTAL_DATA_ALT_PORT = '8443';

function externalAuthority(origin) {
  if (typeof origin !== 'string' || !origin.startsWith('https://')) return null;
  let url;
  try { url = new URL(origin); } catch { return null; }
  // Require the canonical origin (not a URL with credentials, path, etc.).
  if (url.origin !== origin || (url.port && url.port !== PORTAL_DATA_ALT_PORT)) return null;
  const labels = url.hostname.split('.');
  if (url.hostname.length > 253 || labels.length < 2 || labels.some(label =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return url.host;
}

function pathOf(raw) {
  if (typeof raw !== 'string' || raw.length > 8192 || !raw.startsWith('/') || /[\\#\x00-\x20\x7f-\uffff]/.test(raw)) return null;
  const i = raw.indexOf('?');
  const path = i < 0 ? raw : raw.slice(0, i);
  if (path.includes('//')) return null;
  try {
    const segments = path.split('/').map(decodeURIComponent);
    if (segments.some(segment => segment === '.' || segment === '..' || /[\\/%?#;\x00-\x1f\x7f]/.test(segment))) return null;
    if (i >= 0) {
      const query = raw.slice(i + 1);
      if (/;|%(?![a-f0-9]{2})/i.test(query)) return null;
      for (const key of new URLSearchParams(query).keys()) {
        if (/^(?:grant|token|access_token|id_token|refresh_token)$/i.test(key) || /[%\x00-\x20\x7f]/.test(key)) return null;
      }
    }
    return segments.join('/');
  } catch { return null; }
}

function allowedPath(method, path) {
  if (READ.has(method)) {
    return SHELL.has(path) || path.startsWith('/assets/') || path.startsWith('/plugins/') || API_READ.has(path);
  }
  if (method !== 'POST') return false;
  // Do not admit control routes even when their namespace fits the RPC grammar.
  const namespace = path.split('/')[2]?.toLowerCase();
  if (!namespace || /^(?:cross-device|google|oauth|auth|remote\.mux|dsh-bridge|dsh-relay)(?:[._-]|$)|^v[0-9]+$/.test(namespace)) return false;
  return API_WRITE.has(path) || RPC_PATH.test(path);
}

function headerTokens(values) {
  return new Set((values ?? []).join(',').toLowerCase().split(',').map(token => token.trim()).filter(Boolean));
}

function requestStatus(headers, nominated, host, origin, needsOrigin, sensitive) {
  if (SENSITIVE_HEADERS.some(name => nominated.has(name))) return 400;
  if (headers.host?.length !== 1 || headers.host[0] !== host) return 403;
  if ((needsOrigin || headers.origin) && (headers.origin?.length !== 1 || headers.origin[0] !== origin)) return 403;
  const site = headers['sec-fetch-site'];
  if (sensitive && ((site && (site.length !== 1 || site[0] !== 'same-origin')) || (!site && !headers.origin))) return 403;
  return 0;
}

function responseHeaders(response, method) {
  const headers = response.headersDistinct;
  const nominated = headerTokens(headers.connection);
  // Keep same-origin native form/POST Origin semantics without sending a
  // Referer when the native experience follows an off-portal link.
  const safe = { 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff' };
  for (const name of HTTP_RESPONSE_HEADERS) {
    if (headers[name]?.length === 1 && !nominated.has(name)) safe[name] = headers[name][0];
  }
  if (REDIRECTS.has(response.statusCode) && !nominated.has('location') && headers.location?.length === 1) {
    const raw = headers.location[0];
    const path = pathOf(raw);
    const follow = response.statusCode === 307 || response.statusCode === 308 ? method : 'GET';
    if (path && allowedPath(follow, path)) safe.location = raw;
  }
  return safe;
}

function denyHttp(res, status) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) res.destroy();
  else res.writeHead(status, { 'cache-control': 'no-store', connection: 'close' }).end();
}

function denyUpgrade(socket, status) {
  if (socket.destroyed || !socket.writable) return;
  socket.once('error', () => socket.destroy());
  socket.end('HTTP/1.1 ' + status + ' ' + http.STATUS_CODES[status] +
    '\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n');
}

function failure(status = 502) {
  return Object.assign(new Error('Portal target unavailable'), { status });
}

function after(ms, callback) {
  const timer = setTimeout(callback, ms);
  timer.unref();
  return timer;
}

function aborted(promise, signal) {
  return new Promise((resolve, reject) => {
    function cancel() { reject(signal.reason); }
    // Always observe the original promise, including a late rejected rendezvous.
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });
}

function pinTls(raw, fingerprint, signal) {
  const peer = connectTls({ socket: raw, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', rejectUnauthorized: false });
  const closePeer = () => peer.destroy();
  raw.once('close', closePeer);
  peer.once('close', () => {
    raw.off('close', closePeer);
    raw.destroy();
  });
  peer.on('error', closePeer);
  return aborted(new Promise((resolve, reject) => {
    const lost = () => reject(failure());
    peer.once('close', lost);
    peer.once('secureConnect', () => {
      try {
        signal.throwIfAborted();
        const der = peer.getPeerCertificate()?.raw;
        if (!der || !timingSafeEqual(createHash('sha256').update(der).digest(), fingerprint)) throw failure();
        const certificate = new X509Certificate(der);
        const now = Date.now();
        if (!(Date.parse(certificate.validFrom) <= now && now < Date.parse(certificate.validTo))) throw failure();
        peer.off('close', lost);
        resolve(peer);
      } catch {
        peer.destroy();
        reject(failure());
      }
    });
  }), signal);
}

function targetRequest(peer, method, path, headers) {
  // Use the HTTP/1 parser only, after TLS admission. With createConnection and
  // no Agent, the already verified socket is the only possible transport.
  return http.request({ method, path, headers, setHost: false, maxHeaderSize: 16 * 1024,
    createConnection: () => peer });
}

/** One portal lease. Caller owns browser/owner authentication and calls close on revocation. */
export function createPortalProxy({ authority, externalOrigin, grant, fingerprint, connectStream }) {
  const host = externalAuthority(externalOrigin);
  if (typeof authority !== 'string' || authority.length !== 57 || !/^[a-f0-9]{32}\.dsh-relay\.localhost:3080$/.test(authority) ||
      !host || typeof grant !== 'string' || grant.length !== 43 || !SECRET.test(grant) ||
      typeof fingerprint !== 'string' || fingerprint.length !== 64 || !/^[a-f0-9]{64}$/.test(fingerprint) ||
      typeof connectStream !== 'function') throw new TypeError('Invalid portal target configuration');
  const internalOrigin = 'http://' + authority;
  const pin = Buffer.from(fingerprint, 'hex');
  const operations = new Set();
  const waiters = [];
  let streams = 0;
  let closed = false;
  let activation;
  let cookie;
  let expiresAt;
  let expiryTimer;

  function start() {
    if (closed || operations.size >= MAX_OPERATIONS) return null;
    const controller = new AbortController();
    const op = {
      signal: controller.signal,
      stop(status) { controller.abort(failure(status)); },
      finish() { operations.delete(op); op.stop(); },
    };
    operations.add(op);
    return op;
  }

  function reserve(signal) {
    signal.throwIfAborted();
    function release() {
      streams--;
      const next = waiters.shift();
      next?.();
    }
    if (streams < MAX_STREAMS) {
      streams++;
      return release;
    }
    return new Promise((resolve, reject) => {
      function next() {
        signal.removeEventListener('abort', cancel);
        streams++;
        resolve(release);
      }
      function cancel() {
        waiters.splice(waiters.indexOf(next), 1);
        reject(signal.reason);
      }
      waiters.push(next);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  async function pinned(op) {
    const signal = op.signal;
    const timer = after(CONNECT_MS, () => op.stop(504));
    try {
      const release = await reserve(signal);
      const opening = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return connectStream(signal);
      }).then(raw => {
        if (!(raw instanceof Duplex) || raw.destroyed) {
          release();
          throw failure();
        }
        const destroy = () => raw.destroy();
        raw.on('error', destroy);
        raw.once('close', () => {
          signal.removeEventListener('abort', destroy);
          release();
        });
        // Keep the reservation until a late connector actually settles; never
        // leave a late or revoked stream live, even if its connector ignored abort.
        if (signal.aborted) destroy();
        else signal.addEventListener('abort', destroy, { once: true });
        return raw;
      }, () => { release(); throw failure(); });
      const raw = await aborted(opening, signal);
      signal.throwIfAborted();
      if (raw.destroyed) throw failure();
      return await pinTls(raw, pin, signal);
    } finally { clearTimeout(timer); }
  }

  function activate() {
    if (closed) return Promise.reject(failure(503));
    if (activation) return activation;
    const op = start();
    activation = (async () => {
      try {
        const peer = await pinned(op);
        op.signal.throwIfAborted();
        const body = JSON.stringify({ grant });
        grant = undefined;
        const timer = after(UPGRADE_MS, () => op.stop(504));
        try {
          const session = await aborted(new Promise((resolve, reject) => {
            const upstream = targetRequest(peer, 'POST', ENTRY, { host: authority, origin: internalOrigin,
              'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' });
            upstream.on('error', () => reject(failure()));
            upstream.once('upgrade', (_response, socket) => { socket.destroy(); reject(failure()); });
            upstream.once('response', response => {
              response.on('error', () => {});
              const h = response.headersDistinct;
              const value = h['set-cookie']?.length === 1 && h['set-cookie'][0];
              const match = typeof value === 'string' && TARGET_COOKIE.exec(value);
              response.destroy();
              if (response.statusCode !== 204 || h['set-cookie2'] || h['transfer-encoding'] ||
                  (h['content-length'] && (h['content-length'].length !== 1 || h['content-length'][0] !== '0')) ||
                  headerTokens(h.connection).has('set-cookie') || !match || match[0] !== value || Number(match[2]) > MAX_LEASE_SECONDS) {
                reject(failure());
              } else resolve({ pair: match[1], maxAge: Number(match[2]) });
            });
            upstream.end(body);
          }), op.signal);
          op.signal.throwIfAborted();
          cookie = session.pair;
          expiresAt = Date.now() + session.maxAge * 1000;
          expiryTimer = after(session.maxAge * 1000, close);
        } finally { clearTimeout(timer); }
      } catch {
        throw op.signal.aborted ? op.signal.reason : failure();
      } finally { grant = undefined; op.finish(); }
    })();
    return activation;
  }

  function active() {
    if (cookie && Date.now() >= expiresAt) close();
    return !closed && Boolean(cookie);
  }

  async function request(req, res) {
    if (!active()) return denyHttp(res, 503);
    const path = pathOf(req.url);
    if (!path) return denyHttp(res, 400);
    const isRead = READ.has(req.method);
    if (!isRead && req.method !== 'POST') return denyHttp(res, 405);
    if (!allowedPath(req.method, path)) return denyHttp(res, 404);
    const h = req.headersDistinct;
    const nominated = headerTokens(h.connection);
    const status = requestStatus(h, nominated, host, externalOrigin, !isRead, !isRead || path.startsWith('/api/'));
    if (status) return denyHttp(res, status);
    const length = h['content-length']?.[0];
    const transfer = h['transfer-encoding'];
    if (h.upgrade || nominated.has('upgrade') || h.expect ||
        (length !== undefined && (h['content-length'].length !== 1 || !/^\d+$/.test(length))) ||
        (transfer && (transfer.length !== 1 || transfer[0].toLowerCase() !== 'chunked' || length !== undefined)) ||
        (isRead && (transfer || Number(length ?? 0) !== 0))) return denyHttp(res, 400);
    if (Number(length ?? 0) > MAX_REQUEST_BYTES) return denyHttp(res, 413);
    for (const name of HTTP_REQUEST_HEADERS) {
      if (!nominated.has(name) && h[name]?.length > 1) return denyHttp(res, 400);
    }
    if (!isRead && !API_WRITE.has(path)) {
      const mediaType = h['content-type']?.[0].split(';', 1)[0].trim().toLowerCase();
      const expected = BINARY_UPLOAD.has(path) ? 'application/octet-stream' : 'application/json';
      if (nominated.has('content-type') || mediaType !== expected) return denyHttp(res, 415);
    }
    const op = start();
    if (!op) return denyHttp(res, 503);
    let upstream;
    let limit;
    let timer;
    const stop = () => op.stop();
    const finish = () => {
      clearTimeout(timer);
      op.signal.removeEventListener('abort', cancelled);
      if (limit) { req.unpipe(limit); limit.destroy(); }
      upstream?.destroy();
      op.finish();
    };
    function cancelled() { denyHttp(res, op.signal.reason.status); finish(); }
    req.once('error', stop);
    res.once('close', finish);
    op.signal.addEventListener('abort', cancelled, { once: true });
    try {
      const peer = await pinned(op);
      op.signal.throwIfAborted();
      const headers = { host: authority, cookie, connection: 'close' };
      if (h.origin) headers.origin = internalOrigin;
      for (const name of HTTP_REQUEST_HEADERS) {
        if (h[name] && !nominated.has(name)) headers[name] = h[name][0];
      }
      upstream = targetRequest(peer, req.method, req.url, headers);
      timer = after(HTTP_MS, () => op.stop(504));
      upstream.on('error', stop);
      upstream.once('upgrade', (_response, socket) => { socket.destroy(); stop(); });
      upstream.once('response', response => {
        response.on('error', stop);
        if (res.destroyed || op.signal.aborted) return response.destroy();
        try {
          res.writeHead(response.statusCode, responseHeaders(response, req.method));
          response.pipe(res);
        } catch { stop(); }
      });
      if (isRead) upstream.end();
      else {
        // Stream decoded HTTP body bytes; no app-level buffering or trailers.
        let bytes = 0;
        limit = new Transform({ transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > MAX_REQUEST_BYTES) callback(failure(413));
          else callback(null, chunk);
        } });
        limit.on('error', err => op.stop(err.status));
        req.pipe(limit).pipe(upstream);
      }
    } catch { stop(); }
  }

  async function upgrade(req, socket, head) {
    if (!active()) return denyUpgrade(socket, 503);
    if (req.method !== 'GET' || req.url !== PORTAL_DATA_MUX_PATH) return denyUpgrade(socket, 404);
    const h = req.headersDistinct;
    const nominated = headerTokens(h.connection);
    const status = requestStatus(h, nominated, host, externalOrigin, true, true);
    if (status) return denyUpgrade(socket, status);
    const key = h['sec-websocket-key']?.[0];
    if (req.httpVersion !== '1.1' || h.upgrade?.length !== 1 || h.upgrade[0].toLowerCase() !== 'websocket' ||
        !nominated.has('upgrade') || nominated.has('sec-websocket-key') || nominated.has('sec-websocket-version') ||
        h['sec-websocket-key']?.length !== 1 || !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
        Buffer.from(key, 'base64').toString('base64') !== key ||
        h['sec-websocket-version']?.length !== 1 || h['sec-websocket-version'][0] !== '13' ||
        h['sec-websocket-protocol'] || h['transfer-encoding'] || h['content-length'] || h.expect ||
        head.length > 64 * 1024) return denyUpgrade(socket, 400);
    const op = start();
    if (!op) return denyUpgrade(socket, 503);
    socket.pause();
    let upstream;
    let peer;
    let timer;
    let upgraded = false;
    const stop = () => op.stop();
    const finish = () => {
      clearTimeout(timer);
      op.signal.removeEventListener('abort', cancelled);
      peer?.destroy();
      upstream?.destroy();
      op.finish();
    };
    function cancelled() {
      if (upgraded) socket.destroy();
      else denyUpgrade(socket, op.signal.reason.status);
      finish();
    }
    socket.once('close', finish);
    socket.on('error', stop);
    op.signal.addEventListener('abort', cancelled, { once: true });
    try {
      const tls = await pinned(op);
      op.signal.throwIfAborted();
      const expected = createHash('sha1').update(key + WS_GUID).digest('base64');
      // Compression is optional in the native mux; do not negotiate extensions
      // or protocols through this proxy, regardless of the browser offer.
      upstream = targetRequest(tls, 'GET', PORTAL_DATA_MUX_PATH, { host: authority, origin: internalOrigin, cookie,
        connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': key, 'sec-websocket-version': '13' });
      timer = after(UPGRADE_MS, () => op.stop(504));
      upstream.on('error', stop);
      upstream.once('response', response => { response.on('error', stop); response.destroy(); stop(); });
      upstream.once('upgrade', (response, target, responseHead) => {
        peer = target;
        target.on('error', stop);
        const reply = response.headersDistinct;
        const connection = headerTokens(reply.connection);
        if (socket.destroyed || op.signal.aborted || response.statusCode !== 101 || response.httpVersion !== '1.1' ||
            reply.upgrade?.length !== 1 || reply.upgrade[0].toLowerCase() !== 'websocket' || !connection.has('upgrade') ||
            connection.has('sec-websocket-accept') || reply['sec-websocket-accept']?.length !== 1 ||
            reply['sec-websocket-accept'][0] !== expected || reply['sec-websocket-protocol'] ||
            reply['sec-websocket-extensions'] || reply['content-length'] || reply['transfer-encoding']) {
          target.destroy();
          stop();
          return;
        }
        clearTimeout(timer);
        upgraded = true;
        target.once('close', stop);
        socket.setTimeout(WS_IDLE_MS, stop);
        target.pause();
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
          'Cache-Control: no-store\r\nSec-WebSocket-Accept: ' + expected + '\r\n\r\n');
        if (responseHead.length) target.unshift(responseHead);
        if (head.length) socket.unshift(head);
        target.pipe(socket);
        socket.pipe(target);
      });
      upstream.end();
    } catch { stop(); }
  }

  function close() {
    if (closed) return;
    closed = true;
    grant = cookie = undefined;
    clearTimeout(expiryTimer);
    for (const op of operations) op.stop(503);
  }

  return { activate, request, upgrade, close };
}
