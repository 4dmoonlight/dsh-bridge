import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { call, INSTANCE_TOKEN, startHub } from './helpers.js';
import { CLIENT_OPCODE, encodeClientFrame, openWebSocket } from './ws-client.js';

const PATH = '/api/v1/web/relay';
const SUBJECT = 'test-google-subject';
const NOW = Date.parse('2026-01-01T00:00:00Z');
const FINGERPRINT = '1234567890abcdef'.repeat(4);
const NEXT_FINGERPRINT = 'ffeeddccbbaa0099'.repeat(4);
const GRANT_HASH = createHash('sha256').update(randomBytes(32)).digest('base64url');
const AUTHORITY = '11111111111111111111111111111111.dsh-relay.localhost:3080';

async function fixture(t, options) {
  const hub = await startHub(options);
  t.after(() => hub.stop());
  const { web } = hub.app.db;
  const identity = (deviceName, subject = SUBJECT) => web.signInGoogle({ deviceId: null, subject, deviceName });
  return {
    ...hub, identity, web,
    target: identity('Target'),
    owner: identity('Viewer'),
    sibling: identity('Sibling'),
    outsider: identity('Outsider', SUBJECT + '-other'),
  };
}

function list(hub, device) {
  return call(hub.url, PATH + '/devices', { token: device?.token ?? null });
}

function requestOpen(hub, viewer, host, overrides = {}) {
  return call(hub.url, PATH + '/open', {
    method: 'POST', token: viewer?.token ?? null,
    body: { device_id: host.device_id, authority: AUTHORITY, grant_hash: GRANT_HASH, ...overrides },
  });
}

async function open(hub, viewer = hub.owner) {
  const response = await requestOpen(hub, viewer, hub.target);
  assert.equal(response.status, 200);
  assert.match(response.json.lease_id, /^[a-zA-Z0-9_-]+$/);
  assert.deepEqual(Object.keys(response.json).sort(), ['expires_at', 'fingerprint', 'lease_id']);
  return response.json;
}

function ws(hub, options = {}) {
  return openWebSocket(hub.url, { requestTarget: PATH, ...options });
}

function send(conn, message) {
  conn.sendText(JSON.stringify(message));
}

async function closeFrame(conn, code, reason) {
  for (;;) {
    const { opcode, payload } = await conn.nextFrame();
    if (opcode === CLIENT_OPCODE.close) {
      assert.equal(payload.readUInt16BE(0), code);
      assert.equal(payload.subarray(2).toString(), reason);
      return;
    }
  }
}

async function control(hub, target = hub.target, fingerprint = FINGERPRINT, options) {
  const conn = await ws(hub, options);
  send(conn, { type: 'host', token: target.token, fingerprint });
  assert.deepEqual(await conn.nextJson(), { type: 'ready' });
  return conn;
}

async function startStream(hub, hostControl, lease) {
  const viewer = await ws(hub);
  send(viewer, { type: 'viewer', token: hub.owner.token, lease_id: lease.lease_id });
  const incoming = await hostControl.nextJson();
  assert.match(incoming.connection_id, /^[a-zA-Z0-9_-]+$/);
  assert.deepEqual(incoming, {
    type: 'incoming', connection_id: incoming.connection_id, lease_id: lease.lease_id,
    authority: AUTHORITY, grant_hash: GRANT_HASH, expires_at: lease.expires_at,
  });
  return { viewer, incoming };
}

async function join(hub, connectionId, device = hub.target) {
  const conn = await ws(hub);
  send(conn, { type: 'join', token: device.token, connection_id: connectionId });
  return conn;
}

async function connectStream(hub, host, lease) {
  const { viewer, incoming } = await startStream(hub, host, lease);
  const target = await join(hub, incoming.connection_id);
  assert.deepEqual(await viewer.nextJson(), { type: 'connected' });
  assert.deepEqual(await target.nextJson(), { type: 'connected' });
  return { viewer, target };
}

function httpError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.json?.error?.code, code);
}

