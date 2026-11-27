import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Duplex } from 'node:stream';
import { test } from 'node:test';
import { sha256, sendJson } from '../src/util.js';
import { WebDb } from '../src/web-db.js';
import { RELAY_PATH, WebRelay } from '../src/web-relay.js';
import { MAX_CHUNK_BYTES } from '../src/web-relay-socket.js';
import { call } from './helpers.js';
import { CLIENT_OPCODE, openWebSocket } from './ws-client.js';

const SUBJECT = 'portal-vault-test-subject';
const SUBJECT_HASH = sha256(SUBJECT);
const NOW = Date.parse('2026-01-01T00:00:00Z');
const FINGERPRINT = '1234567890abcdef'.repeat(4);
const AUTHORITY = 'abcdef0123456789abcdef0123456789.dsh-relay.localhost:3080';
const GRANT_HASH = randomBytes(32).toString('base64url');
const VIEWER_ID = randomBytes(24).toString('base64url');
const OTHER_VIEWER_ID = randomBytes(24).toString('base64url');

async function fixture(t, relayOptions) {
  let now = NOW;
  const database = new DatabaseSync(':memory:');
  const web = new WebDb(database, () => now);
  const relay = new WebRelay({ db: web, bodyLimit: 2048, ...relayOptions });
  const server = createServer((req, res) => {
    relay.handleHttp(req, res, new URL(req.url, 'http://localhost')).catch((error) => {
      sendJson(res, error.status ?? 500, { error: { code: error.code } });
    });
  });
  server.on('upgrade', (req, socket, head) => {
    if (!relay.handleUpgrade(req, socket, head)) socket.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    relay.close();
    await new Promise((resolve) => server.close(resolve));
    database.close();
  });
  const url = 'http://127.0.0.1:' + server.address().port;
  const identity = (deviceName, subject = SUBJECT) => web.signInGoogle({ deviceId: null, subject, deviceName });
  const target = identity('Present and opted in');
  web.publishPresence(target.device_id, 'Present and opted in', null);
  const options = { subjectHash: SUBJECT_HASH, viewerId: VIEWER_ID, deviceId: target.device_id,
    authority: AUTHORITY, grantHash: GRANT_HASH };
  return {
    database, web, relay, url, identity, target, options,
    advance(ms) { now += ms; },
    ws: () => openWebSocket(url, { requestTarget: RELAY_PATH }),
    open: (overrides) => relay.openPortalLease({ ...options, ...overrides }),
  };
}

function send(ws, msg) {
  ws.sendText(JSON.stringify(msg));
}

async function closeFrame(ws, code, reason) {
  for (;;) {
    const frame = await ws.nextFrame();
    if (frame.opcode !== CLIENT_OPCODE.close) continue;
    assert.equal(frame.payload.readUInt16BE(0), code);
    assert.equal(frame.payload.subarray(2).toString(), reason);
    return;
  }
}

async function host(hub, device = hub.target, portal = true) {
  const conn = await hub.ws();
  send(conn, { type: 'host', token: device.token, fingerprint: FINGERPRINT, ...(portal ? { portal_access: true } : {}) });
  assert.deepEqual(await conn.nextJson(), { type: 'ready' });
  return conn;
}

