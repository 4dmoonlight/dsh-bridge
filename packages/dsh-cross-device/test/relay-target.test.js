import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import test from 'node:test'
import { createRelayTarget } from '../lib/relay-target.js'
import { createRelayCertificate, relayClientTls, relayServerTls } from '../lib/relay-transport.js'

const ENTRY = '/dsh-relay-enter'
const MUX = '/api/remote.mux'
const AUTHORITY = '11111111111111111111111111111111.dsh-relay.localhost:43421'
const VIEWER = 'http://' + AUTHORITY
const NATIVE_COOKIE = 'dsh-auth-native=fixture.signed-cookie'
const LAUNCH_TOKEN = 'private-dsh-launch-fixture'
const KEY = randomBytes(16).toString('base64')
let certPromise

function createLease(fields) {
  const bytes = randomBytes(32)
  return {
    grant: bytes.toString('base64url'),
    info: { lease_id: randomBytes(16).toString('hex'), authority: AUTHORITY,
      grant_hash: createHash('sha256').update(bytes).digest('base64url'), expires_at: Date.now() + 60_000, ...fields },
  }
}

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

async function setup(t) {
  const certificate = await (certPromise ??= createRelayCertificate())
  const seen = []
  const upgrades = []
  const auth = []
  const sockets = new Set()
  const native = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
      const location = req.url === '/redirect' ? origin + '/assets/chunk.js' :
        req.url === '/private-redirect' ? origin + '/?token=' + LAUNCH_TOKEN : null
      res.writeHead(location ? 302 : 200, {
        'content-type': 'text/plain', 'set-cookie': NATIVE_COOKIE + '; Path=/; HttpOnly',
        'cache-control': 'public,max-age=86400', 'access-control-allow-origin': '*',
        connection: 'close, x-upstream-hop', 'x-upstream-hop': 'hidden', ...(location ? { location } : {}),
      })
      res.end('native response for ' + req.url)
    })
  })
  native.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  native.on('upgrade', (req, socket, head) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    const upgrade = { req, socket, closed: once(socket, 'close') }
    upgrade.firstFrame = new Promise(resolve => {
      let received = Buffer.from(head)
      if (received.length >= 7) resolve(received)
      socket.on('data', bytes => {
        received = Buffer.concat([received, bytes])
        if (received.length >= 7) resolve(received)
      })
    })
    upgrades.push(upgrade)
    socket.on('end', () => socket.end())
    socket.write(Buffer.concat([Buffer.from('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\nSet-Cookie: ' + NATIVE_COOKIE + '\r\nX-Private: hidden\r\n\r\n'),
    Buffer.from([0x81, 0x02, 0x4f, 0x4b])]))
  })
  const nativePort = await listen(native)
  const origin = 'http://127.0.0.1:' + nativePort
  const nativeHost = '127.0.0.1:' + nativePort
  let ctxOrigin = origin
  let rejection
  const target = createRelayTarget({
    webServer: { getOrigin: () => ctxOrigin },
    connection: {
      authenticatedUrl(url) {
        assert.equal(url, origin + '/')
        auth.push('launch')
        return url + '?token=' + LAUNCH_TOKEN
      },
      authorizeIndex(req, res) {
        assert.deepEqual(req, { method: 'GET', url: '/?token=' + LAUNCH_TOKEN, headers: { host: nativeHost } })
        auth.push('index')
        res.writeHead(303, { 'set-cookie': NATIVE_COOKIE + '; Path=/; HttpOnly', location: './' })
        res.end()
        return false
      },
      requestRejection(req) {
        assert.deepEqual(req, { headers: { host: nativeHost, cookie: NATIVE_COOKIE } })
        auth.push('verify')
        return rejection
      },
    },
  })
  let handshakes = []
  const ingress = net.createServer(stream => {
    sockets.add(stream)
    stream.on('close', () => sockets.delete(stream))
    const { lease, resolve, reject } = handshakes.shift()
    relayServerTls(stream, certificate).then(socket => resolve({ accepted: target.accept(lease.info, socket), socket }), reject)
  })
  const port = await listen(ingress)
  t.after(async () => {
    target.close()
    for (const socket of sockets) socket.destroy()
    await Promise.all([new Promise(resolve => ingress.close(resolve)), new Promise(resolve => native.close(resolve))])
  })
  async function open(lease, accepted = true) {
    const server = new Promise((resolve, reject) => handshakes.push({ lease, resolve, reject }))
    const client = relayClientTls(net.connect({ host: '127.0.0.1', port }), certificate.fingerprint)
    const [socket, admitted] = await Promise.all([client, server])
    assert.equal(admitted.accepted, accepted)
    return { socket, serverSocket: admitted.socket }
  }
  async function request(lease, method, path, { headers = {}, body = '', raw = '' } = {}) {
    const { socket } = await open(lease)
    const complete = readClosed(socket)
    const outgoing = { Host: lease.info.authority, Connection: 'close', ...headers }
    if (body && !outgoing['Transfer-Encoding']) outgoing['Content-Length'] ??= Buffer.byteLength(body)
    socket.write(method + ' ' + path + ' HTTP/1.1\r\n' + headerLines(outgoing) + raw + '\r\n' + body)
    return parseResponse((await complete).toString())
  }
  return { open, request, target, seen, auth, origin, nativeHost, upgrades,
    nativeOrigin(value) { ctxOrigin = value }, rejection(value) { rejection = value } }
}

