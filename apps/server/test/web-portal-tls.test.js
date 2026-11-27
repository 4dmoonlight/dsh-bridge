import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request } from 'node:https';
import { connect as connectTcp } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { connect as connectTls } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHubApp } from '../src/app.js';
import { GOOGLE_API_PATH } from '../src/google-oauth.js';
import { RELAY_PATH } from '../src/web-relay.js';

const exec = promisify(execFile);
const LOOPBACK = '127.0.0.1';
const CONTROL = 'control.example.test';
const DATA = 'views.example.test';
const FRESH = 'a'.repeat(32) + '.' + DATA;
const ALT = 'b'.repeat(32) + '.' + DATA;
const AUTHORITY = FRESH + ':8443';
const MUX = '/api/remote.mux';
const NOT_FOUND = { error: { code: 'not_found' } };

function https(path, { authority = AUTHORITY, servername = FRESH, method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    request({ hostname: LOOPBACK, port: 8443, path, method, servername, rejectUnauthorized: false, agent: false,
      headers: { host: authority, ...headers }, signal: AbortSignal.timeout(5_000),
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject).end();
  });
}

async function rawTls(lines, servername = FRESH) {
  const socket = connectTls({ host: LOOPBACK, port: 8443, servername, rejectUnauthorized: false });
  socket.setTimeout(5_000, () => socket.destroy(new Error('TLS fixture timed out')));
  let text = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => { text += chunk; });
  socket.write(lines.join('\r\n') + '\r\n\r\n');
  await once(socket, 'close').catch(error => { throw new Error(lines[0] + ' with SNI ' + servername, { cause: error }); });
  return text;
}