async function start(hub, control, lease, options) {
  const pending = hub.relay.connectPortalStream(VIEWER_ID, lease.lease_id, options);
  pending.catch(() => {}); // Lifecycle tests intentionally revoke before awaiting.
  const incoming = await control.nextJson();
  assert.match(incoming.connection_id, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(incoming, { type: 'incoming', connection_id: incoming.connection_id,
    lease_id: lease.lease_id, authority: AUTHORITY, grant_hash: GRANT_HASH, expires_at: lease.expires_at });
  return { pending, incoming };
}

async function join(hub, connectionId, device = hub.target) {
  const conn = await hub.ws();
  send(conn, { type: 'join', token: device.token, connection_id: connectionId });
  return conn;
}

async function connect(hub, control, lease, options) {
  const { pending, incoming } = await start(hub, control, lease, options);
  const target = await join(hub, incoming.connection_id);
  assert.deepEqual(await target.nextJson(), { type: 'connected' });
  return { transport: await pending, target, incoming };
}

test('portal discovery and lease opens require both online presence and explicit same-subject opt-in', async (t) => {
  const hub = await fixture(t);
  const legacy = hub.identity('Present but legacy');
  const stale = hub.identity('Opted in but no presence');
  const outsider = hub.identity('Other Google subject', 'other-subject');
  hub.web.publishPresence(legacy.device_id, 'Present but legacy', null);
  hub.web.publishPresence(outsider.device_id, 'Other Google subject', null);
  await host(hub, legacy, false);
  await host(hub, stale);
  await host(hub, outsider);
  for (const value of [false, 'true', 1]) {
    const conn = await hub.ws();
    send(conn, { type: 'host', token: hub.target.token, fingerprint: FINGERPRINT, portal_access: value });
    await closeFrame(conn, 1008, 'invalid_auth');
  }
  await host(hub);
  assert.deepEqual(hub.relay.portalDevices(SUBJECT_HASH), [
    { device_id: hub.target.device_id, device_name: 'Present and opted in', status: 'online' },
  ]);
  assert.throws(() => hub.relay.portalDevices(SUBJECT), { code: 'invalid_subject_hash' });
  for (const device of [legacy, stale]) {
    assert.throws(() => hub.open({ deviceId: device.device_id }), { status: 409, code: 'web_not_enabled' });
  }
  assert.throws(() => hub.open({ deviceId: outsider.device_id }), { status: 404, code: 'device_not_found' });
  for (const authority of [AUTHORITY + '\n', AUTHORITY.toUpperCase(), AUTHORITY.replace(':3080', ':03080'),
    AUTHORITY.replace(':3080', ':80'), 'localhost:3080']) {
    assert.throws(() => hub.open({ authority }), { code: 'invalid_authority' });
  }
  assert.throws(() => hub.open({ grantHash: GRANT_HASH + '=' }), { code: 'invalid_grant_hash' });
  assert.throws(() => hub.open({ grantHash: GRANT_HASH.slice(0, -1) + 'B' }), { code: 'invalid_grant_hash' });
  assert.throws(() => hub.open({ viewerId: 'not-a-session-id' }), { code: 'invalid_viewer_id' });
  assert.throws(() => hub.open({ deviceId: '' }), { code: 'invalid_device_id' });

  const lease = hub.open();
  assert.deepEqual(lease, { lease_id: lease.lease_id, fingerprint: FINGERPRINT, expires_at: NOW + 29 * 60_000 });
  assert.match(lease.lease_id, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(hub.web.findGoogleSubject(VIEWER_ID), null);
  assert.equal(hub.web.lookupRelayIdentity(VIEWER_ID), null);
  hub.advance(60_001);
  assert.deepEqual(hub.relay.portalDevices(SUBJECT_HASH), []);
  assert.throws(() => hub.open(), { status: 409, code: 'web_not_enabled' });
  const desktop = await call(hub.url, RELAY_PATH + '/open', {
    method: 'POST', token: legacy.token,
    body: { device_id: hub.target.device_id, authority: AUTHORITY, grant_hash: GRANT_HASH },
  });
  assert.equal(desktop.status, 200); // Legacy desktop does not require separate fresh presence.
  assert.deepEqual(hub.relay.closePortalLease(VIEWER_ID, desktop.json.lease_id), { closed: true });
  await assert.rejects(hub.relay.connectPortalStream(VIEWER_ID, desktop.json.lease_id), { code: 'lease_not_found' });
});

test('portal stream is a one-use, independently authenticated ciphertext Duplex', async (t) => {
  const hub = await fixture(t);
  const control = await host(hub);
  const lease = hub.open();
  await assert.rejects(hub.relay.connectPortalStream(OTHER_VIEWER_ID, lease.lease_id), { code: 'lease_not_found' });
  assert.throws(() => hub.relay.closePortalLease(VIEWER_ID, 'not-a-lease'), { code: 'invalid_lease_id' });
  assert.deepEqual(hub.relay.closePortalLease(OTHER_VIEWER_ID, lease.lease_id), { closed: true });

  // A virtual viewer has no bearer credential. Even a persisted identity with
  // a colliding ID is not entitled to a portal stream or lease revocation.
  const token = 'test-colliding-bearer';
  hub.database.prepare('INSERT INTO web_devices (device_id, token_hash, device_name) VALUES (?, ?, ?)')
    .run(VIEWER_ID, sha256(token), 'Control test collision');
  hub.database.prepare('INSERT INTO web_google_bindings (device_id, subject_hash) VALUES (?, ?)').run(VIEWER_ID, SUBJECT_HASH);
  const ws = await hub.ws();
  send(ws, { type: 'viewer', token, lease_id: lease.lease_id });
  await closeFrame(ws, 1008, 'lease_not_found');
  const httpClose = await call(hub.url, RELAY_PATH + '/close', {
    method: 'POST', token, body: { lease_id: lease.lease_id },
  });
  assert.equal(httpClose.status, 200);
  const pretendHost = await hub.ws();
  send(pretendHost, { type: 'host', token: VIEWER_ID, fingerprint: FINGERPRINT, portal_access: true });
  await closeFrame(pretendHost, 1008, 'unauthorized');

  hub.advance(60_001); // Existing lease remains usable after a presence delay.
  const { pending, incoming } = await start(hub, control, lease);
  await closeFrame(await join(hub, incoming.connection_id, hub.identity('Another same-subject device')), 1008, 'connection_not_found');
  const target = await join(hub, incoming.connection_id);
  assert.deepEqual(await target.nextJson(), { type: 'connected' });
  const transport = await pending;
  assert.ok(transport instanceof Duplex);
  await closeFrame(await join(hub, incoming.connection_id), 1008, 'connection_not_found');

  const ciphertext = randomBytes(MAX_CHUNK_BYTES + 17);
  let written = false;
  const writing = new Promise((resolve, reject) => transport.write(ciphertext, (error) => {
    written = true;
    if (error) reject(error);
    else resolve();
  }));
  assert.deepEqual(await target.nextJson(), { type: 'data', data: ciphertext.subarray(0, MAX_CHUNK_BYTES).toString('base64') });
  assert.equal(written, false);
  send(target, { type: 'ack' });
  assert.deepEqual(await target.nextJson(), { type: 'data', data: ciphertext.subarray(MAX_CHUNK_BYTES).toString('base64') });
  assert.equal(written, false);
  send(target, { type: 'ack' });
  await writing;

  const reverse = randomBytes(19);
  send(target, { type: 'data', data: reverse.toString('base64') });
  assert.deepEqual(await target.nextJson(), { type: 'ack' });
  assert.equal(transport.readableLength, reverse.length);
  transport.end();
  assert.deepEqual(await target.nextJson(), { type: 'end' });
  const finished = once(transport, 'close');
  send(target, { type: 'end' });
  await closeFrame(target, 1000, '');
  assert.deepEqual(transport.read(), reverse); // Graceful close preserves the unread ciphertext.
  await finished;
});

test('portal owner close, abort, host generation change, power-off, and relay shutdown revoke streams', async (t) => {
  const hub = await fixture(t);
  let control = await host(hub);
  const lease = hub.open();
  const { transport, target } = await connect(hub, control, lease);
  const pending = await start(hub, control, lease);
  assert.deepEqual(hub.relay.closePortalLease(VIEWER_ID, lease.lease_id), { closed: true });
  assert.equal(transport.destroyed, true);
  await closeFrame(target, 1001, 'viewer_closed');
  await assert.rejects(pending.pending, { code: 'viewer_closed' });
  await closeFrame(await join(hub, pending.incoming.connection_id), 1008, 'connection_not_found');

  const nextLease = hub.open();
  await assert.rejects(hub.relay.connectPortalStream(VIEWER_ID, nextLease.lease_id, { signal: AbortSignal.abort() }),
    { name: 'AbortError' });
  const firstAbort = new AbortController();
  const first = await start(hub, control, nextLease, { signal: firstAbort.signal });
  firstAbort.abort();
  await assert.rejects(first.pending, { name: 'AbortError' });
  await closeFrame(await join(hub, first.incoming.connection_id), 1008, 'connection_not_found');
  const secondAbort = new AbortController();
  const second = await connect(hub, control, nextLease, { signal: secondAbort.signal });
  secondAbort.abort();
  assert.equal(second.transport.destroyed, true);
  await closeFrame(second.target, 1001, 'peer_closed');

  const active = await connect(hub, control, nextLease);
  const replacing = await start(hub, control, nextLease);
  const oldHost = control;
  control = await host(hub, hub.target, false);
  assert.equal(active.transport.destroyed, true);
  await assert.rejects(replacing.pending, { code: 'host_closed' });
  await closeFrame(oldHost, 1001, 'host_replaced');
  await closeFrame(active.target, 1001, 'host_closed');
  assert.throws(() => hub.open(), { code: 'web_not_enabled' });

  control = await host(hub);
  const disablingLease = hub.open();
  const disabling = await connect(hub, control, disablingLease);
  control.sendClose();
  await closeFrame(control, 1000, '');
  assert.equal(disabling.transport.destroyed, true);
  await closeFrame(disabling.target, 1001, 'host_closed');

  control = await host(hub);
  const shutdownLease = hub.open();
  const shutdown = await connect(hub, control, shutdownLease);
  hub.relay.close();
  assert.equal(shutdown.transport.destroyed, true);
  await assert.rejects(hub.relay.connectPortalStream(VIEWER_ID, shutdownLease.lease_id), { code: 'server_closed' });
});

test('portal streams reuse quotas, live target subject checks, expiry and relay acknowledgements', async (t) => {
  const hub = await fixture(t, { joinTimeoutMs: 300, ackTimeoutMs: 200 });
  const control = await host(hub);
  const leases = Array.from({ length: 8 }, () => hub.open());
  assert.throws(() => hub.open(), { code: 'rate_limited' });
  for (let i = 0; i < 8; i += 1) hub.open({ viewerId: OTHER_VIEWER_ID });
  assert.throws(() => hub.open({ viewerId: randomBytes(24).toString('base64url') }), { code: 'rate_limited' });
  const neverJoined = await start(hub, control, leases[0]);
  await assert.rejects(neverJoined.pending, { status: 504, code: 'join_timeout' });
  await closeFrame(await join(hub, neverJoined.incoming.connection_id), 1008, 'connection_not_found');
  const stalls = await connect(hub, control, leases[0]);
  const writing = new Promise((resolve, reject) => stalls.transport.write(Buffer.of(4), (error) => error ? reject(error) : resolve()));
  const failedWrite = assert.rejects(writing, { code: 'ack_timeout' });
  assert.deepEqual(await stalls.target.nextJson(), { type: 'data', data: 'BA==' });
  await closeFrame(stalls.target, 1008, 'ack_timeout');
  await failedWrite;
  assert.equal(stalls.transport.destroyed, true);

  const backpressured = await connect(hub, control, leases[0]);
  const chunk = { type: 'data', data: randomBytes(MAX_CHUNK_BYTES).toString('base64') };
  send(backpressured.target, chunk);
  assert.deepEqual(await backpressured.target.nextJson(), { type: 'ack' });
  // The second chunk fills the readable buffer and withholds its ACK. A
  // target trying to send again without it hits the existing backpressure rule.
  send(backpressured.target, chunk);
  send(backpressured.target, chunk);
  await closeFrame(backpressured.target, 1008, 'backpressure');
  assert.equal(backpressured.transport.destroyed, true);

  const expires = await connect(hub, control, leases[1]);
  hub.advance(29 * 60_000);
  await assert.rejects(hub.relay.connectPortalStream(VIEWER_ID, leases[1].lease_id), { code: 'lease_not_found' });
  assert.equal(expires.transport.destroyed, true);
  await closeFrame(expires.target, 1001, 'lease_expired');

  hub.web.publishPresence(hub.target.device_id, 'Present and opted in', null);
  const revoked = await connect(hub, control, hub.open());
  hub.database.prepare('UPDATE web_google_bindings SET subject_hash = ? WHERE device_id = ?')
    .run(sha256('replacement-subject'), hub.target.device_id);
  // A joined side must still be bound to the lease subject, not merely have had a valid token at join.
  send(revoked.target, { type: 'data', data: 'BA==' });
  await closeFrame(control, 1008, 'google_binding_required');
  assert.equal(revoked.transport.destroyed, true);
  await closeFrame(revoked.target, 1001, 'host_closed');
});
