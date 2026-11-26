import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

const ENTRY = '/dsh-relay-enter'
const MUX = '/api/remote.mux'
const MAX_LEASE_MS = 30 * 60_000
const MAX_ENTRY_BYTES = 512
const HANDSHAKE_MS = 10_000
const METHODS = new Set(['GET', 'HEAD', 'POST'])
const CONTROL = ['/api/cross-device', '/dsh-bridge-google', '/connect', '/dsh-bridge-enter', ENTRY]
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
])
const HTTP_REQUEST_HEADERS = [
  'accept', 'accept-encoding', 'accept-language', 'content-type', 'content-encoding',
  'content-length', 'range', 'if-match', 'if-none-match', 'if-modified-since',
  'if-unmodified-since', 'if-range', 'last-event-id',
]
const HIDDEN_RESPONSE_HEADERS = new Set([
  'set-cookie', 'set-cookie2', 'www-authenticate', 'authentication-info',
  'proxy-authentication-info', 'clear-site-data', 'alt-svc', 'strict-transport-security',
  'refresh',
])

const entryScript =
  'const grant = location.hash.slice(1); history.replaceState(null, "", "/dsh-relay-enter");' +
  'if (/^[A-Za-z0-9_-]{43}$/.test(grant)) {' +
  'fetch("/dsh-relay-enter", {method:"POST", headers:{"Content-Type":"application/json"},' +
  'body:JSON.stringify({grant}), referrerPolicy:"origin", redirect:"error"})' +
  '.then(r => { if (!r.ok) throw Error(); location.replace("/"); }).catch(failed);' +
  '} else { failed(); }' +
  'function failed() { document.getElementById("status").textContent = "Unable to open this device."; }'
const entryPage = '<!doctype html><html lang="en"><meta charset="utf-8">' +
  '<title>Open DeepSeek Harness</title><p id="status">Opening DeepSeek Harness…</p>' +
  '<script>' + entryScript + '</script></html>'
const entryCsp = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; " +
  "connect-src 'self'; script-src 'sha256-" + createHash('sha256').update(entryScript).digest('base64') + "'"

function secretBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null
  const bytes = Buffer.from(value, 'base64url')
  return bytes.toString('base64url') === value ? bytes : null
}

function inTree(path, root) {
  return path === root || path.startsWith(root + '/')
}