function upgrade(path, servername = FRESH) {
  return rawTls(['GET ' + path + ' HTTP/1.1', 'Host: ' + AUTHORITY, 'Connection: Upgrade', 'Upgrade: websocket',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', 'Origin: https://' + AUTHORITY], servername);
}

async function fixture(t, { dataPort = '8443', hasPortal = true } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-portal-edge-test-'));
  const app = await createHubApp({ dataDir, instanceToken: 'test-only',
    portal: hasPortal ? { origin: 'https://' + CONTROL, dataDomain: DATA, dataPort } : undefined,
    google: { clientId: 'fixture-id', clientSecret: 'fixture-only', redirectUri: 'https://' + CONTROL + GOOGLE_API_PATH + '/callback',
      allowedEmails: ['fixture@example.test'] },
  });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { app, dataDir };
}

test('TLS listener only accepts canonical data Host with matching TLS SNI, never Hub or control routes', async t => {
  const { app, dataDir } = await fixture(t);
  const keyFile = join(dataDir, 'fixture-key.pem');
  const certFile = join(dataDir, 'fixture-cert.pem');
  await exec('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
    '-subj', '/CN=portal-tls-fixture.invalid', '-keyout', keyFile, '-out', certFile], { timeout: 8_000 });
  const [key, cert] = await Promise.all([readFile(keyFile), readFile(certFile)]);
  const hub = await app.listen(0, LOOPBACK);
  assert.equal((await fetch(hub.url + '/healthz')).status, 200);
  const controlStatus = await new Promise((resolve, reject) => {
    httpRequest(hub.url + '/remote', { headers: { host: CONTROL }, signal: AbortSignal.timeout(5_000) }, res => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject).end();
  });
  assert.equal(controlStatus, 200);
  await assert.rejects(app.listenPortalTls({ key, cert, port: 0, host: LOOPBACK }), /listener port 8443/);
  await assert.rejects(app.listenPortalTls({ key: 'invalid pem', cert, host: LOOPBACK }));
  assert.deepEqual(await app.listenPortalTls({ key, cert, port: 8443, host: LOOPBACK }), { port: 8443, host: LOOPBACK });
  await assert.rejects(app.listenPortalTls({ key, cert, host: LOOPBACK }), /already started/);

  const unknown = await https('/_dsh/enter').catch(error => { throw new Error('canonical HTTPS failed', { cause: error }); });
  assert.equal(unknown.status, 404);
  assert.deepEqual(JSON.parse(unknown.body), NOT_FOUND);
  assert.equal(unknown.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'");
  for (const [path, options] of [
    ['/remote', { authority: CONTROL, servername: CONTROL }],
    ['/remote', { authority: CONTROL + ':8443', servername: CONTROL }],
    ['/remote/auth/start', { method: 'POST', authority: CONTROL, servername: CONTROL }],
    ['/remote', {}],
    ['/healthz', { authority: CONTROL, servername: CONTROL }],
    ['/healthz', { authority: 'unused.example.test:8443', servername: 'unused.example.test' }],
    ['/healthz', { method: 'OPTIONS', authority: 'localhost:8443', servername: 'localhost' }],
    ['/healthz', { authority: FRESH }],
    ['/healthz', { authority: FRESH + ':08443' }],
    ['/healthz', { authority: FRESH + '.:8443', servername: FRESH + '.' }],
    ['/healthz', { authority: FRESH.toUpperCase() + ':8443', servername: FRESH.toUpperCase() }],
    ['/healthz', { authority: 'nested.' + AUTHORITY, servername: 'nested.' + FRESH }],
    ['/healthz', { authority: DATA + ':8443', servername: DATA }],
    ['/_dsh/enter', { servername: '' }],
    ['/_dsh/enter', { servername: ALT, headers: { 'x-forwarded-host': AUTHORITY, 'x-forwarded-server': FRESH } }],
    ['/_dsh/enter', { servername: CONTROL }],
    [GOOGLE_API_PATH + '/callback', { authority: CONTROL, servername: CONTROL }],
  ]) {
    const reply = await https(path, options).catch(error => { throw new Error(JSON.stringify({ path, options }), { cause: error }); });
    assert.equal(reply.status, 404, JSON.stringify({ path, options }));
    assert.deepEqual(JSON.parse(reply.body), NOT_FOUND);
    assert.equal(reply.headers['content-security-policy'], undefined); // Rejected before invoking portal routes.
    assert.equal(reply.headers['set-cookie'], undefined);
  }
  const duplicate = await rawTls(['GET /_dsh/enter HTTP/1.1', 'Host: ' + AUTHORITY,
    'Host: ' + CONTROL, 'Connection: close']);
  assert.match(duplicate, /^HTTP\/1\.1 404/);
  assert.doesNotMatch(duplicate, /content-security-policy/i);
  assert.match(await upgrade(MUX), /^HTTP\/1\.1 403/); // Portal denies an unbound view.
  assert.match(await upgrade(MUX, ALT), /^HTTP\/1\.1 404/); // Rejected at TLS edge.
  for (const path of ['/remote', MUX + '?x=1', RELAY_PATH, '/api/v1/ws']) {
    assert.match(await upgrade(path), /^HTTP\/1\.1 404/, path);
  }

  // An unfinished TLS handshake must not hold shutdown open.
  const raw = connectTcp(8443, LOOPBACK);
  await once(raw, 'connect');
  const rawClose = new Promise((resolve, reject) => {
    raw.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    raw.once('close', resolve);
  });
  await Promise.all([app.close(), app.close(), rawClose]);
  await assert.rejects(https('/_dsh/enter'), { code: 'ECONNREFUSED' });
  await assert.rejects(app.listenPortalTls({ key, cert, host: LOOPBACK }), /Hub is closed/);
});

test('TLS listener requires a portal configured for alternate data port 8443', async t => {
  const absent = await fixture(t, { hasPortal: false });
  await assert.rejects(absent.app.listenPortalTls(), /configured Web portal/);
  const normal = await fixture(t, { dataPort: '443' });
  await assert.rejects(normal.app.listenPortalTls(), /BRIDGE_PORTAL_DATA_PORT=8443/);
  const alternate = await fixture(t);
  await assert.rejects(alternate.app.listenPortalTls(), /certificate and a key/);
});

test('CLI rejects mismatched, relative, or unavailable TLS credential files at startup', async () => {
  const index = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const run = env => exec(process.execPath, [index], { env, timeout: 5_000 });
  await assert.rejects(run({ BRIDGE_PORTAL_TLS_CERT_FILE: '/unused.pem' }), /Set both BRIDGE_PORTAL_TLS_CERT_FILE/);
  await assert.rejects(run({ BRIDGE_PORTAL_TLS_CERT_FILE: 'relative.pem', BRIDGE_PORTAL_TLS_KEY_FILE: '/unused.pem' }), /paths must be absolute/);
  const files = { BRIDGE_PORTAL_TLS_CERT_FILE: '/missing-dsh-cert.pem', BRIDGE_PORTAL_TLS_KEY_FILE: '/missing-dsh-key.pem' };
  await assert.rejects(run(files), /requires a configured Web portal/);
  await assert.rejects(run({ ...files, BRIDGE_PORTAL_DATA_PORT: '8443' }), /ENOENT/);
});