test('relay discovery uses Google bindings and heartbeat, not invitation edges or direct Web URL', async (t) => {
  let now = NOW;
  const hub = await fixture(t, { now: () => now });
  const { web, target, owner, sibling, outsider } = hub;
  const legacy = web.createDevice('Manual');
  web.claimCode({ code: web.issueCode(owner.device_id).code, deviceId: legacy.device_id, deviceName: 'Manual' });
  web.claimCode({ code: web.issueCode(owner.device_id).code, deviceId: outsider.device_id, deviceName: 'Paired outside Google' });
  web.unpair(owner.device_id, target.device_id);
  httpError(await list(hub), 401, 'unauthorized');
  httpError(await list(hub, legacy), 403, 'google_binding_required');
  httpError(await call(hub.url, PATH + '/devices?token=query-credential', { token: owner.token }), 401, 'unauthorized');

  const initial = await list(hub, owner);
  assert.deepEqual(initial.json, { devices: [
    { device_id: sibling.device_id, device_name: 'Sibling', status: 'offline', web_enabled: false },
    { device_id: target.device_id, device_name: 'Target', status: 'offline', web_enabled: false },
  ], control_ready: false });
  const heartbeat = await call(hub.url, '/api/v1/web/presence', {
    method: 'POST', token: target.token, body: { device_name: 'Current name', web_url: 'https://direct.example.test' },
  });
  assert.equal(heartbeat.status, 200);
  const foreignControl = await control(hub, outsider);
  httpError(await requestOpen(hub, owner, outsider), 404, 'device_not_found');
  httpError(await requestOpen(hub, owner, owner), 404, 'device_not_found');
  httpError(await requestOpen(hub, owner, { device_id: 'unknown' }), 404, 'device_not_found');
  httpError(await requestOpen(hub, owner, target), 409, 'web_not_enabled');
  const direct = await call(hub.url, '/api/v1/web/devices', { token: owner.token });
  assert.ok(direct.json.devices.some((device) => device.device_id === legacy.device_id));
  assert.ok(direct.json.devices.some((device) => device.device_id === outsider.device_id));
  assert.ok(!direct.json.devices.some((device) => device.device_id === target.device_id));

  const host = await control(hub);
  assert.equal((await list(hub, target)).json.control_ready, true);
  assert.deepEqual((await list(hub, owner)).json.devices[0], {
    device_id: target.device_id, device_name: 'Current name', status: 'online', web_enabled: true,
  });
  now += 60_001;
  assert.deepEqual((await list(hub, owner)).json.devices[0], {
    device_id: target.device_id, device_name: 'Current name', status: 'offline', web_enabled: true,
  });
  const lease = await open(hub);
  assert.equal(lease.fingerprint, FINGERPRINT);
  assert.equal(lease.expires_at, now + 29 * 60_000);
  host.sendClose();
  await closeFrame(host, 1000, '');
  assert.equal((await list(hub, owner)).json.devices[0].web_enabled, false);
  httpError(await requestOpen(hub, owner, target), 409, 'web_not_enabled');
  foreignControl.close();
});