function headerLines(headers) {
  return Object.entries(headers).filter(([, v]) => v !== null).map(([k, v]) => k + ': ' + v + '\r\n').join('')
}

function readClosed(socket) {
  const chunks = []
  socket.on('data', chunk => chunks.push(chunk))
  return once(socket, 'close').then(() => Buffer.concat(chunks))
}

function parseResponse(raw) {
  const [head] = raw.split('\r\n\r\n')
  const [status, ...lines] = head.split('\r\n')
  const headers = Object.fromEntries(lines.map(line => {
    const split = line.indexOf(':')
    return [line.slice(0, split).toLowerCase(), line.slice(split + 1).trim()]
  }))
  return { status: Number(status.split(' ')[1]), headers, raw }
}

function grantOptions(lease, headers) {
  return { body: JSON.stringify({ grant: lease.grant }), headers: { Origin: VIEWER,
    'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', ...headers } }
}

async function redeem(f, lease) {
  const entered = await f.request(lease, 'POST', ENTRY, grantOptions(lease))
  assert.equal(entered.status, 204)
  assert.equal(entered.headers['cache-control'], 'no-store')
  const issued = entered.headers['set-cookie']
  assert.match(issued, /^dsh-relay-[a-f0-9]{32}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+$/)
  assert.ok(!entered.raw.includes(NATIVE_COOKIE) && !entered.raw.includes(LAUNCH_TOKEN) && !entered.raw.includes(lease.grant))
  return issued.split(';')[0]
}

