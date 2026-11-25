/**
 * Minimal Server-Sent Events hub. One process, in-memory subscribers.
 * Event names: session.updated, session.deleted, device.updated.
 */
export class EventHub {
  constructor() {
    /** @type {Set<{res: import('node:http').ServerResponse, deviceId: string | null}>} */
    this.clients = new Set();
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {{deviceId?: string | null, heartbeatMs?: number}} options
   */
  subscribe(res, { deviceId = null, heartbeatMs = 15000 } = {}) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    const client = { res, deviceId };
    this.clients.add(client);
    const timer = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      res.write(': ping\n\n');
    }, heartbeatMs);
    timer.unref?.();
    const drop = () => {
      clearInterval(timer);
      this.clients.delete(client);
    };
    res.on('close', drop);
    res.on('error', drop);
    return drop;
  }

  /**
   * @param {string} event
   * @param {Record<string, unknown>} data
   */
  publish(event, data, { deviceId = null } = {}) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      if (deviceId && client.deviceId && client.deviceId !== deviceId) continue;
      if (client.res.writableEnded || client.res.destroyed) continue;
      client.res.write(frame);
    }
  }

  closeAll() {
    for (const client of this.clients) {
      try {
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }

  get size() {
    return this.clients.size;
  }
}
