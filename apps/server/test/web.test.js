import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createHubApp } from '../src/app.js';
import { DB_FILENAME } from '../src/db.js';
import { INSTANCE_TOKEN, call, registerDevice, startHub } from './helpers.js';

const WEB = '/api/v1/web';
const START = Date.parse('2026-01-01T00:00:00Z');
const privateOrigin = 'https://workstation.tailnet.ts.net';

async function web(url, path, options = {}) {
  const response = await call(url, WEB + path, { token: null, ...options });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  return response;
}

function post(url, path, token, body, headers) {
  return web(url, path, { method: 'POST', token, body, headers });
}

function ok(response, expected) {
  assert.equal(response.status, 200, JSON.stringify(response.json));
  if (expected !== undefined) assert.deepEqual(response.json, expected);
  return response.json;
}

function error(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.json));
  assert.deepEqual(Object.keys(response.json), ['error']);
  assert.equal(response.json.error.code, code);
}

async function enroll(url, name) {
  const identity = ok(await post(url, '/enroll', INSTANCE_TOKEN, { device_name: name }));
  assert.deepEqual(Object.keys(identity).sort(), ['device_id', 'token']);
  assert.equal(typeof identity.device_id, 'string');
  assert.match(identity.token, /^web_[A-Za-z0-9_-]{43}$/);
  return identity;
}

async function invite(url, issuer) {
  const invitation = ok(await post(url, '/pairing/code', issuer.token, {}));
  assert.deepEqual(Object.keys(invitation).sort(), ['code', 'expires_at']);
  assert.match(invitation.code, /^[A-Za-z0-9_-]{24}$/);
  return invitation;
}

function claim(url, code, name, token = null) {
  return post(url, '/pairing/claim', token, { code, device_name: name });
}

async function pairNew(url, issuer, name) {
  const { code } = await invite(url, issuer);
  return ok(await claim(url, code, name));
}

async function peers(url, identity) {
  return ok(await web(url, '/devices', { token: identity.token }));
}

function presence(url, identity, name, webUrl, extra = {}) {
  return post(url, '/presence', identity.token, { device_name: name, web_url: webUrl, ...extra });
}

function peerAction(url, path, from, to) {
  return post(url, path, from.token, { device_id: to.device_id });
}

function wrongCode(code) {
  return (code[0] === 'A' ? 'B' : 'A') + code.slice(1);
}