test('relay accepts only the exact native upgrade and validates authorization, authority, and grant fields', async (t) => {
  const errors = [];
  const hub = await fixture(t, { logger: { info() {}, error(...args) { errors.push(args); } } });
  const legacy = hub.web.createDevice('Not bound');
  const cases = [
    [{ requestTarget: PATH + '?' }, 400, 'invalid_request'],
    [{ requestTarget: PATH + '?token=not-a-credential' }, 400, 'invalid_request'],
    [{ requestTarget: PATH + '/' }, 404, 'not_found'],
    [{ requestTarget: PATH + '/../relay' }, 404, 'not_found'],
    [{ headers: { Origin: 'null' } }, 403, 'origin_forbidden'],
    [{ headers: { Origin: '' } }, 403, 'origin_forbidden'],
  ];
  for (const [options, status, code] of cases) {
    await assert.rejects(ws(hub, options), (error) => error.status === status && error.body?.error?.code === code);
  }
  for (const [token, fingerprint, reason] of [
    ['bad', FINGERPRINT, 'unauthorized'],
    [legacy.token, FINGERPRINT, 'google_binding_required'],
    [hub.target.token, FINGERPRINT.toUpperCase(), 'invalid_fingerprint'],
  ]) {
    const conn = await ws(hub);
    send(conn, { type: 'host', token, fingerprint });
    await closeFrame(conn, 1008, reason);
  }
  const raw = await ws(hub);
  raw.sendText(JSON.stringify({ token: hub.target.token }).slice(0, -1));
  await closeFrame(raw, 1007, 'invalid_json');
  const large = await ws(hub);
  // This single length-without-payload prefix must fail immediately, not when auth times out.
  large.socket.write(Buffer.from([0x81, 0xfe, 0x08, 0x01]));
  await closeFrame(large, 1009, 'message_too_large');
  const host = await control(hub);
  for (const authority of [
    'localhost:3080', 'https://127.0.0.1:3080', '127.0.0.2:3080', '127.0.0.1:03080', '127.0.0.1:0',
    '127.0.0.1:65536', '127.0.0.1:3080/', '127.0.0.1:3080\n', '127.0.0.1:3080@attacker.test', '[::1]:3080',
  ]) {
    httpError(await requestOpen(hub, hub.owner, hub.target, { authority }), 400, 'invalid_authority');
  }
  for (const grant_hash of ['x'.repeat(43), GRANT_HASH + '=', '', '!' + GRANT_HASH.slice(1)]) {
    httpError(await requestOpen(hub, hub.owner, hub.target, { grant_hash }), 400, 'invalid_grant_hash');
  }
  httpError(await requestOpen(hub, hub.owner, hub.target, { grant: 'no raw proof in Hub' }), 400, 'invalid_body');
  assert.deepEqual(errors, []);
  host.close();
});

test('viewer and target authenticate independently; a one-use join wires ciphertext and acknowledgements both ways', async (t) => {
  const hub = await fixture(t);
  const host = await control(hub);
  const lease = await open(hub);
  const wrongViewer = await ws(hub);
  send(wrongViewer, { type: 'viewer', token: hub.sibling.token, lease_id: lease.lease_id });
  await closeFrame(wrongViewer, 1008, 'lease_not_found');
  const { incoming, viewer } = await startStream(hub, host, lease);
  await closeFrame(await join(hub, incoming.connection_id, hub.sibling), 1008, 'connection_not_found');
  await closeFrame(await join(hub, incoming.connection_id, hub.outsider), 1008, 'connection_not_found');
  const target = await join(hub, incoming.connection_id);
  assert.deepEqual(await viewer.nextJson(), { type: 'connected' });
  assert.deepEqual(await target.nextJson(), { type: 'connected' });
  await closeFrame(await join(hub, incoming.connection_id), 1008, 'connection_not_found');

  const ciphertext = { type: 'data', data: randomBytes(32 * 1024).toString('base64') };
  const reverse = { type: 'data', data: randomBytes(19).toString('base64') };
  const raw = JSON.stringify(ciphertext);
  viewer.socket.write(encodeClientFrame(CLIENT_OPCODE.text, raw.slice(0, 20), false));
  viewer.socket.write(encodeClientFrame(0, raw.slice(20)));
  send(target, reverse);
  assert.deepEqual(await target.nextJson(), ciphertext);
  assert.deepEqual(await viewer.nextJson(), reverse);
  send(target, { type: 'ack' });
  send(viewer, { type: 'ack' });
  assert.deepEqual(await target.nextJson(), { type: 'ack' });
  assert.deepEqual(await viewer.nextJson(), { type: 'ack' });

  send(viewer, { type: 'end' });
  assert.deepEqual(await target.nextJson(), { type: 'end' });
  send(target, reverse);
  assert.deepEqual(await viewer.nextJson(), reverse);
  send(viewer, { type: 'ack' });
  assert.deepEqual(await target.nextJson(), { type: 'ack' });
  send(target, { type: 'end' });
  assert.deepEqual(await viewer.nextJson(), { type: 'end' });
  await Promise.all([closeFrame(target, 1000, ''), closeFrame(viewer, 1000, '')]);
});

