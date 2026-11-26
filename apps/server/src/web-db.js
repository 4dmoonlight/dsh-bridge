import { randomBytes, randomUUID } from 'node:crypto';
import { HttpError, randomId, sha256 } from './util.js';

const PAIRING_TTL_MS = 10 * 60_000;
const OFFLINE_AFTER_MS = 60_000;

// No foreign keys or backfills from the sync tables: a Web identity and its
// pairwise authorizations exist only after explicit Web enrollment/pairing.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS web_devices (
  device_id TEXT NOT NULL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  last_seen_at INTEGER,
  web_url TEXT
);
CREATE TABLE IF NOT EXISTS web_pairing_codes (
  code_hash TEXT NOT NULL PRIMARY KEY,
  issuer_device_id TEXT NOT NULL REFERENCES web_devices(device_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_pairing_expiration ON web_pairing_codes(expires_at);
CREATE TABLE IF NOT EXISTS web_pairs (
  first_device_id TEXT NOT NULL REFERENCES web_devices(device_id) ON DELETE CASCADE,
  second_device_id TEXT NOT NULL REFERENCES web_devices(device_id) ON DELETE CASCADE,
  CHECK (first_device_id < second_device_id),
  PRIMARY KEY (first_device_id, second_device_id)
);
CREATE INDEX IF NOT EXISTS idx_web_pairs_second ON web_pairs(second_device_id);
CREATE TABLE IF NOT EXISTS web_google_bindings (
  device_id TEXT NOT NULL PRIMARY KEY REFERENCES web_devices(device_id) ON DELETE CASCADE,
  subject_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_google_subject ON web_google_bindings(subject_hash, device_id);
`;

export class WebDb {
  constructor(database, now) {
    this.database = database;
    this.now = now;
    database.exec(SCHEMA);
    this.statements = {
      insertDevice: database.prepare('INSERT INTO web_devices (device_id, token_hash, device_name) VALUES (?, ?, ?)'),
      lookupDevice: database.prepare('SELECT device_id FROM web_devices WHERE token_hash = ?'),
      findGoogleBinding: database.prepare(`
        SELECT binding.subject_hash FROM web_devices AS device
        LEFT JOIN web_google_bindings AS binding USING (device_id)
        WHERE device.device_id = ?
      `),
      lookupRelayIdentity: database.prepare(`
        SELECT device_id, subject_hash FROM web_devices
        LEFT JOIN web_google_bindings USING (device_id) WHERE token_hash = ?
      `),
      listGoogleDevices: database.prepare(`
        SELECT device_id, device_name, last_seen_at
        FROM web_google_bindings JOIN web_devices USING (device_id)
        WHERE subject_hash = ? AND device_id <> ?
        ORDER BY device_name, device_id
      `),
      bindGoogle: database.prepare('INSERT INTO web_google_bindings (device_id, subject_hash) VALUES (?, ?)'),
      pairGoogleDevices: database.prepare(`
        INSERT INTO web_pairs (first_device_id, second_device_id)
        SELECT MIN(:deviceId, device_id), MAX(:deviceId, device_id)
        FROM web_google_bindings
        WHERE subject_hash = :subjectHash AND device_id <> :deviceId
        ON CONFLICT(first_device_id, second_device_id) DO NOTHING
      `),
      renameDevice: database.prepare('UPDATE web_devices SET device_name = ? WHERE device_id = ?'),
      publishPresence: database.prepare(
        'UPDATE web_devices SET device_name = ?, last_seen_at = ?, web_url = ? WHERE device_id = ?',
      ),
      issueCode: database.prepare(`
        INSERT INTO web_pairing_codes (code_hash, issuer_device_id, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(code_hash) DO NOTHING
      `),
      findCode: database.prepare('SELECT issuer_device_id FROM web_pairing_codes WHERE code_hash = ?'),
      consumeCode: database.prepare('DELETE FROM web_pairing_codes WHERE code_hash = ?'),
      purgeCodes: database.prepare('DELETE FROM web_pairing_codes WHERE expires_at <= ?'),
      pair: database.prepare(`
        INSERT INTO web_pairs (first_device_id, second_device_id) VALUES (?, ?)
        ON CONFLICT(first_device_id, second_device_id) DO NOTHING
      `),
      unpair: database.prepare('DELETE FROM web_pairs WHERE first_device_id = ? AND second_device_id = ?'),
      listPeers: database.prepare(`
        SELECT device_id, device_name, last_seen_at, web_url IS NOT NULL AS web_enabled
        FROM web_devices
        JOIN (
          SELECT second_device_id AS peer_id FROM web_pairs WHERE first_device_id = ?
          UNION ALL
          SELECT first_device_id AS peer_id FROM web_pairs WHERE second_device_id = ?
        ) ON device_id = peer_id
        ORDER BY device_name, device_id
      `),
      findPeer: database.prepare(`
        SELECT last_seen_at, web_url FROM web_devices
        WHERE device_id = ? AND EXISTS (
          SELECT 1 FROM web_pairs WHERE first_device_id = ? AND second_device_id = ?
        )
      `),
    };
    this.statements.purgeCodes.run(this.now());
  }

  createDevice(deviceName) {
    const deviceId = randomUUID();
    const token = randomId('web_', 32);
    this.statements.insertDevice.run(deviceId, sha256(token), deviceName);
    return { device_id: deviceId, token };
  }

  // The caller must verify Google's subject and prove ownership of any supplied Web identity.
  signInGoogle({ deviceId, subject, deviceName }) {
    if (typeof subject !== 'string' || !subject) throw new TypeError('Expected a verified Google subject');
    const subjectHash = sha256(subject);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const identity = deviceId === null ? this.createDevice(deviceName) : { device_id: deviceId };
      const binding = this.statements.findGoogleBinding.get(identity.device_id);
      if (!binding) throw new HttpError(401, 'unauthorized');
      if (binding.subject_hash === null) {
        this.statements.bindGoogle.run(identity.device_id, subjectHash);
        // Only first bindings add pairs. Later logins must respect manual unpairing.
        this.statements.pairGoogleDevices.run({ ':deviceId': identity.device_id, ':subjectHash': subjectHash });
      } else if (binding.subject_hash !== subjectHash) {
        throw new HttpError(409, 'google_account_mismatch');
      }
      this.database.exec('COMMIT');
      return identity;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  findDeviceId(token) {
    return this.statements.lookupDevice.get(sha256(token))?.device_id ?? null;
  }

  lookupRelayIdentity(token) {
    return this.statements.lookupRelayIdentity.get(sha256(token)) ?? null;
  }

  findGoogleSubject(deviceId) {
    return this.statements.findGoogleBinding.get(deviceId)?.subject_hash ?? null;
  }

  listGoogleDevices(subjectHash, excludingDeviceId) {
    const now = this.now();
    return this.statements.listGoogleDevices.all(subjectHash, excludingDeviceId).map((row) => ({
      device_id: row.device_id,
      device_name: row.device_name,
      status: statusAt(row.last_seen_at, now),
    }));
  }

  issueCode(issuerId) {
    const now = this.now();
    const expiresAt = now + PAIRING_TTL_MS;
    this.statements.purgeCodes.run(now);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = randomBytes(18).toString('base64url');
      if (this.statements.issueCode.run(sha256(code), issuerId, expiresAt).changes) {
        return { code, expires_at: new Date(expiresAt).toISOString() };
      }
    }
    throw new HttpError(500, 'pairing_code_failed');
  }

  claimCode({ code, deviceId, deviceName }) {
    const codeHash = sha256(code);
    // Serialize lookup/expiry/consumption, identity creation and the edge in
    // one transaction. Failed or self-claims must not use a valid code.
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.statements.purgeCodes.run(this.now());
      const invite = this.statements.findCode.get(codeHash);
      let identity = null;
      if (invite && invite.issuer_device_id === deviceId) {
        identity = 'self';
      } else if (invite) {
        this.statements.consumeCode.run(codeHash);
        identity = deviceId === null ? this.createDevice(deviceName) : { device_id: deviceId };
        this.statements.pair.run(...orderedPair(invite.issuer_device_id, identity.device_id));
        if (deviceId !== null) this.statements.renameDevice.run(deviceName, deviceId);
      }
      this.database.exec('COMMIT');
      return identity;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  publishPresence(deviceId, deviceName, webUrl) {
    this.statements.publishPresence.run(deviceName, this.now(), webUrl, deviceId);
  }

  listPeers(deviceId) {
    const now = this.now();
    return this.statements.listPeers.all(deviceId, deviceId).map((row) => ({
      device_id: row.device_id,
      device_name: row.device_name,
      status: statusAt(row.last_seen_at, now),
      web_enabled: Boolean(row.web_enabled),
    }));
  }

  findPeer(deviceId, peerId) {
    const row = this.statements.findPeer.get(peerId, ...orderedPair(deviceId, peerId));
    return row ? { status: statusAt(row.last_seen_at, this.now()), url: row.web_url } : null;
  }

  unpair(deviceId, peerId) {
    return Boolean(this.statements.unpair.run(...orderedPair(deviceId, peerId)).changes);
  }
}

function orderedPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

function statusAt(lastSeenAt, now) {
  return lastSeenAt !== null && lastSeenAt <= now && now - lastSeenAt <= OFFLINE_AFTER_MS ? 'online' : 'offline';
}