test('Web routes separate instance, Web and both sync credentials; old sidebar is unchanged', async (t) => {
  const hub = await startHub({ now: () => START });
  t.after(() => hub.stop());
  const { url } = hub;
  const legacy = await registerDevice(url, 'Same name');
  const mobileInvite = await call(url, '/api/v1/pairing/code', { method: 'POST', body: {} });
  assert.equal(mobileInvite.status, 200);
  assert.match(mobileInvite.json.code, /^\d{6}$/);
  error(await claim(url, mobileInvite.json.code, 'Not mobile'), 400, 'invalid_code');
  const mobileClaim = await call(url, '/api/v1/pairing/claim', {
    method: 'POST', token: null, body: { code: mobileInvite.json.code },
  });
  assert.equal(mobileClaim.status, 200);
  const mobile = mobileClaim.json;
  assert.equal((await call(url, '/api/v1/devices/heartbeat', {
    method: 'POST', token: mobile.token, body: { device_name: 'Same name', platform: 'ios' },
  })).status, 200);
  assert.deepEqual((await call(url, '/api/v1/sessions/sync', {
    method: 'POST', token: mobile.token, body: { sessions: [{ session_id: 'sync-session', title: 'Sync only' }] },
  })).json.accepted, ['sync-session']);
  const oldSidebar = (await call(url, '/api/v1/sidebar', { token: mobile.token })).json;
  assert.equal(oldSidebar.devices[0].device_id, mobile.device_id);
  assert.equal(oldSidebar.devices[0].sessions[0].session_id, 'sync-session');
  const oldV1 = (await call(url, '/v1/devices')).json;

  for (const token of [null, legacy.token, mobile.token]) {
    error(await post(url, '/enroll', token, { device_name: 'Cannot enroll' }), 401, 'unauthorized');
  }
  error(await post(url, '/enroll?token=' + INSTANCE_TOKEN, null, { device_name: 'Not via query' }), 401, 'unauthorized');
  const root = await enroll(url, 'Same name');
  assert.notEqual(root.device_id, mobile.device_id);
  assert.notEqual(root.device_id, legacy.device.id);
  assert.deepEqual(await peers(url, root), { devices: [] });
  error(await peerAction(url, '/open', root, mobile), 404, 'not_paired');
  error(await post(url, '/enroll', root.token, { device_name: 'Another root' }), 401, 'unauthorized');
  for (const token of [null, INSTANCE_TOKEN, legacy.token, mobile.token]) {
    error(await web(url, '/devices', { token }), 401, 'unauthorized');
    error(await post(url, '/pairing/code', token, {}), 401, 'unauthorized');
    error(await post(url, '/presence', token, { device_name: 'No write', web_url: null }), 401, 'unauthorized');
  }
  error(await web(url, '/devices?token=' + root.token), 401, 'unauthorized');
  error(await web(url, '/devices?access_token=' + root.token), 401, 'unauthorized');
  error(await web(url, '/unknown'), 404, 'not_found');
  error(await web(url, '/unknown', { method: 'OPTIONS' }), 404, 'not_found');
  error(await post(url, '/devices', root.token, {}), 404, 'not_found');
  assert.equal((await call(url, '/api/v1/sidebar', { token: root.token })).status, 401);
  assert.equal((await call(url, '/v1/sessions', { token: root.token })).status, 401);
  assert.equal((await call(url, '/v1/sessions?token=' + INSTANCE_TOKEN, { token: null })).status, 200);

  const webInvite = await invite(url, root);
  const invalidMobileClaim = await call(url, '/api/v1/pairing/claim', {
    method: 'POST', token: null, body: { code: webInvite.code },
  });
  assert.equal(invalidMobileClaim.status, 400);
  assert.equal(invalidMobileClaim.json.error.code, 'invalid_code');
  const peer = ok(await claim(url, webInvite.code, 'Same name'));
  ok(await presence(url, peer, 'Same name', privateOrigin), { ok: true });
  assert.deepEqual(await peers(url, root), {
    devices: [{ device_id: peer.device_id, device_name: 'Same name', status: 'online', web_enabled: true }],
  });
  assert.deepEqual((await call(url, '/api/v1/sidebar', { token: mobile.token })).json, oldSidebar);
  assert.deepEqual((await call(url, '/v1/devices')).json, oldV1);
});

