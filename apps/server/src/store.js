import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HttpError, nowIso, randomId, sha256 } from './util.js';
import { normalizeSession, summaryOf } from './model.js';

const EMPTY = () => ({ version: 1, createdAt: nowIso(), devices: {}, sessions: {}, revision: 0 });

/**
 * Single-process, file-backed store.
 *
 * Durability contract: the JSON file is replaced atomically (tmp + rename) after
 * every mutation, so a crash cannot leave a half-written file. Concurrency is
 * handled by serializing mutations through one promise chain; read paths read
 * the in-memory copy. Multi-process deployments are explicitly unsupported —
 * use one relay process per data directory.
 */
export class Store {
  /** @param {{dataDir: string, fileName?: string}} options */
  constructor(options) {
    this.dataDir = options.dataDir;
    this.file = join(options.dataDir, options.fileName ?? 'relay-store.json');
    this.state = EMPTY();
    this._queue = Promise.resolve();
  }

  async load() {
    await mkdir(dirname(this.file), { recursive: true });
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.sessions) throw new Error('bad shape');
      this.state = { ...EMPTY(), ...parsed };
    } catch (error) {
      if (error && /** @type {any} */ (error).code !== 'ENOENT') throw error;
      this.state = EMPTY();
      await this.#flush();
    }
    return this;
  }

  get revision() {
    return this.state.revision;
  }

  #mutate(fn) {
    const run = this._queue.then(async () => {
      const result = fn();
      await this.#flush();
      return result;
    });
    this._queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #flush() {
    const tmp = this.file + '.tmp';
    await writeFile(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  /** @param {{name: string, platform?: string, hostname?: string, capabilities?: Record<string, unknown>}} input */
  registerDevice(input) {
    const name = String(input.name ?? '').trim();
    if (!name) throw new HttpError(422, 'device_name_required');
    const existing = Object.values(this.state.devices).find((d) => d.name === name && !d.revokedAt);
    const secret = randomId('dsec_', 24);
    const deviceId = existing?.id ?? randomId('dev_', 9);
    const token = `${deviceId}.${secret}`;
    const record = {
      id: deviceId,
      name,
      platform: input.platform ?? 'unknown',
      hostname: input.hostname ?? null,
      capabilities: input.capabilities ?? {},
      createdAt: existing?.createdAt ?? nowIso(),
      lastSeenAt: nowIso(),
      tokenHash: sha256(token),
      revokedAt: null,
    };
    return this.#mutate(() => {
      this.state.devices[deviceId] = record;
      return { device: publicDevice(record), token, rotated: Boolean(existing) };
    });
  }

  /** @param {string} token */
  findDeviceByToken(token) {
    const [deviceId] = String(token).split('.');
    const device = this.state.devices[deviceId];
    if (!device || device.revokedAt) return null;
    if (device.tokenHash !== sha256(token)) return null;
    return device;
  }

  touchDevice(deviceId) {
    const device = this.state.devices[deviceId];
    if (!device) return;
    device.lastSeenAt = nowIso();
    // Not flushed on every heartbeat on purpose: lastSeenAt is advisory.
  }

  listDevices() {
    return Object.values(this.state.devices).map(publicDevice);
  }

  /** @param {{deviceId: string, sessions: unknown[], deleted?: string[], full?: boolean}} payload */
  syncSessions(payload) {
    const deletedIds = Array.isArray(payload.deleted) ? payload.deleted.filter((x) => typeof x === 'string') : [];
    const incoming = Array.isArray(payload.sessions) ? payload.sessions : [];
    return this.#mutate(() => {
      const accepted = [];
      const skipped = [];
      const removed = [];
      for (const raw of incoming) {
        const candidate = normalizeSession(raw, payload.deviceId, this.state.revision + 1);
        const existing = this.state.sessions[candidate.id];
        if (existing && existing.deviceId === candidate.deviceId) {
          const existingTime = Date.parse(existing.updatedAt);
          const candidateTime = Date.parse(candidate.updatedAt);
          if (Number.isFinite(existingTime) && candidateTime < existingTime) {
            skipped.push(candidate.id);
            continue;
          }
        }
        this.state.revision += 1;
        candidate.revision = this.state.revision;
        this.state.sessions[candidate.id] = candidate;
        accepted.push(candidate.id);
      }
      for (const id of deletedIds) {
        const existing = this.state.sessions[id];
        if (existing && existing.deviceId === payload.deviceId) {
          delete this.state.sessions[id];
          removed.push(id);
        }
      }
      if (payload.full === true) {
        const keep = new Set(accepted);
        for (const [id, session] of Object.entries(this.state.sessions)) {
          if (session.deviceId === payload.deviceId && !keep.has(id)) {
            delete this.state.sessions[id];
            removed.push(id);
          }
        }
      }
      return { accepted, skipped, removed, cursor: this.state.revision };
    });
  }

  listSessions({ deviceId, query, limit = 50, cursor = 0 } = {}) {
    let rows = Object.values(this.state.sessions);
    if (deviceId) rows = rows.filter((s) => s.deviceId === deviceId);
    if (query) {
      const needle = String(query).toLowerCase();
      rows = rows.filter(
        (s) =>
          s.title.toLowerCase().includes(needle) ||
          s.workspace.toLowerCase().includes(needle) ||
          s.id.toLowerCase().includes(needle),
      );
    }
    rows.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
    const filtered = cursor ? rows.filter((s) => s.revision > Number(cursor)) : rows;
    const page = filtered.slice(0, limit);
    return {
      sessions: page.map(summaryOf),
      nextCursor: filtered.length > page.length ? String(page[page.length - 1].revision) : null,
      total: filtered.length,
    };
  }

  getSession(id) {
    return this.state.sessions[id] ?? null;
  }

  deleteSession(id, { deviceId } = {}) {
    return this.#mutate(() => {
      const existing = this.state.sessions[id];
      if (!existing) return false;
      if (deviceId && existing.deviceId !== deviceId) return false;
      delete this.state.sessions[id];
      return true;
    });
  }
}

export function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    hostname: device.hostname,
    capabilities: device.capabilities,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    revoked: Boolean(device.revokedAt),
  };
}