test('replacing or disabling the host synchronously closes active streams and invalidates prior leases and joins', async (t) => {
  const hub = await fixture(t);
  let host = await control(hub);
  const lease = await open(hub);
  let active = await connectStream(hub, host, lease);
  let pending = await startStream(hub, host, lease);
  const oldHost = host;
  host = await control(hub, hub.target, NEXT_FINGERPRINT);
  await Promise.all([
    closeFrame(oldHost, 1001, 'host_replaced'),
    closeFrame(active.viewer, 1001, 'host_closed'), closeFrame(active.target, 1001, 'host_closed'),
    closeFrame(pending.viewer, 1001, 'host_closed'),
  ]);
  await closeFrame(await join(hub, pending.incoming.connection_id), 1008, 'connection_not_found');
  const oldViewer = await ws(hub);
  send(oldViewer, { type: 'viewer', token: hub.owner.token, lease_id: lease.lease_id });
  await closeFrame(oldViewer, 1008, 'lease_not_found');
  assert.equal((await list(hub, hub.target)).json.control_ready, true);

  const nextLease = await open(hub);
  assert.notEqual(nextLease.lease_id, lease.lease_id);
  assert.equal(nextLease.fingerprint, NEXT_FINGERPRINT);
  active = await connectStream(hub, host, nextLease);
  pending = await startStream(hub, host, nextLease);
  host.sendClose();
  await closeFrame(host, 1000, '');
  assert.equal((await list(hub, hub.target)).json.control_ready, false);
  httpError(await requestOpen(hub, hub.owner, hub.target), 409, 'web_not_enabled');
  await Promise.all([
    closeFrame(active.viewer, 1001, 'host_closed'), closeFrame(active.target, 1001, 'host_closed'),
    closeFrame(pending.viewer, 1001, 'host_closed'),
  ]);
});

test('relay enforces one outstanding chunk per direction, size, ack validity, and socket close cascades', async (t) => {
  const hub = await fixture(t);
  const host = await control(hub);
  const lease = await open(hub);
  const data = { type: 'data', data: 'AAAA' };
  let pair = await connectStream(hub, host, lease);
  send(pair.viewer, data);
  assert.deepEqual(await pair.target.nextJson(), data);
  send(pair.viewer, data);
  await Promise.all([closeFrame(pair.viewer, 1008, 'backpressure'), closeFrame(pair.target, 1008, 'backpressure')]);

  for (const [message, code, reason] of [
    [{ type: 'data', data: 'AAB=' }, 1007, 'invalid_data'],
    [{ type: 'data', data: Buffer.alloc(32 * 1024 + 1).toString('base64') }, 1009, 'chunk_too_large'],
    [{ type: 'ack' }, 1008, 'unexpected_ack'],
    [{ type: 'data', data: data.data, token: 'not part of protocol' }, 1008, 'invalid_message'],
  ]) {
    pair = await connectStream(hub, host, lease);
    send(pair.target, message);
    await Promise.all([closeFrame(pair.viewer, code, reason), closeFrame(pair.target, code, reason)]);
  }
  pair = await connectStream(hub, host, lease);
  pair.target.sendClose();
  await Promise.all([closeFrame(pair.viewer, 1001, 'peer_closed'), closeFrame(pair.target, 1000, '')]);
});

test('relay expires unauthenticated, pending, unacknowledged and leased sockets', async (t) => {
  let now = NOW;
  const hub = await fixture(t, {
    now: () => now,
    relay: { authTimeoutMs: 150, joinTimeoutMs: 200, ackTimeoutMs: 200, leaseTtlMs: 1800 },
  });
  await closeFrame(await ws(hub), 1008, 'auth_timeout');
  const host = await control(hub);
  const lease = await open(hub);
  assert.equal(lease.expires_at, NOW + 1800);
  const neverJoined = await startStream(hub, host, lease);
  await closeFrame(neverJoined.viewer, 1008, 'join_timeout');
  await closeFrame(await join(hub, neverJoined.incoming.connection_id), 1008, 'connection_not_found');
  const stalls = await connectStream(hub, host, lease);
  send(stalls.viewer, { type: 'data', data: 'AAAA' });
  assert.deepEqual(await stalls.target.nextJson(), { type: 'data', data: 'AAAA' });
  await Promise.all([closeFrame(stalls.viewer, 1008, 'ack_timeout'), closeFrame(stalls.target, 1008, 'ack_timeout')]);

  const stream = await connectStream(hub, host, lease);
  const idleLease = await open(hub);
  const other = await connectStream(hub, host, idleLease);
  now = lease.expires_at;
  send(stream.viewer, { type: 'data', data: 'AAAA' });
  await Promise.all([closeFrame(stream.viewer, 1001, 'lease_expired'), closeFrame(stream.target, 1001, 'lease_expired')]);
  await Promise.all([closeFrame(other.viewer, 1001, 'lease_expired'), closeFrame(other.target, 1001, 'lease_expired')]);
  const retry = await ws(hub);
  send(retry, { type: 'viewer', token: hub.owner.token, lease_id: lease.lease_id });
  await closeFrame(retry, 1008, 'lease_not_found');
  assert.equal((await list(hub, hub.target)).json.control_ready, true);
});

