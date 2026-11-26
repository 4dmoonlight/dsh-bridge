import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDatabase } from '../src/db.js';
import { WebDb } from '../src/web-db.js';

const START = Date.parse('2026-01-01T00:00:00Z');
const SUBJECT_A = 'fixture-google-subject-a';
const SUBJECT_B = 'fixture-google-subject-b';

function openWeb(t, now = () => START) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  return new WebDb(database, now);
}

function signIn(web, subject, device = null, deviceName = 'Same device name') {
  return web.signInGoogle({ deviceId: device?.device_id ?? null, subject, deviceName });
}

function peerIds(web, device) {
  return web.listPeers(device.device_id).map((peer) => peer.device_id).sort();
}

test('new Google sign-ins issue distinct Web credentials and pair only matching subjects', (t) => {
  const web = openWeb(t);
  const first = signIn(web, SUBJECT_A);
  assert.deepEqual(peerIds(web, first), []);
  const second = signIn(web, SUBJECT_A);
  const other = signIn(web, SUBJECT_B);
  const third = signIn(web, SUBJECT_A);
  const group = [first, second, third];
  const devices = [...group, other];
  assert.equal(new Set(devices.map((device) => device.device_id)).size, devices.length);
  assert.equal(new Set(devices.map((device) => device.token)).size, devices.length);
  for (const identity of devices) {
    assert.match(identity.token, /^web_[A-Za-z0-9_-]{43}$/);
    assert.equal(web.findDeviceId(identity.token), identity.device_id);
  }
  for (const identity of group) {
    assert.deepEqual(peerIds(web, identity), group.filter((peer) => peer !== identity).map((peer) => peer.device_id).sort());
  }
  assert.deepEqual(peerIds(web, other), []);

  const edges = web.database.prepare('SELECT * FROM web_pairs').all();
  assert.equal(edges.length, 3);
  assert.ok(edges.every((edge) => edge.first_device_id < edge.second_device_id));
  const bindings = web.database.prepare('SELECT * FROM web_google_bindings').all();
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  assert.deepEqual(
    new Map(bindings.map((row) => [row.device_id, row.subject_hash])),
    new Map(devices.map((device) => [device.device_id, digest(device === other ? SUBJECT_B : SUBJECT_A)])),
  );
});

test('binding a Web device preserves presence, invitations, old credentials and ordinary unpairing', (t) => {
  let now = START;
  const web = openWeb(t, () => now);
  const manualPeer = signIn(web, SUBJECT_B);
  const existing = web.claimCode({ code: web.issueCode(manualPeer.device_id).code, deviceId: null, deviceName: 'Legacy' });
  const pending = web.issueCode(existing.device_id);
  const sibling = signIn(web, SUBJECT_A);
  const origin = 'https://example.test';
  web.publishPresence(existing.device_id, 'Published name', origin);
  now += 50_000;

  assert.deepEqual(signIn(web, SUBJECT_A, existing), { device_id: existing.device_id });
  assert.equal(web.findDeviceId(existing.token), existing.device_id);
  assert.deepEqual(peerIds(web, existing), [manualPeer.device_id, sibling.device_id].sort());
  assert.deepEqual(web.listPeers(sibling.device_id), [{
    device_id: existing.device_id, device_name: 'Published name', status: 'online', web_enabled: true,
  }]);
  assert.deepEqual(web.findPeer(sibling.device_id, existing.device_id), { status: 'online', url: origin });
  assert.throws(() => signIn(web, SUBJECT_B, existing), { status: 409, code: 'google_account_mismatch' });
  now += 10_001;
  assert.deepEqual(web.findPeer(sibling.device_id, existing.device_id), { status: 'offline', url: origin });

  assert.equal(web.unpair(existing.device_id, sibling.device_id), true);
  assert.equal(web.unpair(sibling.device_id, existing.device_id), false);
  for (const device of [existing, sibling]) {
    assert.deepEqual(signIn(web, SUBJECT_A, device), { device_id: device.device_id });
  }
  const newcomer = signIn(web, SUBJECT_A);
  assert.deepEqual(peerIds(web, newcomer), [existing.device_id, sibling.device_id].sort());
  assert.equal(web.findPeer(sibling.device_id, existing.device_id), null);
  assert.deepEqual(peerIds(web, manualPeer), [existing.device_id]);

  const invited = web.claimCode({ code: pending.code, deviceId: null, deviceName: 'Invited Web device' });
  assert.deepEqual(peerIds(web, invited), [existing.device_id]);
});