test('entry only redeems a bounded same-origin grant once, across TLS sockets', { timeout: 10_000 }, async t => {
  const f = await setup(t)
  const lease = createLease()
  const page = await f.request(lease, 'GET', ENTRY, { headers: { 'Sec-Fetch-Site': 'none' } })
  assert.equal(page.status, 200)
  assert.equal(page.headers['referrer-policy'], 'origin')
  const script = /<script>(.*?)<\/script>/.exec(page.raw)[1]
  assert.ok(page.headers['content-security-policy'].includes('sha256-' + createHash('sha256').update(script).digest('base64')))
  assert.match(script, /location\.hash\.slice\(1\).*history\.replaceState/)
  assert.match(script, /referrerPolicy:"origin"/)
  assert.match(script, /location\.replace\("\/"\)/)
  assert.equal((await f.request(lease, 'GET', ENTRY + '?rev=1')).status, 404)
  assert.equal((await f.request(lease, 'GET', '/')).status, 401)
  for (const headers of [
    { Host: 'localhost:43421' }, { Origin: 'null' }, { Origin: VIEWER + '/' }, { Origin: null },
    { Origin: 'https://' + AUTHORITY }, { Origin: 'http://127.0.0.1:43422' }, { 'Sec-Fetch-Site': 'same-site' },
  ]) {
    assert.equal((await f.request(lease, 'POST', ENTRY, grantOptions(lease, headers))).status, 403)
  }
  assert.equal((await f.request(lease, 'POST', ENTRY, { ...grantOptions(lease), raw: 'Host: ' + AUTHORITY + '\r\n' })).status, 403)
  assert.equal((await f.request(lease, 'POST', ENTRY, grantOptions({ grant: createLease().grant }))).status, 401)
  assert.equal((await f.request(lease, 'POST', ENTRY, { ...grantOptions(lease), body: 'x'.repeat(513) })).status, 413)
  assert.equal((await f.request(lease, 'POST', ENTRY, {
    ...grantOptions(lease, { 'Transfer-Encoding': 'chunked' }), body: '201\r\n' + 'x'.repeat(513) + '\r\n0\r\n\r\n',
  })).status, 413)
  assert.deepEqual(f.auth, [])
  assert.deepEqual(f.seen, [])
  const cookie = await redeem(f, lease)
  assert.deepEqual(f.auth, ['launch', 'index', 'verify'])
  assert.equal((await f.request(lease, 'POST', ENTRY, grantOptions(lease))).status, 401)
  const other = createLease()
  assert.equal((await f.request(other, 'GET', '/', { headers: { Cookie: cookie } })).status, 401)
  assert.notEqual((await redeem(f, other)).split('=')[0], cookie.split('=')[0])
  const simultaneous = createLease()
  const results = await Promise.all([1, 2].map(() => f.request(simultaneous, 'POST', ENTRY, grantOptions(simultaneous))))
  assert.deepEqual(results.map(x => x.status).sort(), [204, 401])
})