test('Web codes reject bad credentials, wrong codes, self-claims, replay, and exact-TTL expiration', async (t) => {
  let now = START;
  const hub = await startHub({ now: () => now });
  t.after(() => hub.stop());
  const { url } = hub;
  const issuer = await enroll(url, 'Issuer');
  error(await post(url, '/pairing/code', issuer.token, { device_id: issuer.device_id }), 400, 'invalid_body');
  const { code, expires_at } = await invite(url, issuer);
  assert.equal(expires_at, new Date(START + 600_000).toISOString());
  error(await claim(url, code + '\n', 'Malformed'), 400, 'invalid_code');
  error(await claim(url, wrongCode(code), 'Wrong'), 404, 'pairing_code_invalid');
  for (const authorization of ['', 'Basic bad', 'Bearer not-a-web-token', 'Bearer ' + INSTANCE_TOKEN]) {
    error(await post(url, '/pairing/claim', null, { code, device_name: 'Bad' }, { authorization }), 401, 'unauthorized');
  }
  error(await post(url, '/pairing/claim?token=' + issuer.token, null, { code, device_name: 'Bad' }), 401, 'unauthorized');
  error(await claim(url, code, 'Self', issuer.token), 400, 'self_claim');
  assert.deepEqual(await peers(url, issuer), { devices: [] });

  // The same invite cannot create two identities even when claimed concurrently.
  now += 599_999;
  const attempts = await Promise.all([claim(url, code, 'First'), claim(url, code, 'Second')]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 404]);
  const [winner, loser] = attempts[0].status === 200 ? attempts : attempts.toReversed();
  const { device_id, token } = ok(winner);
  assert.deepEqual(Object.keys(winner.json).sort(), ['device_id', 'token']);
  assert.match(token, /^web_[A-Za-z0-9_-]{43}$/);
  error(loser, 404, 'pairing_code_invalid');
  error(await claim(url, code, 'Replay'), 404, 'pairing_code_invalid');
  assert.deepEqual((await peers(url, issuer)).devices.map((d) => d.device_id), [device_id]);
  assert.deepEqual(await peers(url, { token }), {
    devices: [{ device_id: issuer.device_id, device_name: 'Issuer', status: 'offline', web_enabled: false }],
  });

  const expired = await invite(url, issuer);
  now += 600_000;
  error(await claim(url, expired.code, 'Too late'), 404, 'pairing_code_invalid');
  assert.equal(hub.app.db.database.prepare('SELECT COUNT(*) AS n FROM web_pairing_codes').get().n, 0);
});

test('Web authorization is bilateral and non-transitive; heartbeat and unpair gate open', async (t) => {
  let now = START;
  const hub = await startHub({ now: () => now });
  t.after(() => hub.stop());
  const { url } = hub;
  const a = await enroll(url, 'A');
  const b = await pairNew(url, a, 'B');
  const c = await enroll(url, 'C');
  ok(await presence(url, c, 'C', 'https://c.invalid'), { ok: true });
  const { code } = await invite(url, b);
  ok(await claim(url, code, 'C renamed', c.token), { device_id: c.device_id });
  ok(await presence(url, a, 'A', 'https://a.invalid'), { ok: true });

  assert.deepEqual(await peers(url, a), {
    devices: [{ device_id: b.device_id, device_name: 'B', status: 'offline', web_enabled: false }],
  });
  error(await peerAction(url, '/open', a, b), 409, 'device_offline');
  error(await peerAction(url, '/open', a, a), 404, 'not_paired');
  error(await peerAction(url, '/open', a, c), 404, 'not_paired');
  error(await peerAction(url, '/open', c, a), 404, 'not_paired');
  error(await peerAction(url, '/unpair', a, c), 404, 'not_paired');

  ok(await presence(url, b, 'B awake', null, { device_id: c.device_id }), { ok: true });
  error(await peerAction(url, '/open', a, b), 409, 'web_not_enabled');
  assert.deepEqual(await peers(url, a), {
    devices: [{ device_id: b.device_id, device_name: 'B awake', status: 'online', web_enabled: false }],
  });
  ok(await presence(url, b, 'B awake', privateOrigin + '/'), { ok: true });
  assert.deepEqual(await peers(url, b), { devices: [
    { device_id: a.device_id, device_name: 'A', status: 'online', web_enabled: true },
    { device_id: c.device_id, device_name: 'C renamed', status: 'online', web_enabled: true },
  ] });
  assert.deepEqual((await peers(url, c)).devices.map((d) => d.device_id), [b.device_id]);
  ok(await peerAction(url, '/open', a, b), { url: privateOrigin });
  ok(await peerAction(url, '/open', b, a), { url: 'https://a.invalid' });
  ok(await peerAction(url, '/open', b, c), { url: 'https://c.invalid' });
  now += 60_000;
  ok(await peerAction(url, '/open', a, b), { url: privateOrigin });
  now += 1;
  error(await peerAction(url, '/open', a, b), 409, 'device_offline');
  assert.deepEqual(await peers(url, a), {
    devices: [{ device_id: b.device_id, device_name: 'B awake', status: 'offline', web_enabled: true }],
  });
  ok(await presence(url, b, 'B disabled', null), { ok: true });
  error(await peerAction(url, '/open', a, b), 409, 'web_not_enabled');
  ok(await peerAction(url, '/unpair', b, a), { ok: true });
  assert.deepEqual(await peers(url, a), { devices: [] });
  assert.deepEqual((await peers(url, b)).devices.map((d) => d.device_id), [c.device_id]);
  error(await peerAction(url, '/open', a, b), 404, 'not_paired');
  error(await peerAction(url, '/open', b, a), 404, 'not_paired');
  error(await peerAction(url, '/unpair', a, b), 404, 'not_paired');
});

