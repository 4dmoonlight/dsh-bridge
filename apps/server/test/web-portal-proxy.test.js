import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { Duplex, PassThrough } from 'node:stream';
import test from 'node:test';
import { createPortalProxy } from '../src/web-portal-proxy.js';
import { createRelayTarget } from '../../../packages/dsh-cross-device/lib/relay-target.js';
import { createRelayCertificate, relayServerTls } from '../../../packages/dsh-cross-device/lib/relay-transport.js';

const ENTRY = '/dsh-relay-enter';
const MUX = '/api/remote.mux';
const AUTHORITY = 'a'.repeat(32) + '.dsh-relay.localhost:3080';
const ORIGIN = 'https://fixture.portal.example';
const HOST = new URL(ORIGIN).host;
const GRANT = randomBytes(32).toString('base64url');
const PAIR = 'dsh-relay-' + 'b'.repeat(32) + '=' + randomBytes(32).toString('base64url');
const COOKIE = PAIR + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800';
const KEY = randomBytes(16).toString('base64');
const ACCEPT = createHash('sha1').update(KEY + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
const CLIENT_FRAME = Buffer.from([0x81, 0x81, 1, 2, 3, 4, 0x76]);
const TARGET_FRAME = Buffer.from([0x81, 0x02, 0x4f, 0x4b]);
let certPromise;

function rawPair() {
  const a = new PassThrough();
  const b = new PassThrough();
  return [Duplex.from({ readable: a, writable: b }), Duplex.from({ readable: b, writable: a })];
}

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  }));
  return server.address().port;
}

async function fixture(t, options = {}) {
  const externalOrigin = options.externalOrigin ?? ORIGIN;
  const externalHost = new URL(externalOrigin).host;
  const certificate = await (certPromise ??= createRelayCertificate());
  const seen = [];
  const wires = [];
  const ws = [];
  const pending = [];
  let current = 0;
  let peak = 0;
  const target = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const row = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
    seen.push(row);
    if (options.onRequest) return options.onRequest(req, res, row);
    if (req.url === ENTRY) {
      const { status = 204, cookies = COOKIE } = options.entry ?? {};
      const headers = cookies ? { 'set-cookie': cookies } : {};
      res.writeHead(status, headers).end();
    } else if (req.url.startsWith('/assets/redirect')) {
      const location = new URL(req.url, ORIGIN).searchParams.get('location');
      res.writeHead(302, location ? { location } : {}).end();
    } else if (req.url === '/assets/large.js') {
      const body = 'x'.repeat(3 * 1024 * 1024 + 100);
      res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': body.length }).end(body);
    } else if (req.url === '/assets/hold') {
      pending.push(res);
      options.onHold?.(pending.length);
    } else {
      res.writeHead(200, {
        'content-type': 'text/plain', 'cache-control': 'public, max-age=10000', expires: 'untrusted',
        'set-cookie': COOKIE, 'set-cookie2': PAIR, refresh: '0; url=https://example.invalid',
        'content-security-policy': 'sandbox', 'access-control-allow-origin': '*',
        connection: 'close, content-disposition', 'content-disposition': 'inline', 'x-internal-details': PAIR,
      }).end('fixture:' + req.url);
    }
  });
  target.on('upgrade', (req, socket, head) => {
    const row = { req, socket, bytes: Buffer.from(head) };
    ws.push(row);
    socket.on('data', bytes => { row.bytes = Buffer.concat([row.bytes, bytes]); socket.write(bytes); });
    const headers = 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
      'Sec-WebSocket-Accept: ' + (options.accept ?? ACCEPT) + '\r\nSet-Cookie: ' + COOKIE + '\r\n\r\n';
    socket.write(Buffer.concat([Buffer.from(headers), TARGET_FRAME]));
    if (head.length) socket.write(head);
  });
  const proxy = createPortalProxy({ authority: AUTHORITY, externalOrigin, grant: GRANT,
    fingerprint: options.fingerprint ?? certificate.fingerprint,
    connectStream: options.connectStream ?? (async signal => {
      const [client, server] = rawPair();
      const wire = { client, server, signal, ciphertext: [] };
      wires.push(wire);
      current++;
      peak = Math.max(peak, current);
      client.once('close', () => current--);
      // Observe the client-to-target wire, not TLS application data.
      server.on('data', chunk => wire.ciphertext.push(chunk));
      relayServerTls(server, certificate).then(socket => {
        if (options.admit) options.admit(socket);
        else {
          target.emit('connection', socket);
          socket.resume();
        }
      }, () => {});
      return client;
    }),
  });
  t.after(() => {
    proxy.close();
    for (const { client, server } of wires) { client.destroy(); server.destroy(); }
  });
  const browser = http.createServer(proxy.request);
  browser.on('upgrade', proxy.upgrade);
  const port = await listen(t, browser);
  function request(path, { method = 'GET', headers = {}, body, chunks } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method, agent: false, headers: { host: externalHost, ...headers } }, res => {
        const output = [];
        res.on('data', chunk => output.push(chunk));
        res.on('error', reject);
        res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(output).toString() }));
      });
      req.on('error', reject);
      for (const chunk of chunks ?? []) req.write(chunk);
      req.end(body);
    });
  }
  function raw(method, path, headers, head = Buffer.alloc(0)) {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('error', () => socket.destroy());
    const pieces = [];
    socket.on('data', data => pieces.push(data));
    const complete = once(socket, 'close').then(() => Buffer.concat(pieces));
    socket.write(Buffer.concat([Buffer.from(method + ' ' + path + ' HTTP/1.1\r\n' +
      Object.entries({ Host: externalHost, Connection: 'close', ...headers }).filter(([, v]) => v !== null)
        .map(([name, v]) => name + ': ' + v + '\r\n').join('') + '\r\n'), head]));
    return { socket, complete, async until(predicate) {
      while (!predicate(Buffer.concat(pieces))) await Promise.race([once(socket, 'data'), complete.then(() => {
        throw Error('Socket closed before expected bytes');
      })]);
      return Buffer.concat(pieces);
    } };
  }
  return { proxy, seen, wires, ws, pending, peak: () => peak, request, raw };
}