test('proxy uses only the physical origin, preserves native assets and strips credentials and hop headers', { timeout: 10_000 }, async t => {
  const f = await setup(t)
  const lease = createLease()
  const Cookie = await redeem(f, lease)
  const request = (path, options) => f.request(lease, options?.method ?? 'GET', path, {
    ...options, headers: { Cookie, ...options?.headers },
  })
  for (const path of ['/', '/assets/chunk.js', '/plugins/@deepseek-ai/sample/client.js?rev=42',
    '/plugins/??@deepseek-ai/sample/client.js,unscoped/client.js&rev=42']) {
    const reply = await request(path)
    assert.equal(reply.status, 200)
    assert.ok(reply.raw.includes('native response for ' + path))
    assert.equal(reply.headers['cache-control'], 'no-store')
    assert.equal(reply.headers['set-cookie'], undefined)
    assert.equal(reply.headers['access-control-allow-origin'], undefined)
    assert.equal(reply.headers['x-upstream-hop'], undefined)
    assert.ok(!reply.raw.includes(NATIVE_COOKIE) && !reply.raw.includes(LAUNCH_TOKEN))
  }
  assert.equal((await request('/assets/chunk.js', { method: 'HEAD' })).status, 200)
  const body = JSON.stringify({ example: 'native request' })
  const result = await request('/api/example?version=1', { method: 'POST', body,
    headers: { Origin: VIEWER, Cookie: Cookie + '; evil=client-secret', 'Content-Type': 'application/json',
      Authorization: 'Bearer attacker', 'Proxy-Authorization': 'secret', 'X-Forwarded-Host': 'elsewhere',
      'X-Forwarded-Proto': 'https', Forwarded: 'host=elsewhere', 'X-DSH-Auth-Token': 'client-token',
      Connection: 'close, accept-language', 'Accept-Language': 'secret', 'Sec-Fetch-Site': 'same-origin' },
  })
  assert.equal(result.status, 200)
  const recent = f.seen.at(-1)
  assert.equal(recent.headers.host, f.nativeHost)
  assert.equal(recent.headers.origin, f.origin)
  assert.equal(recent.headers.cookie, NATIVE_COOKIE)
  assert.equal(recent.headers['content-type'], 'application/json')
  for (const name of ['authorization', 'proxy-authorization', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded',
    'accept-language', 'x-dsh-auth-token', 'sec-fetch-site']) assert.equal(recent.headers[name], undefined)
  assert.equal(recent.body, body)
  const before = f.seen.length
  const redirect = await request('/redirect')
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.location, '/assets/chunk.js')
  assert.equal(f.seen.length, before + 1)
  const privateRedirect = await request('/private-redirect')
  assert.equal(privateRedirect.status, 302)
  assert.equal(privateRedirect.headers.location, undefined)
  assert.ok(!privateRedirect.raw.includes(LAUNCH_TOKEN))
  f.nativeOrigin(f.origin.endsWith(':1') ? 'http://127.0.0.1:2' : 'http://127.0.0.1:1')
  const seen = f.seen.length
  assert.equal((await request('/')).status, 502)
  assert.equal(f.seen.length, seen)
  f.nativeOrigin('http://192.0.2.1:8000')
  const untrusted = createLease()
  const exchanges = f.auth.length
  assert.equal((await f.request(untrusted, 'POST', ENTRY, grantOptions(untrusted))).status, 502)
  assert.equal(f.auth.length, exchanges)
  f.nativeOrigin(f.origin)
  f.rejection(403)
  assert.equal((await f.request(untrusted, 'POST', ENTRY, grantOptions(untrusted))).status, 502)
  assert.equal((await f.request(untrusted, 'GET', '/')).status, 401)
})

test('rejects unsafe targets, control routes and cross-origin browser traffic without touching DSH', { timeout: 10_000 }, async t => {
  const f = await setup(t)
  const lease = createLease()
  const Cookie = await redeem(f, lease)
  for (const path of ['/api/cross-device', '/API/cross-device/web/identity', '/api/%63ross-device/web/open',
    '/dsh-bridge-google/foo', '/connect', '/dsh-bridge-enter', ENTRY + '/foo', MUX]) {
    assert.equal((await f.request(lease, 'GET', path, { headers: { Cookie } })).status, 404, path)
  }
  for (const path of ['http://example.invalid/', '//example.invalid/', '/api//remote.mux', '/api/../connect',
    '/api/%2e%2e/connect', '/%2563onnect', '/api%2fcross-device', '/api/%5ccross-device', '/api;v/cross-device',
    '/?token=unsafe', '/?%74oken=unsafe', '/?TOKEN=unsafe', '/?rev=1;token=unsafe', '/?grant=unsafe']) {
    assert.equal((await f.request(lease, 'GET', path, { headers: { Cookie } })).status, 400, path)
  }
  for (const [method, path, headers, status] of [
    ['PATCH', '/', {}, 405], ['CONNECT', 'example.invalid:443', {}, 405],
    ['GET', '/', { Cookie: Cookie + '; ' + Cookie }, 401], ['GET', '/api/example', { 'Sec-Fetch-Site': 'same-site' }, 403],
    ['POST', '/', { 'Sec-Fetch-Site': 'cross-site' }, 403], ['GET', '/', { Origin: VIEWER + '/path' }, 403],
    ['GET', '/', { Host: 'example.invalid' }, 403], ['GET', '/', { Connection: 'close, cookie' }, 400],
  ]) assert.equal((await f.request(lease, method, path, { headers: { Cookie, ...headers } })).status, status)
  assert.deepEqual(f.seen, [])
})

