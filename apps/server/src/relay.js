import { HttpError, nowIso, randomId } from './util.js';

/**
 * Online host command relay.
 *
 * A host keeps one long-poll open (GET /v1/host/commands). When a client asks the
 * relay to run a command on that host, the relay hands it to the parked poll and
 * resolves the HTTP request when the host posts the result. This is the same
 * "forward live when online, fall back to the stored copy when offline" split the
 * reference projects use, without a websocket dependency.
 */
export class RelayHub {
  /** @param {{commandTimeoutMs?: number, onlineWindowMs?: number}} [options] */
  constructor(options = {}) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? 10000;
    this.onlineWindowMs = options.onlineWindowMs ?? 60000;
    /** @type {Map<string, {deliver: (command: any) => boolean, cancel: () => void}>} */
    this.waiters = new Map();
    /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout, deviceId: string}>} */
    this.pending = new Map();
    /** @type {Map<string, string>} deviceId -> lastSeen ISO */
    this.online = new Map();
  }

  isOnline(deviceId) {
    const seen = this.online.get(deviceId);
    return Boolean(seen && Date.now() - Date.parse(seen) < this.onlineWindowMs);
  }

  /** True when the host currently has a parked command poll, i.e. can execute live. */
  hasPoll(deviceId) {
    return this.waiters.has(deviceId);
  }

  markSeen(deviceId) {
    this.online.set(deviceId, nowIso());
  }

  /**
   * Park a host poll. Resolves with {command} when dispatched, or null on timeout.
   *
   * `signal` lets the caller withdraw the poll when the host socket dies. Without
   * it a killed host kept a parked poll for the rest of its wait window, so live
   * fetches were dispatched into the void and timed out (504) instead of falling
   * back to the stored copy (409 host_offline).
   *
   * @param {string} deviceId
   * @param {number} waitMs
   * @param {AbortSignal} [signal]
   * @returns {Promise<{command: any} | null>}
   */
  park(deviceId, waitMs, signal) {
    this.markSeen(deviceId);
    this.waiters.get(deviceId)?.cancel();

    let settled = false;
    /** @type {(value: {command: any} | null) => void} */
    let resolveFn = () => {};
    const promise = new Promise((resolve) => {
      resolveFn = resolve;
    });

    let onAbort = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      if (this.waiters.get(deviceId)?.cancel === cancel) this.waiters.delete(deviceId);
      resolveFn(value);
    };

    const timer = setTimeout(() => finish(null), Math.max(0, waitMs));
    timer.unref?.();

    const cancel = () => finish(null);
    const deliver = (command) => {
      if (settled) return false;
      finish({ command });
      return true;
    };

    this.waiters.set(deviceId, { deliver, cancel });

    if (signal) {
      if (signal.aborted) {
        finish(null);
      } else {
        onAbort = () => finish(null);
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    return promise;
  }

  /**
   * @param {string} deviceId
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {number} [timeoutMs]
   */
  dispatch(deviceId, method, params, timeoutMs = this.commandTimeoutMs) {
    if (!this.isOnline(deviceId)) {
      throw new HttpError(409, 'host_offline', `device ${deviceId} is not connected`);
    }
    const waiter = this.waiters.get(deviceId);
    if (!waiter) throw new HttpError(409, 'host_offline', `device ${deviceId} has no open poll`);

    const id = randomId('cmd_', 9);
    const command = { id, method, params, createdAt: nowIso() };
    if (!waiter.deliver(command)) throw new HttpError(409, 'host_offline', 'poll closed while dispatching');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HttpError(504, 'host_timeout', `no result for ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, deviceId });
    });
  }

  /**
   * @param {string} commandId
   * @param {string} deviceId
   * @param {{ok: boolean, result?: unknown, error?: {code: string, message?: string}}} payload
   */
  complete(commandId, deviceId, payload) {
    const entry = this.pending.get(commandId);
    if (!entry) throw new HttpError(404, 'unknown_command', commandId);
    if (entry.deviceId !== deviceId) throw new HttpError(403, 'wrong_device');
    clearTimeout(entry.timer);
    this.pending.delete(commandId);
    entry.resolve(payload);
  }

  close() {
    for (const [, entry] of this.pending) clearTimeout(entry.timer);
    this.pending.clear();
    for (const [, waiter] of this.waiters) waiter.cancel();
    this.waiters.clear();
  }
}