test('pairing failure rolls back new identities, upgrades and partially inserted edges', (t) => {
  const web = openWeb(t);
  const first = signIn(web, SUBJECT_A);
  const second = signIn(web, SUBJECT_A);
  const existing = web.createDevice('Existing');
  const snapshot = () => ['web_devices', 'web_google_bindings', 'web_pairs'].map((table) => (
    web.database.prepare('SELECT * FROM ' + table + ' ORDER BY 1, 2').all()
  ));
  const before = snapshot();
  // FAIL keeps previous writes to this statement; the transaction must undo them too.
  web.database.exec(`
    CREATE TRIGGER fail_second_new_edge BEFORE INSERT ON web_pairs
    WHEN (SELECT COUNT(*) FROM web_pairs) > 1
    BEGIN
      SELECT RAISE(FAIL, 'forced Web pair failure');
    END;
  `);
  for (const device of [null, existing]) {
    assert.throws(() => signIn(web, SUBJECT_A, device), /forced Web pair failure/);
    assert.deepEqual(snapshot(), before);
  }
  web.database.exec('DROP TRIGGER fail_second_new_edge');
  assert.deepEqual(signIn(web, SUBJECT_A, existing), { device_id: existing.device_id });
  assert.deepEqual(peerIds(web, existing), [first.device_id, second.device_id].sort());
});

test('legacy databases reopen without backfilling bindings, which persist separately from sync', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-web-google-test-'));
  const options = { dataDir, now: () => START };
  let db;
  t.after(() => {
    db?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  db = openDatabase(options);
  const legacy = db.web.createDevice('Legacy Web device');
  const oldPeer = db.web.claimCode({ code: db.web.issueCode(legacy.device_id).code, deviceId: null, deviceName: 'Old peer' });
  const sync = db.upsertDevice({ deviceId: 'sync-only', deviceName: 'Legacy Web device', platform: 'macos' });
  const syncCredential = db.createDeviceToken(sync.device_id, 'read:all,write:self');
  // Recreate the pre-Google schema while leaving real legacy rows intact.
  db.database.exec('DROP TABLE web_google_bindings');
  db.close();

  db = openDatabase(options);
  assert.deepEqual(db.database.prepare('SELECT * FROM web_google_bindings').all(), []);
  assert.equal(db.web.findDeviceId(legacy.token), legacy.device_id);
  assert.deepEqual(peerIds(db.web, legacy), [oldPeer.device_id]);
  assert.throws(() => signIn(db.web, SUBJECT_A, sync), { status: 401, code: 'unauthorized' });
  assert.equal(db.web.findDeviceId(syncCredential.token), null);
  const google = signIn(db.web, SUBJECT_A);
  assert.deepEqual(peerIds(db.web, google), []);
  signIn(db.web, SUBJECT_A, legacy);
  signIn(db.web, SUBJECT_A, oldPeer); // An existing edge in the same group is not duplicated.
  db.close();

  db = openDatabase(options);
  assert.equal(db.web.findDeviceId(legacy.token), legacy.device_id);
  assert.equal(db.web.findDeviceId(google.token), google.device_id);
  assert.deepEqual(peerIds(db.web, legacy), [oldPeer.device_id, google.device_id].sort());
  assert.deepEqual(peerIds(db.web, google), [legacy.device_id, oldPeer.device_id].sort());
  assert.throws(() => signIn(db.web, SUBJECT_B, legacy), { status: 409, code: 'google_account_mismatch' });
  assert.equal(db.findDeviceToken(google.token), null);
  assert.equal(db.findDeviceToken(syncCredential.token).device_id, sync.device_id);
  assert.deepEqual(db.listDevices().map((device) => device.device_id), [sync.device_id]);
});