test('frame floods and failed relay keepalive revoke hosting without touching the legacy sync socket', async (t) => {
  const hub = await fixture(t, { relay: { pingIntervalMs: 20, pongTimeoutMs: 300 } });
  const sync = await openWebSocket(hub.url, { token: INSTANCE_TOKEN, deviceId: 'legacy-sync' });
  assert.deepEqual(await sync.nextJson(), { type: 'hello', device_id: 'legacy-sync' });
  const flooded = await control(hub, hub.sibling);
  const ping = encodeClientFrame(CLIENT_OPCODE.ping);
  flooded.socket.write(Buffer.concat(Array(1024).fill(ping)));
  await closeFrame(flooded, 1008, 'rate_limited');

  const host = await control(hub, hub.target, FINGERPRINT, { autoPong: false });
  const lease = await open(hub);
  const pair = await connectStream(hub, host, lease);
  await Promise.all([
    closeFrame(host, 1001, 'pong_timeout'),
    closeFrame(pair.viewer, 1001, 'host_closed'), closeFrame(pair.target, 1001, 'host_closed'),
  ]);
  httpError(await requestOpen(hub, hub.owner, hub.target), 409, 'web_not_enabled');
  send(sync, { type: 'ping' });
  assert.deepEqual(await sync.nextJson(), { type: 'pong' });
});

test('relay quotas bound leases and pending streams and release capacity when sockets close', async (t) => {
  const hub = await fixture(t);
  const host = await control(hub);
  const leases = [];
  for (let i = 0; i < 8; i += 1) leases.push(await open(hub));
  httpError(await requestOpen(hub, hub.owner, hub.target), 429, 'rate_limited');
  for (let i = 0; i < 8; i += 1) await open(hub, hub.sibling);
  httpError(await requestOpen(hub, hub.identity('Another viewer'), hub.target), 429, 'rate_limited');

  const first = [];
  for (let i = 0; i < 8; i += 1) first.push(await startStream(hub, host, leases[0]));
  const rejected = await ws(hub);
  send(rejected, { type: 'viewer', token: hub.owner.token, lease_id: leases[0].lease_id });
  await closeFrame(rejected, 1008, 'rate_limited');
  first[0].viewer.sendClose();
  await closeFrame(first[0].viewer, 1000, '');
  await closeFrame(await join(hub, first[0].incoming.connection_id), 1008, 'connection_not_found');
  await startStream(hub, host, leases[0]);
  for (const lease of leases.slice(1, 4)) {
    for (let i = 0; i < 8; i += 1) await startStream(hub, host, lease);
  }
  const hostAtCapacity = await ws(hub);
  send(hostAtCapacity, { type: 'viewer', token: hub.owner.token, lease_id: leases[4].lease_id });
  await closeFrame(hostAtCapacity, 1008, 'rate_limited');

  const close = (viewer) => call(hub.url, PATH + '/close', {
    method: 'POST', token: viewer.token, body: { lease_id: leases[0].lease_id },
  });
  assert.deepEqual((await close(hub.sibling)).json, { closed: true });
  httpError(await requestOpen(hub, hub.owner, hub.target), 429, 'rate_limited');
  assert.deepEqual((await close(hub.owner)).json, { closed: true });
  assert.deepEqual((await close(hub.owner)).json, { closed: true });
  await closeFrame(first[1].viewer, 1001, 'viewer_closed');
  await open(hub);
});