function inspectTarget(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || /[\\#\x00-\x20\x7f]/.test(raw)) return null
  const q = raw.indexOf('?')
  const path = q === -1 ? raw : raw.slice(0, q)
  if (path.includes('//')) return null
  try {
    const segments = path.split('/').map(segment => decodeURIComponent(segment))
    if (segments.some(segment => segment === '.' || segment === '..' || /[\\/%?#;\x00-\x1f\x7f]/.test(segment))) return null
    if (q !== -1) {
      const query = raw.slice(q + 1)
      if (/;|%(?![0-9a-f]{2})/i.test(query)) return null
      // Keep the original target, including DSH's /plugins/??…&rev=… combo syntax.
      for (const key of new URLSearchParams(query).keys()) {
        if (/^(?:token|grant)$/i.test(key) || /[%\x00-\x20\x7f]/.test(key)) return null
      }
    }
    return segments.join('/').toLowerCase()
  } catch {
    return null
  }
}

function connectionTokens(value) {
  return new Set(String(value ?? '').toLowerCase().split(',').map(token => token.trim()))
}

function denyHttp(res, status) {
  res.writeHead(status, { 'cache-control': 'no-store', connection: 'close' }).end()
}

function denyUpgrade(socket, status) {
  if (socket.writable) socket.end('HTTP/1.1 ' + status + ' ' + http.STATUS_CODES[status] +
    '\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n')
}

function checkedRequest(req, lease, sensitive) {
  if (!lease || Date.now() >= lease.expiresAt) return 401
  const h = req.headersDistinct
  const nominated = connectionTokens(req.headers.connection)
  if (['host', 'origin', 'cookie', 'sec-fetch-site'].some(key => nominated.has(key))) return 400
  if (h.host?.length !== 1 || h.host[0] !== lease.authority) return 403
  if (h.origin && (h.origin.length !== 1 || h.origin[0] !== lease.viewerOrigin)) return 403
  if (sensitive && h['sec-fetch-site'] &&
      (h['sec-fetch-site'].length !== 1 || h['sec-fetch-site'][0] !== 'same-origin')) return 403
  return 0
}

function hasCookie(req, lease) {
  if (!lease.session) return false
  const prefix = lease.session.name + '='
  const parts = (req.headers.cookie ?? '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(prefix))
  const value = parts.length === 1 && secretBytes(parts[0].slice(prefix.length))
  return Boolean(value && timingSafeEqual(value, lease.session.secret))
}

function physicalOrigin(ctx) {
  const origin = new URL(ctx.webServer.getOrigin())
  // Installed WebServer.getOrigin() returns a concrete bind literal, not an
  // advertised proxy address. Fail closed when DSH is not bound to loopback.
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash ||
      (origin.hostname !== '[::1]' && !/^127(?:[.]\d{1,3}){3}$/.test(origin.hostname))) {
    throw Error('Invalid DSH Web origin')
  }
  return origin
}

function nativeBrowserCookie(ctx, origin) {
  const connection = ctx.connection
  const launch = new URL(connection.authenticatedUrl(origin.href))
  if (launch.origin !== origin.origin || launch.pathname !== '/' || !launch.search) return null
  let cookie
  // ConnectionIndexRequest/Response: capture only the signed cookie from the
  // local token exchange. Neither the token URL nor this cookie crosses TLS.
  connection.authorizeIndex({ method: 'GET', url: '/' + launch.search, headers: { host: origin.host } }, {
    writeHead(status, headers) {
      if (status === 303 && typeof headers?.['set-cookie'] === 'string') {
        const pair = headers['set-cookie'].split(';', 1)[0]
        if (/^[a-zA-Z0-9_-]+=[a-zA-Z0-9_.~-]+$/.test(pair)) cookie = pair
      }
    },
    end() {},
  })
  return cookie && connection.requestRejection({ headers: { host: origin.host, cookie } }) === undefined
    ? cookie : null
}

function nativeHeaders(req, session, allowlist) {
  const nominated = connectionTokens(req.headers.connection)
  const headers = { host: session.origin.host, cookie: session.nativeCookie }
  if (req.headers.origin !== undefined) headers.origin = session.origin.origin
  for (const key of allowlist) {
    if (!nominated.has(key) && req.headers[key] !== undefined) headers[key] = req.headers[key]
  }
  return headers
}

function nativeRequest(session, method, path, headers) {
  const origin = session.origin
  const client = origin.protocol === 'https:' ? https : http
  return client.request(origin, { method, path, headers, agent: false,
    ...(origin.protocol === 'https:' ? { rejectUnauthorized: true } : {}) })
}

function responseHeaders(upstream, session) {
  const nominated = connectionTokens(upstream.headers.connection)
  const headers = Object.create(null)
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (HOP_HEADERS.has(name) || HIDDEN_RESPONSE_HEADERS.has(name) || nominated.has(name) ||
        name.startsWith('access-control-') || value === undefined) continue
    if (name === 'location') {
      // Preserve clean native redirects without advertising the physical origin,
      // exposing tokenized links, or letting an upstream redirect change the peer.
      if (typeof value === 'string') {
        const relative = value.startsWith(session.origin.origin + '/')
          ? value.slice(session.origin.origin.length) : value
        const route = inspectTarget(relative)
        if (route && !CONTROL.some(root => inTree(route, root))) headers.location = relative
      }
      continue
    }
    headers[name] = value
  }
  headers['cache-control'] = 'no-store'
  return headers
}

function proxyHttp(req, res, session) {
  const upstream = nativeRequest(session, req.method, req.url, nativeHeaders(req, session, HTTP_REQUEST_HEADERS))
  upstream.on('error', () => {
    if (res.destroyed) return
    if (res.headersSent) res.destroy()
    else denyHttp(res, 502)
  })
  res.once('close', () => upstream.destroy())
  req.once('error', () => upstream.destroy())
  upstream.once('response', response => {
    response.on('error', () => res.destroy())
    if (res.destroyed) {
      response.destroy()
      return
    }
    try {
      res.writeHead(response.statusCode, responseHeaders(response, session))
      response.pipe(res)
    } catch {
      response.destroy()
      res.destroy()
    }
  })
  req.pipe(upstream)
}

function proxyUpgrade(req, socket, head, session) {
  const h = req.headersDistinct
  const key = req.headers['sec-websocket-key']
  const nominated = connectionTokens(req.headers.connection)
  if (h.upgrade?.length !== 1 || h.upgrade[0].toLowerCase() !== 'websocket' ||
      !nominated.has('upgrade') || nominated.has('sec-websocket-key') || nominated.has('sec-websocket-version') ||
      h['sec-websocket-key']?.length !== 1 || !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
      Buffer.from(key, 'base64').toString('base64') !== key ||
      h['sec-websocket-version']?.length !== 1 || h['sec-websocket-version'][0] !== '13' ||
      h['sec-websocket-protocol'] || h['transfer-encoding'] || h['content-length']) {
    denyUpgrade(socket, 400)
    return
  }
  const headers = nativeHeaders(req, session, ['sec-websocket-extensions'])
  headers.connection = 'Upgrade'
  headers.upgrade = 'websocket'
  headers['sec-websocket-key'] = key
  headers['sec-websocket-version'] = '13'
  const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')

  socket.pause()
  const upstream = nativeRequest(session, 'GET', MUX, headers)
  let negotiated = false
  const timer = setTimeout(() => upstream.destroy(Error('Upgrade timed out')), HANDSHAKE_MS)
  timer.unref()
  socket.once('close', () => { clearTimeout(timer); upstream.destroy() })
  upstream.on('error', () => {
    clearTimeout(timer)
    if (negotiated) socket.destroy()
    else denyUpgrade(socket, 502)
  })
  upstream.once('response', response => {
    clearTimeout(timer)
    response.destroy()
    denyUpgrade(socket, 502)
  })
  upstream.once('upgrade', (response, peer, responseHead) => {
    clearTimeout(timer)
    peer.on('error', () => socket.destroy())
    if (socket.destroyed || response.statusCode !== 101 ||
        response.headers.upgrade?.toLowerCase() !== 'websocket' ||
        !connectionTokens(response.headers.connection).has('upgrade') ||
        response.headersDistinct['sec-websocket-accept']?.length !== 1 ||
        response.headers['sec-websocket-accept'] !== expected || response.headers['sec-websocket-protocol'] ||
        (response.headers['sec-websocket-extensions'] && !headers['sec-websocket-extensions'])) {
      peer.destroy()
      denyUpgrade(socket, 502)
      return
    }
    negotiated = true
    const extension = response.headers['sec-websocket-extensions']
    socket.once('close', () => peer.destroy())
    peer.once('close', () => socket.destroy())
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
      'Cache-Control: no-store\r\nSec-WebSocket-Accept: ' + expected + '\r\n' +
      (extension ? 'Sec-WebSocket-Extensions: ' + extension + '\r\n' : '') + '\r\n')
    if (responseHead.length) socket.write(responseHead)
    if (head.length) peer.write(head)
    peer.pipe(socket)
    socket.pipe(peer)
  })
  upstream.end()
}

/** Attach the native HTTP parser to admitted, pin-verified TLS application streams only. */
export function createRelayTarget(ctx) {
  const leases = new Map()
  const bySocket = new WeakMap()
  let closed = false

  function forget(lease) {
    clearTimeout(lease.timer)
    leases.delete(lease.id)
    for (const socket of lease.sockets) socket.destroy()
    lease.sockets.clear()
    lease.session = null
    lease.hash = null
  }

  function activeSession(lease) {
    // Never keep dialing a stale listener after DSH has rebound during a lease.
    if (physicalOrigin(ctx).origin !== lease.session.origin.origin) return null
    return lease.session
  }

  function enter(req, res, lease) {
    if (req.method === 'GET' && !req.headers['transfer-encoding'] && !Number(req.headers['content-length'] ?? 0)) {
      res.writeHead(200, {
        'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8',
        'content-security-policy': entryCsp, 'referrer-policy': 'origin', 'x-content-type-options': 'nosniff',
      }).end(entryPage)
      return
    }
    if (req.method !== 'POST') return denyHttp(res, 405)
    if (req.headers.origin !== lease.viewerOrigin) return denyHttp(res, 403)
    if (lease.session) return denyHttp(res, 401)
    if (req.headers['content-encoding'] || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
      return denyHttp(res, 415)
    }
    if (Number(req.headers['content-length'] ?? 0) > MAX_ENTRY_BYTES) return denyHttp(res, 413)
    let size = 0
    let chunks = []
    const timer = setTimeout(() => req.socket.destroy(), HANDSHAKE_MS)
    timer.unref()
    res.once('close', () => clearTimeout(timer))
    req.on('data', chunk => {
      if (!chunks) return
      size += chunk.length
      if (size > MAX_ENTRY_BYTES) {
        chunks = null
        denyHttp(res, 413)
      } else chunks.push(chunk)
    })
    req.once('end', () => {
      if (!chunks || res.destroyed) return
      if (!lease.hash || lease.session || Date.now() >= lease.expiresAt) return denyHttp(res, 401)
      let grant
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (payload && Object.keys(payload).length === 1 && Object.hasOwn(payload, 'grant')) {
          grant = secretBytes(payload.grant)
        }
      } catch { /* invalid JSON */ }
      if (!grant || !timingSafeEqual(createHash('sha256').update(grant).digest(), lease.hash)) {
        return denyHttp(res, 401)
      }
      // The exchange is synchronous: a second request cannot redeem this grant.
      try {
        const origin = physicalOrigin(ctx)
        const nativeCookie = nativeBrowserCookie(ctx, origin)
        if (!nativeCookie) return denyHttp(res, 502)
        const name = 'dsh-relay-' + randomBytes(16).toString('hex')
        const secret = randomBytes(32)
        lease.session = { origin, nativeCookie, name, secret }
        const lifetime = Math.ceil((lease.expiresAt - Date.now()) / 1000)
        res.writeHead(204, { 'cache-control': 'no-store',
          'set-cookie': name + '=' + secret.toString('base64url') + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + lifetime,
        }).end()
      } catch {
        denyHttp(res, 502)
      }
    })
  }

  const server = http.createServer((req, res) => {
    req.on('error', () => res.destroy())
    const lease = bySocket.get(req.socket)
    const target = inspectTarget(req.url)
    const status = checkedRequest(req, lease, !['GET', 'HEAD'].includes(req.method) ||
      Boolean(target && inTree(target, '/api')))
    if (status) return denyHttp(res, status)
    if (!target) return denyHttp(res, 400)
    if (!METHODS.has(req.method)) return denyHttp(res, 405)
    if (req.url === ENTRY) return enter(req, res, lease)
    if (CONTROL.some(root => inTree(target, root)) || inTree(target, MUX)) return denyHttp(res, 404)
    if (!hasCookie(req, lease)) return denyHttp(res, 401)
    const nominated = connectionTokens(req.headers.connection)
    if (nominated.has('transfer-encoding') || nominated.has('content-length') ||
        (req.method !== 'POST' && (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0)))) {
      return denyHttp(res, 400)
    }
    try {
      const session = activeSession(lease)
      if (!session) return denyHttp(res, 502)
      proxyHttp(req, res, session)
    } catch { denyHttp(res, 502) }
  })
  server.on('upgrade', (req, socket, head) => {
    const lease = bySocket.get(socket)
    const status = checkedRequest(req, lease, true)
    if (status) return denyUpgrade(socket, status)
    if (req.method !== 'GET' || req.url !== MUX) return denyUpgrade(socket, 404)
    if (!hasCookie(req, lease)) return denyUpgrade(socket, 401)
    try {
      const session = activeSession(lease)
      if (!session) return denyUpgrade(socket, 502)
      proxyUpgrade(req, socket, head, session)
    } catch { denyUpgrade(socket, 502) }
  })
  server.on('connect', (_req, socket) => denyUpgrade(socket, 405))
  server.on('checkContinue', (_req, res) => denyHttp(res, 417))
  server.on('checkExpectation', (_req, res) => denyHttp(res, 417))
  server.on('clientError', (_error, socket) => socket.destroy())

  return {
    accept(info, socket) {
      const now = Date.now()
      const id = info?.lease_id
      const authority = info?.authority
      const expiresAt = info?.expires_at
      const hash = secretBytes(info?.grant_hash)
      const port = typeof authority === 'string' && /^[a-f0-9]{32}\.dsh-relay\.localhost:([1-9]\d{0,4})$/.exec(authority)?.[1]
      if (closed || socket.destroyed || bySocket.has(socket) || typeof id !== 'string' || !id || id.length > 256 ||
          !port || Number(port) > 65535 || Number(port) === 80 || !hash ||
          !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt - now > MAX_LEASE_MS) {
        socket.destroy()
        return false
      }
      let lease = leases.get(id)
      if (lease && (lease.authority !== authority || lease.expiresAt !== expiresAt || !timingSafeEqual(hash, lease.hash))) {
        socket.destroy()
        return false
      }
      if (!lease) {
        lease = { id, authority, viewerOrigin: 'http://' + authority, expiresAt, hash, session: null, sockets: new Set() }
        lease.timer = setTimeout(() => forget(lease), expiresAt - now)
        lease.timer.unref()
        leases.set(id, lease)
      }
      bySocket.set(socket, lease)
      lease.sockets.add(socket)
      socket.on('error', () => socket.destroy())
      socket.once('close', () => lease.sockets.delete(socket))
      server.emit('connection', socket)
      socket.resume()
      return true
    },
    close() {
      closed = true
      for (const lease of leases.values()) forget(lease)
    },
  }
}