test('Web presence accepts only credential-free HTTPS roots and malformed input cannot refresh it', async (t) => {
  let now = START;
  const hub = await startHub({ now: () => now });
  t.after(() => hub.stop());
  const { url } = hub;
  const a = await enroll(url, 'A');
  const b = await pairNew(url, a, 'B');
  for (const [input, origin] of [
    ['HTTPS://Workstation.Tailnet.TS.NET:443/', privateOrigin],
    ['https://unresolvable.invalid:8443/', 'https://unresolvable.invalid:8443'],
    ['https://100.64.0.2', 'https://100.64.0.2'],
    ['https://[fd00::7]:8443/', 'https://[fd00::7]:8443'],
  ]) {
    ok(await presence(url, b, 'B', input), { ok: true });
    ok(await peerAction(url, '/open', a, b), { url: origin });
  }
  now += 60_001;
  for (const invalid of [
    undefined, 42, '', '//host.invalid', 'http://host.invalid', 'https://',
    'https://host.invalid/path', 'https://host.invalid//', 'https://host.invalid/.',
    'https://host.invalid/%2e%2e', 'https://host.invalid/a/..', 'https://host.invalid?',
    'https://host.invalid/?secret=x', 'https://host.invalid#', 'https://host.invalid/#fragment',
    'https://user:secret@host.invalid', 'https://user@host.invalid', 'https://@host.invalid',
    'https://host.invalid\\path', 'https://host.invalid\n', 'https://host.inva\tlid',
    'https://host.invalid:65536', 'https://host.invalid:', 'https://bad_host.invalid',
    'https://localhost', 'https://a.LocalHost.', 'https://localhost.localdomain',
    'https://lo%63alhost', 'https://127.0.0.2', 'https://127.1', 'https://0x7f000001',
    'https://2130706433', 'https://0.0.0.0', 'https://[0:0::1]', 'https://[::]',
    'https://[::ffff:127.0.0.1]', 'https://[::127.0.0.1]',
  ]) {
    error(await presence(url, b, 'Must not replace B', invalid), 400, 'invalid_web_url');
  }
  assert.deepEqual(await peers(url, a), {
    devices: [{ device_id: b.device_id, device_name: 'B', status: 'offline', web_enabled: true }],
  });
  error(await peerAction(url, '/open', a, b), 409, 'device_offline');
});

test('failed Web guesses are limited globally and independently of sync pairing', async (t) => {
  let now = START;
  const hub = await startHub({ now: () => now });
  t.after(() => hub.stop());
  const { url } = hub;
  const a = await enroll(url, 'A');
  const b = await enroll(url, 'B');
  // Successful claims do not debit the quota or duplicate the direct edge.
  for (let attempt = 0; attempt < 13; attempt += 1) {
    const { code } = await invite(url, a);
    ok(await claim(url, code, 'B', b.token), { device_id: b.device_id });
  }
  assert.equal((await peers(url, a)).devices.length, 1);
  const { code } = await invite(url, a);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    error(await claim(url, wrongCode(code), 'Wrong', attempt % 2 ? b.token : null), 404, 'pairing_code_invalid');
  }
  error(await claim(url, code, 'Correct but throttled'), 429, 'rate_limited');
  const mobile = await call(url, '/api/v1/pairing/code', { method: 'POST', body: {} });
  assert.equal((await call(url, '/api/v1/pairing/claim', {
    method: 'POST', token: null, body: { code: mobile.json.code },
  })).status, 200);
  now += 59_999;
  error(await claim(url, code, 'Still throttled', b.token), 429, 'rate_limited');
  now += 1;
  ok(await claim(url, code, 'Correct again', b.token), { device_id: b.device_id });
});