function wsHeaders(overrides) {
  return { Connection: 'Upgrade', Upgrade: 'websocket', Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin',
    'Sec-WebSocket-Key': KEY, 'Sec-WebSocket-Version': '13', ...overrides };
}

test('activates once over TLS and proxies native boot, assets and API without browser credentials', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/')).status, 503);
  assert.equal(f.wires.length, 0);
  const activation = f.proxy.activate();
  assert.equal(f.proxy.activate(), activation);
  assert.equal(await activation, undefined);
  await f.proxy.activate();
  assert.equal(f.seen.length, 1);
  const [entry] = f.seen;
  assert.equal(entry.method, 'POST');
  assert.equal(entry.url, ENTRY);
  assert.equal(entry.headers.host, AUTHORITY);
  assert.equal(entry.headers.origin, 'http://' + AUTHORITY);
  assert.equal(entry.headers.cookie, undefined);
  assert.deepEqual(JSON.parse(entry.body), { grant: GRANT });
  assert.ok(f.wires[0].ciphertext.length);
  assert.equal(Buffer.concat(f.wires[0].ciphertext).includes(GRANT), false);
  const root = await f.request('/');
  assert.equal(root.status, 200);
  assert.equal(root.headers['content-security-policy'], 'sandbox');
  assert.equal(root.headers['content-type'], 'text/plain');
  assert.equal(root.headers['cache-control'], 'no-store');
  assert.equal(root.headers['referrer-policy'], 'same-origin');
  for (const name of ['set-cookie', 'set-cookie2', 'refresh', 'expires', 'content-disposition',
    'access-control-allow-origin', 'x-internal-details']) assert.equal(root.headers[name], undefined, name);
  const raw = '/plugins/??@deepseek-ai/dsh-client-modules/client.js,@scope/plugin/client.js&rev=deadbeef';
  assert.equal((await f.request(raw, { headers: { Cookie: 'portal=viewer', authorization: 'Bearer untrusted',
    'x-forwarded-host': 'example.invalid', 'x-original-url': '/connect', referer: ORIGIN + '/private',
    accept: '*/*', 'if-none-match': '"value"', connection: 'close, accept' } })).body, 'fixture:' + raw);
  const last = f.seen.at(-1);
  assert.equal(last.url, raw);
  assert.equal(last.headers.host, AUTHORITY);
  assert.equal(last.headers.cookie, PAIR);
  for (const name of ['authorization', 'referer', 'x-forwarded-host', 'x-original-url', 'accept', 'origin']) {
    assert.equal(last.headers[name], undefined, name);
  }
  assert.equal(last.headers['if-none-match'], '"value"');
  assert.equal((await f.request('/assets/index.js', { method: 'HEAD' })).body, '');
  assert.equal((await f.request('/api/file?path=%2Ftmp%2Fa', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
  assert.equal((await f.request('/api/session/list', { method: 'POST', headers: { origin: ORIGIN,
    'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, chunks: ['{"hello":', 'true}'] })).status, 200);
  assert.equal(f.seen.at(-1).body, '{"hello":true}');
  assert.equal(f.seen.at(-1).headers.origin, 'http://' + AUTHORITY);
  assert.equal(f.seen.at(-1).headers['sec-fetch-site'], undefined);
  assert.equal(f.seen.at(-1).headers.cookie, PAIR);
  assert.equal((await f.request('/api/session/uploadFileBinary?sessionId=abc', { method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/octet-stream' }, body: 'fixture binary' })).status, 200);
  assert.equal(f.seen.at(-1).body, 'fixture binary');
});

test('streams a multi-megabyte native JS response without truncation', async t => {
  const f = await fixture(t);
  await f.proxy.activate();
  const reply = await f.request('/assets/large.js');
  assert.equal(reply.status, 200);
  assert.equal(reply.body.length, 3 * 1024 * 1024 + 100);
  assert.equal(Number(reply.headers['content-length']), reply.body.length);
  assert.equal(reply.body, 'x'.repeat(reply.body.length));
});

test('uses the real relay target to exchange only the synthetic cookie for native web boot', async t => {
  const nativeCookie = 'dsh-native=signed.fixture';
  const recorded = [];
  const native = http.createServer((req, res) => {
    recorded.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': nativeCookie }).end('<script>window.__DSH_BOOT__=[]</script>');
  });
  const nativeOrigin = 'http://127.0.0.1:' + await listen(t, native);
  const target = createRelayTarget({ webServer: { getOrigin: () => nativeOrigin }, connection: {
    authenticatedUrl: url => url + '?token=fixture-native-token',
    authorizeIndex(_req, res) { res.writeHead(303, { 'set-cookie': nativeCookie }); res.end(); },
    requestRejection: req => req.headers.cookie === nativeCookie ? undefined : 401,
  } });
  t.after(() => target.close());
  const info = { lease_id: 'fixture-lease', authority: AUTHORITY, expires_at: Date.now() + 60_000,
    grant_hash: createHash('sha256').update(Buffer.from(GRANT, 'base64url')).digest('base64url') };
  const f = await fixture(t, { admit: socket => target.accept(info, socket) });
  await f.proxy.activate();
  const res = await f.request('/', { headers: { cookie: 'portal=viewer' } });
  assert.match(res.body, /window\.__DSH_BOOT__/);
  assert.equal(res.headers['set-cookie'], undefined);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].url, '/');
  assert.equal(recorded[0].headers.cookie, nativeCookie);
});

test('rejects unpinned certificates without transmitting an activation', async t => {
  const f = await fixture(t, { fingerprint: '0'.repeat(64) });
  await assert.rejects(f.proxy.activate(), { message: 'Portal target unavailable', status: 502 });
  await assert.rejects(f.proxy.activate(), { status: 502 });
  assert.equal(f.wires.length, 1);
  assert.equal(f.seen.length, 0);
  const { client, server, ciphertext } = f.wires[0];
  if (!client.closed) await once(client, 'close');
  if (!server.closed) await once(server, 'close');
  assert.equal(Buffer.concat(ciphertext).includes(GRANT), false);
  assert.equal((await f.request('/')).status, 503);
});

test('rejects a pinned certificate outside its validity period', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2200-01-01') });
  await assert.rejects(f.proxy.activate(), { status: 502 });
  assert.equal(f.seen.length, 0);
});

test('times out a silent TLS peer and destroys its transport', async t => {
  let opened;
  const opening = new Promise(resolve => { opened = resolve; });
  const [client, target] = rawPair();
  target.on('error', () => {});
  t.after(() => target.destroy());
  const f = await fixture(t, { connectStream(signal) { opened(signal); return client; } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const destroyed = new Promise(resolve => client.once('close', resolve));
  const activation = f.proxy.activate();
  const observed = assert.rejects(activation, { status: 504 });
  const signal = await opening;
  t.mock.timers.tick(8000);
  await observed;
  await destroyed;
  assert.ok(signal.aborted);
  assert.equal(f.seen.length, 0);
});

test('requires exactly the plugin 204 session cookie and never retries the grant', async t => {
  const cases = [
    { status: 200 }, { cookies: null }, { cookies: [COOKIE, COOKIE] },
    { cookies: COOKIE + '; Domain=.portal.example' }, { cookies: COOKIE.replace('SameSite=Strict', 'SameSite=Lax') },
    { cookies: COOKIE.replace('Max-Age=1800', 'Max-Age=1801') },
    { cookies: COOKIE.replace(/=([A-Za-z0-9_-]{42}).;/, '=$1Z;') },
  ];
  for (const entry of cases) {
    const f = await fixture(t, { entry });
    await assert.rejects(f.proxy.activate(), { status: 502 });
    await assert.rejects(f.proxy.activate(), { status: 502 });
    assert.equal(f.seen.length, 1);
    assert.equal((await f.request('/')).status, 503);
  }
});

test('rejects routes and cross-origin traffic before opening any target stream', async t => {
  const f = await fixture(t);
  await f.proxy.activate();
  for (const [path, status] of [
    ['//other.example/assets/a', 400], ['http://other.example/assets/a', 400], ['/assets/../index.html', 400],
    ['/assets/%2e%2e/index.html', 400], ['/assets/%252e%252e%252findex.html', 400], ['/assets/a%2fb', 400],
    ['/assets/a%5cb', 400], ['/assets/a#x', 400], ['/assets/a?%67rant=x', 400], ['/?t%6fken=x', 400],
    ['/assets/a?bad=%', 400], ['/assets/a?bad;x=1', 400], ['/api/cross-device/web', 404],
    ['/api/%63ross-device/web', 404], ['/dsh-bridge-google', 404], ['/connect', 404], [ENTRY, 404],
    [MUX, 404], ['/api/arbitrary', 404], ['/foo', 404],
  ]) assert.equal((await f.request(path)).status, status, path);
  for (const path of ['/api/cross-device/open', '/api/Google/oauth', '/api/v1/web', '/api/session/list/other', '/assets/index.js']) {
    assert.equal((await f.request(path, { method: 'POST', headers: { origin: ORIGIN } })).status, 404, path);
  }
  assert.equal((await f.request('/', { method: 'PUT' })).status, 405);
  assert.equal((await f.request('/', { headers: { host: 'wrong.portal.example' } })).status, 403);
  assert.equal((await f.request('/', { headers: { origin: 'null' } })).status, 403);
  assert.equal((await f.request('/api/file')).status, 403);
  assert.equal((await f.request('/api/file', { headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
  assert.equal((await f.request('/api/session/list', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })).status, 403);
  assert.equal((await f.request('/api/session/list', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await f.request('/api/session/list', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'text/html' } })).status, 415);
  for (const [headers, status] of [
    [{ Host: HOST + '\r\nHost: wrong.portal.example' }, 403], [{ Origin: ORIGIN + '\r\nOrigin: ' + ORIGIN }, 403],
    [{ Connection: 'close, origin' }, 400], [{ 'Content-Length': '1' }, 400],
  ]) assert.match((await f.raw('GET', '/', headers).complete).toString(), new RegExp('^HTTP/1.1 ' + status));
  assert.equal(f.wires.length, 1);
});

test('pins external :8443 for HTTP and WebSocket without changing synthetic authority', async t => {
  const externalOrigin = ORIGIN + ':8443';
  const f = await fixture(t, { externalOrigin });
  await f.proxy.activate();
  for (const headers of [
    { host: HOST, origin: externalOrigin }, { host: HOST + ':443', origin: externalOrigin },
    { host: HOST + ':08443', origin: externalOrigin }, { origin: ORIGIN }, { origin: ORIGIN + ':08443' },
  ]) assert.equal((await f.request('/api/session/list', { method: 'POST', headers })).status, 403);
  for (const headers of [wsHeaders(), wsHeaders({ Host: HOST, Origin: externalOrigin })]) {
    assert.match((await f.raw('GET', MUX, headers).complete).toString(), /^HTTP\/1.1 403/);
  }
  assert.equal(f.wires.length, 1);

  assert.equal((await f.request('/api/session/list', { method: 'POST', headers: { origin: externalOrigin, 'content-type': 'application/json' }, body: '{}' })).status, 200);
  assert.equal(f.seen.at(-1).headers.host, AUTHORITY);
  assert.equal(f.seen.at(-1).headers.origin, 'http://' + AUTHORITY);
  const browser = f.raw('GET', MUX, wsHeaders({ Origin: externalOrigin }));
  assert.match((await browser.until(bytes => bytes.includes(TARGET_FRAME))).toString(), /^HTTP\/1.1 101/);
  assert.equal(f.ws[0].req.headers.host, AUTHORITY);
  assert.equal(f.ws[0].req.headers.origin, 'http://' + AUTHORITY);
  f.proxy.close();
  await browser.complete;
});

test('only passes redirects to safe root-relative native routes', async t => {
  const f = await fixture(t);
  await f.proxy.activate();
  for (const path of ['/assets/index.js', '/api/file?path=%2Ftmp%2Fa', 'https://example.invalid/',
    'http://' + AUTHORITY + '/assets/a', '//example.invalid/', '/?token=leaked', '/dsh-bridge-enter',
    '/api/cross-device/web', '/assets/%2Fexample.invalid']) {
    const reply = await f.request('/assets/redirect?location=' + encodeURIComponent(path));
    assert.equal(reply.status, 302);
    assert.equal(reply.headers.location, ['/assets/index.js', '/api/file?path=%2Ftmp%2Fa'].includes(path) ? path : undefined);
  }
});

test('only proxies an exact authenticated mux upgrade and validates the target handshake', async t => {
  const f = await fixture(t);
  await f.proxy.activate();
  for (const [path, headers, status] of [
    [MUX + '?query', wsHeaders(), 404], [MUX, wsHeaders({ Origin: null }), 403],
    [MUX, wsHeaders({ 'Sec-Fetch-Site': 'same-site' }), 403],
    [MUX, wsHeaders({ 'Sec-WebSocket-Key': 'bad' }), 400],
    [MUX, wsHeaders({ 'Sec-WebSocket-Protocol': 'unknown' }), 400],
  ]) assert.match((await f.raw('GET', path, headers).complete).toString(), new RegExp('^HTTP/1.1 ' + status));
  assert.equal(f.wires.length, 1);
  const browser = f.raw('GET', MUX, wsHeaders({ Cookie: 'portal=external', 'Sec-WebSocket-Extensions': 'permessage-deflate' }), CLIENT_FRAME);
  const all = await browser.until(bytes => bytes.includes(Buffer.concat([TARGET_FRAME, CLIENT_FRAME])));
  const headers = all.subarray(0, all.indexOf('\r\n\r\n')).toString();
  assert.match(headers, /^HTTP\/1.1 101 Switching Protocols/);
  assert.ok(headers.includes('Sec-WebSocket-Accept: ' + ACCEPT));
  assert.doesNotMatch(headers, /set-cookie|sec-websocket-extensions|dsh-relay-/i);
  assert.deepEqual(f.ws[0].bytes, CLIENT_FRAME);
  assert.equal(f.ws[0].req.headers.host, AUTHORITY);
  assert.equal(f.ws[0].req.headers.origin, 'http://' + AUTHORITY);
  assert.equal(f.ws[0].req.headers.cookie, PAIR);
  assert.equal(f.ws[0].req.headers['sec-websocket-extensions'], undefined);
  f.proxy.close();
  await browser.complete;
  const peer = f.ws[0].socket;
  if (!peer.closed) await once(peer, 'close');

  const bad = await fixture(t, { accept: 'bad-accept' });
  await bad.proxy.activate();
  assert.match((await bad.raw('GET', MUX, wsHeaders()).complete).toString(), /^HTTP\/1.1 502 Bad Gateway/);
});

test('bounds pending streams and tears down work on close, including a late connector', async t => {
  let full;
  const held = new Promise(resolve => { full = resolve; });
  const f = await fixture(t, { onHold(count) { if (count === 6) full(); } });
  await f.proxy.activate();
  const batch = Array.from({ length: 9 }, () => f.request('/assets/hold'));
  await held;
  assert.equal(f.peak(), 6);
  assert.equal(f.pending.length, 6);
  f.pending[0].end('first');
  assert.equal((await Promise.race(batch)).body, 'first');
  f.proxy.close();
  assert.equal((await Promise.all(batch)).filter(result => result.status === 503).length, 8);
  assert.equal(f.peak(), 6);

  let resolveStream;
  let started;
  const connecting = new Promise(resolve => { started = resolve; });
  const late = await fixture(t, { connectStream(signal) {
    started(signal);
    return new Promise(resolve => { resolveStream = resolve; });
  } });
  const activation = late.proxy.activate();
  const signal = await connecting;
  late.proxy.close();
  await assert.rejects(activation, { status: 503 });
  assert.ok(signal.aborted);
  const [a, b] = rawPair();
  b.on('error', () => {});
  const destroyed = new Promise(resolve => a.once('close', resolve));
  resolveStream(a);
  await destroyed;
  b.destroy();
});
