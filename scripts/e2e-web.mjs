#!/usr/bin/env node
/** Start two throwaway DSH Web profiles and a loopback Hub; no real profile or sessions. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { createHubApp } from '../apps/server/src/app.js';
import { call, INSTANCE_TOKEN } from '../apps/server/test/helpers.js';

const exec = promisify(execFile);
const dsh = process.env.DSH_BIN || 'dsh';
const pluginDir = fileURLToPath(new URL('../packages/dsh-cross-device/', import.meta.url));
const localApi = '/api/cross-device/web';
const temp = await mkdtemp(join(tmpdir(), 'bridge-web-e2e-'));
const children = [];
let hub;

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

// Synthetic Google issuer for the two-host smoke test: the Hub still validates
// a real RSA signature, state, nonces and PKCE; this cannot contact Google.
async function startGoogleHub() {
  const origin = 'http://127.0.0.1:' + await freePort();
  const redirectUri = origin + '/api/v1/web/google/callback';
  const email = 'bridge-fixture@example.test';
  const clientId = 'bridge-fixture.apps.googleusercontent.com';
  const clientSecret = 'fixture-only-secret';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const codes = new Map();
  const key = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  async function fakeGoogle(url, init) {
    switch (String(url)) {
      case 'https://www.googleapis.com/oauth2/v3/certs':
        return Response.json({ keys: [key] }, { headers: { 'cache-control': 'public, max-age=600' } });
      case 'https://oauth2.googleapis.com/token': {
        const body = new URLSearchParams(init.body);
        assert.equal(body.get('client_secret'), clientSecret);
        assert.equal(body.get('client_id'), clientId);
        assert.equal(body.get('redirect_uri'), redirectUri);
        const code = codes.get(body.get('code'));
        assert.ok(code, 'fixture must authorize the exchanged code once');
        codes.delete(body.get('code'));
        assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), code.get('code_challenge'));
        const now = Math.floor(Date.now() / 1000);
        const jwt = b64({ alg: 'RS256', kid: key.kid, typ: 'JWT' }) + '.' + b64({
          iss: 'https://accounts.google.com', aud: clientId, azp: clientId, sub: 'bridge-test-user',
          iat: now, exp: now + 300, nonce: code.get('nonce'), email, email_verified: true,
        });
        return Response.json({ id_token: jwt + '.' + sign('RSA-SHA256', Buffer.from(jwt), privateKey).toString('base64url') });
      }
      default:
        throw new Error('Unexpected issuer request');
    }
  }
  const app = await createHubApp({
    dataDir: join(temp, 'hub'), instanceToken: INSTANCE_TOKEN, logger: { info() {}, error() {} },
    google: {
      clientId, clientSecret, redirectUri, allowedEmails: [email], fetch: fakeGoogle,
    },
  });
  await app.listen(Number(new URL(origin).port), '127.0.0.1');
  return { url: origin, stop: () => app.close(), authorize(state) {
    const code = randomBytes(16).toString('base64url');
    codes.set(code, state);
    return redirectUri + '?code=' + code + '&state=' + state.get('state');
  } };
}

async function startDsh(name) {
  const home = join(temp, name);
  await mkdir(home);
  const dshHome = join(home, '.dsh');
  const env = { PATH: process.env.PATH, HOME: home, DSH_HOME: dshHome, TMPDIR: home };
  const profile = join(dshHome, 'profiles', 'web');
  await exec(dsh, ['web', '--dump-default-config'], { env, cwd: home, timeout: 20_000 });
  await cp(pluginDir, join(profile, 'node_modules', 'dsh-cross-device'), { recursive: true });
  const overlay = join(home, 'bridge-test.patch.yml');
  await writeFile(overlay, '- insert:\n    - id: dsh-cross-device\n      name: dsh-cross-device\n');
  const dir = join(dshHome, 'cross-device');
  await mkdir(dir, { mode: 0o700 });
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    device_name: name, device_id: 'sync-' + name, enabled: false, hub_url: hub.url,
  }), { mode: 0o600 });

  const port = await freePort();
  const authority = '127.0.0.1:' + port;
  const origin = 'http://' + authority;
  const child = spawn(dsh, ['web', '--patch', overlay, '--no-open', '--host', '127.0.0.1', '--port', String(port)],
    { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-3200); });
  const launchPath = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(name + ': DSH did not become ready')), 25_000);
    timer.unref();
    const fail = () => {
      clearTimeout(timer);
      const redacted = diagnostic.replace(/([?&]token=)[^&\s]+/g, '$1[redacted]');
      reject(new Error(name + ': DSH failed to launch\n' + redacted));
    };
    child.once('error', fail);
    child.once('exit', fail);
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const match = /^dsh web: (http:\/\/127\.0\.0\.1:[^\s]+)\s*$/m.exec(buffer);
      if (!match || !buffer.endsWith('\n')) return;
      clearTimeout(timer);
      child.stdout.removeAllListeners('data');
      child.stdout.resume();
      const url = new URL(match[1]);
      resolve(url.pathname + url.search);
    });
  });
  return { port, authority, origin, launchPath, configPath };
}

function http(device, path, { method = 'GET', cookie, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      hostname: '127.0.0.1', port: device.port, path, method, headers: {
        host: device.authority, ...(cookie ? { cookie } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, res => {
      res.setEncoding('utf8');
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error('DSH request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

async function login(device) {
  const response = await http(device, device.launchPath);
  assert.equal(response.status, 303, 'DSH native launch must redirect');
  return response.headers['set-cookie'][0].split(';', 1)[0];
}

function openMux(device, cookie) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: device.port, path: '/api/remote.mux', headers: {
      host: device.authority, origin: device.origin, cookie,
      connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'),
    } });
    req.once('upgrade', (res, socket) => { socket.on('error', () => {}); socket.resume(); resolve({ status: res.statusCode, socket }); });
    req.once('response', res => { res.resume(); resolve({ status: res.statusCode }); });
    req.setTimeout(10_000, () => req.destroy(new Error('DSH WebSocket handshake timed out')));
    req.once('error', reject);
    req.end();
  });
}

function api(device, cookie, path, body) {
  return http(device, localApi + path, {
    method: body === undefined ? 'GET' : 'POST', cookie, body,
    headers: { 'x-cross-device': '1', origin: device.origin },
  });
}

function ok(reply) {
  assert.equal(reply.status, 200, 'DSH plugin request failed: ' + reply.text);
  return JSON.parse(reply.text);
}

async function googleLogin(device, nativeCookie) {
  const started = await api(device, nativeCookie, '/google/start', { hub_url: hub.url });
  const answer = ok(started);
  assert.deepEqual(Object.keys(answer), ['authorization_url']);
  const state = new URL(answer.authorization_url).searchParams;
  assert.equal(state.get('redirect_uri'), hub.url + '/api/v1/web/google/callback');
  const flowCookie = started.headers['set-cookie'][0].split(';', 1)[0];
  const callback = await fetch(hub.authorize(state), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  assert.equal(callback.status, 303, 'signed test identity should be accepted');
  const handoff = new URL(callback.headers.get('location'));
  assert.equal(handoff.origin, device.origin);
  assert.equal(handoff.pathname, '/dsh-bridge-google');
  assert.equal(handoff.search, '');
  const html = await http(device, handoff.pathname);
  assert.equal(html.status, 200);
  const payload = Object.fromEntries(new URLSearchParams(handoff.hash.slice(1)));
  assert.equal((await api(device, nativeCookie, '/google/complete', payload)).status, 403, 'missing flow cookie');
  const script = /<script>(.+)<\/script>/.exec(html.text)[1];
  const info = { textContent: '' };
  let fragmentCleared = false;
  await runInNewContext(script, {
    document: { getElementById: () => info }, location: handoff, URLSearchParams,
    history: { replaceState: (_state, _unused, path) => { assert.equal(path, '/dsh-bridge-google'); fragmentCleared = true; } },
    window: { close() {} }, setTimeout(fn) { fn(); },
    fetch: async (path, init) => {
      assert.ok(fragmentCleared, 'clear fragment before posting the grant');
      assert.equal(path, '/api/cross-device/web/google/complete');
      const result = await api(device, nativeCookie + '; ' + flowCookie, '/google/complete', JSON.parse(init.body));
      return new Response(result.text, { status: result.status });
    },
  });
  assert.match(info.textContent, /Google 登录完成/);
  const status = ok(await api(device, nativeCookie, '/status'));
  assert.equal(status.joined, true);
  assert.equal(status.login_provider, 'google');
  assert.ok(!Object.hasOwn(status, 'token'));
  assert.equal((await api(device, nativeCookie + '; ' + flowCookie, '/google/complete', payload)).status, 403, 'grant cannot replay');
}

async function waitForPeer(device, cookie, predicate) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const status = ok(await api(device, cookie, '/status'));
    if (predicate(status)) return status;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Timed out waiting for device state');
}

try {
  hub = await startGoogleHub();
  const a = await startDsh('viewer');
  const b = await startDsh('target');
  assert.equal((await api(a, undefined, '/status')).status, 401);
  const aCookie = await login(a);
  const bCookie = await login(b);
  assert.equal((await http(a, localApi + '/status', { cookie: aCookie })).status, 403);
  assert.equal((await http(a, localApi + '/status', {
    cookie: aCookie, headers: { 'x-cross-device': '1', origin: b.origin },
  })).status, 403);
  await googleLogin(a, aCookie);
  await googleLogin(b, bCookie);
  assert.equal((await stat(a.configPath)).mode & 0o777, 0o600);
  assert.equal((await api(b, bCookie, '/pairing/code', {})).status, 404);
  const unrelated = await call(hub.url, '/api/v1/devices/heartbeat', {
    method: 'POST', body: { device_id: 'unrelated', device_name: 'Not paired', platform: 'macos' },
  });
  assert.equal(unrelated.status, 200);
  const { devices } = await waitForPeer(a, aCookie, value => value.devices[0]?.status === 'online');
  assert.equal(devices.length, 1);
  const [peer] = devices;
  assert.equal(peer.device_name, 'target');
  assert.equal(peer.web_enabled, false);
  assert.equal(ok(await api(b, bCookie, '/status')).remote_control_enabled, false);
  const target = { device_id: peer.device_id };
  assert.equal((await api(a, aCookie, '/open', target)).status, 409);

  ok(await api(b, bCookie, '/control', { enabled: true }));
  await waitForPeer(b, bCookie, value => value.control_ready === true);
  await waitForPeer(a, aCookie, value => value.devices[0]?.web_enabled === true);
  const entry = new URL(ok(await api(a, aCookie, '/open', target)).entry_url);
  assert.equal(entry.protocol, 'http:');
  assert.match(entry.hostname, /^[a-f0-9]{32}\.dsh-relay\.localhost$/);
  assert.equal(entry.pathname, '/dsh-relay-enter');
  assert.match(entry.hash, /^#[A-Za-z0-9_-]{43}$/);
  assert.equal(entry.search, '');
  assert.notEqual(entry.origin, b.origin);
  const view = { origin: entry.origin, authority: entry.host, port: Number(entry.port) };
  assert.equal((await http(view, '/')).status, 401, 'unclaimed view is not authenticated');
  const page = await http(view, entry.pathname, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(page.status, 200, 'one-click handoff is served through the relay');
  const [_, handoffScript] = /<script>([^]*?)<\/script>/.exec(page.text);
  const body = { grant: entry.hash.slice(1) };
  let browserCookie, cleared = false;
  await new Promise((resolve, reject) => {
    runInNewContext(handoffScript, {
      history: { replaceState: (_state, _title, route) => { assert.equal(route, entry.pathname); cleared = true; } },
      location: { hash: entry.hash, replace(route) { assert.equal(route, '/'); resolve(); } },
      document: { getElementById: () => ({ set textContent(_) { reject(new Error('one-click browser handoff failed')); } }) },
      fetch: async (route, init) => {
        try {
          assert.ok(cleared, 'remove the capability from the URL before calling the handoff endpoint');
          assert.equal(route, entry.pathname);
          assert.equal(init.method, 'POST');
          assert.deepEqual(JSON.parse(init.body), body);
          const result = await http(view, route, { method: init.method, body: JSON.parse(init.body),
            headers: { origin: view.origin, 'sec-fetch-site': 'same-origin' } });
          assert.equal(result.status, 204, 'one-click handoff must authenticate');
          browserCookie = result.headers['set-cookie'][0].split(';', 1)[0];
          return { ok: true };
        } catch (error) { reject(error); throw error; }
      },
    });
  });
  assert.notEqual(browserCookie, bCookie, 'native session cookie stays on target');
  assert.equal((await http(view, entry.pathname, { method: 'POST', body, headers: { origin: view.origin } })).status, 401, 'entry grant cannot be replayed');
  assert.equal((await http(view, localApi + '/status', { cookie: browserCookie })).status, 404);
  const original = await http(view, '/', { cookie: browserCookie });
  assert.equal(original.status, 200);
  assert.ok(/__DSH_BOOT__/.test(original.text), 'expected a native DSH boot payload');
  assert.ok(original.text.includes('dsh-cross-device/client.js'), 'expected the target Web plugin bundle');
  const active = await openMux(view, browserCookie);
  assert.equal(active.status, 101, 'expected the original DSH WebSocket over relay');
  assert.ok(active.socket);
  const closedStream = once(active.socket, 'close');
  ok(await api(b, bCookie, '/control', { enabled: false }));
  let closeTimer;
  try {
    await Promise.race([closedStream, new Promise((_, reject) => {
      closeTimer = setTimeout(() => { active.socket.destroy(); reject(new Error('revoked WS did not close')); }, 5000);
    })]);
  } finally { clearTimeout(closeTimer); }
  await waitForPeer(a, aCookie, value => value.devices[0]?.web_enabled === false);
  assert.equal((await api(a, aCookie, '/open', target)).status, 409);
  const staleView = await http(view, '/', { cookie: browserCookie }).catch(() => ({ status: 503 }));
  assert.notEqual(staleView.status, 200, 'old relay view cannot reconnect after revocation');
  console.log('Relay Web E2E OK: Google discovery, one-click native DSH and WebSocket, immediate revocation');
} finally {
  await Promise.all(children.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 3_000);
    try { await once(child, 'exit'); } finally { clearTimeout(kill); }
  }));
  await hub?.stop();
  await rm(temp, { recursive: true, force: true });
}