test('a failed Web edge write rolls back identity allocation and code consumption', async (t) => {
  const hub = await startHub();
  t.after(() => hub.stop());
  const { url } = hub;
  const issuer = await enroll(url, 'Issuer');
  const { code } = await invite(url, issuer);
  const db = hub.app.db.database;
  db.exec("CREATE TEMP TRIGGER reject_pair BEFORE INSERT ON web_pairs BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  error(await claim(url, code, 'Failed allocation'), 500, 'internal_error');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM web_devices').get().n, 1);
  assert.deepEqual(await peers(url, issuer), { devices: [] });
  db.exec('DROP TRIGGER reject_pair');
  const identity = ok(await claim(url, code, 'Retry'));
  assert.equal((await peers(url, issuer)).devices[0].device_id, identity.device_id);
  error(await claim(url, code, 'Replay'), 404, 'pairing_code_invalid');
});

test('additive SQLite migration preserves sync rows and persists hashed Web credentials, invites, and edges', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'web-migration-test-'));
  let app;
  t.after(async () => {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const legacy = new DatabaseSync(join(dataDir, DB_FILENAME));
  try {
    legacy.exec("CREATE TABLE devices (device_id TEXT PRIMARY KEY, device_name TEXT NOT NULL, platform TEXT NOT NULL, last_seen_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'offline')");
    legacy.prepare('INSERT INTO devices VALUES (?, ?, ?, ?, ?)').run('old-id', 'Same name', 'macos', new Date(START).toISOString(), 'online');
  } finally {
    legacy.close();
  }
  async function restart() {
    await app?.close();
    app = await createHubApp({ dataDir, instanceToken: INSTANCE_TOKEN, now: () => START });
    return (await app.listen(0, '127.0.0.1')).url;
  }
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  let url = await restart();
  const sidebar = { devices: [{
    device_id: 'old-id', device_name: 'Same name', platform: 'macos', last_seen_at: new Date(START).toISOString(),
    status: 'online', sessions: [],
  }] };
  assert.deepEqual((await call(url, '/api/v1/sidebar')).json, sidebar);
  const a = await enroll(url, 'Same name');
  assert.deepEqual(await peers(url, a), { devices: [] });
  const consumed = await invite(url, a);
  const b = ok(await claim(url, consumed.code, 'B'));
  ok(await presence(url, b, 'B', privateOrigin), { ok: true });
  const pending = await invite(url, a);
  const raw = app.db.database;
  assert.equal(raw.prepare('SELECT token_hash FROM web_devices WHERE device_id = ?').get(b.device_id).token_hash, digest(b.token));
  assert.equal(raw.prepare('SELECT code_hash FROM web_pairing_codes').get().code_hash, digest(pending.code));

  url = await restart();
  assert.deepEqual((await call(url, '/api/v1/sidebar')).json, sidebar);
  ok(await peerAction(url, '/open', a, b), { url: privateOrigin });
  assert.deepEqual((await peers(url, b)).devices.map((d) => d.device_id), [a.device_id]);
  error(await claim(url, consumed.code, 'Replay after restart'), 404, 'pairing_code_invalid');
  const c = ok(await claim(url, pending.code, 'After restart'));
  ok(await peerAction(url, '/unpair', a, b), { ok: true });
  url = await restart();
  error(await peerAction(url, '/open', a, b), 404, 'not_paired');
  assert.deepEqual((await peers(url, a)).devices.map((d) => d.device_id), [c.device_id]);
});