test('upgrades only the authenticated native mux and closes both peers on target close or expiry', { timeout: 10_000 }, async t => {
  const f = await setup(t)
  const lease = createLease()
  const cookie = await redeem(f, lease)
  const headers = { Host: AUTHORITY, Origin: VIEWER, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie,
    Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': KEY, 'Sec-WebSocket-Version': '13',
    Authorization: 'Bearer visitor', 'X-Forwarded-Host': 'untrusted', 'Sec-WebSocket-Unsafe': 'untrusted',
  }
  for (const [path, changes, status] of [
    [MUX, { Cookie: null }, 401], [MUX, { Origin: 'http://127.0.0.1:44444' }, 403],
    [MUX, { 'Sec-Fetch-Site': 'same-site' }, 403], [MUX + '?rev=1', {}, 404], ['/api/other', {}, 404],
    [MUX, { 'Sec-WebSocket-Key': 'bad' }, 400],
  ]) {
    const resp = await f.request(lease, 'GET', path, { headers: { ...headers, ...changes } })
    assert.equal(resp.status, status)
  }
  assert.equal(f.upgrades.length, 0)

  async function upgrade(lease, cookie) {
    const { socket, serverSocket } = await f.open(lease)
    const frame = Buffer.from([0x81, 0x81, 0x21, 0x24, 0x55, 0x12, 0x40])
    const handshake = new Promise((resolve, reject) => {
      let data = Buffer.alloc(0)
      socket.on('data', chunk => {
        data = Buffer.concat([data, chunk])
        const split = data.indexOf('\r\n\r\n')
        if (split !== -1 && data.length >= split + 8) resolve(data)
      })
      socket.once('error', reject)
    })
    socket.write(Buffer.concat([Buffer.from('GET ' + MUX + ' HTTP/1.1\r\n' + headerLines({ ...headers, Cookie: cookie }) + '\r\n'), frame]))
    const packet = await handshake
    const reply = parseResponse(packet.toString())
    const peer = f.upgrades.at(-1)
    assert.equal(reply.status, 101)
    assert.equal(reply.headers['set-cookie'], undefined)
    assert.equal(reply.headers['x-private'], undefined)
    assert.deepEqual(packet.subarray(-4), Buffer.from([0x81, 0x02, 0x4f, 0x4b]))
    assert.deepEqual(await peer.firstFrame, frame)
    assert.equal(peer.req.url, MUX)
    assert.equal(peer.req.headers.host, f.nativeHost)
    assert.equal(peer.req.headers.origin, f.origin)
    assert.equal(peer.req.headers.cookie, NATIVE_COOKIE)
    for (const header of ['authorization', 'x-forwarded-host', 'sec-websocket-unsafe']) {
      assert.equal(peer.req.headers[header], undefined)
    }
    return { serverSocket, closed: Promise.all([once(socket, 'close'), peer.closed]) }
  }

  const short = createLease({ expires_at: Date.now() + 900 })
  const shortMux = await upgrade(short, await redeem(f, short))
  await shortMux.closed
  await f.open(short, false)
  const mux = await upgrade(lease, cookie)
  const { socket: idle, serverSocket } = await f.open(lease)
  const idleClosed = readClosed(idle)
  f.target.close()
  assert.ok(mux.serverSocket.destroyed && serverSocket.destroyed)
  await Promise.all([mux.closed, idleClosed])
  await f.open(lease, false)
})

test('lease rejects changed metadata and a lifetime over 30 minutes', { timeout: 10_000 }, async t => {
  const f = await setup(t)
  const lease = createLease()
  await redeem(f, lease)
  for (const changes of [{ authority: '127.0.0.1:43422' }, { authority: 'localhost:43421' },
    { expires_at: lease.info.expires_at + 100 }, { grant_hash: createLease().info.grant_hash }]) {
    await f.open({ ...lease, info: { ...lease.info, ...changes } }, false)
  }
  await f.open(createLease({ expires_at: Date.now() + 31 * 60_000 }), false)
})
