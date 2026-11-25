import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const CLIENT_OPCODE = Object.freeze({ text: 0x1, close: 0x8, ping: 0x9, pong: 0xa });

export function websocketAccept(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/**
 * Client-side masked frame encoder. Deliberately independent from src/ws.js so
 * the transport test does not share an implementation with the server.
 * @param {number} opcode
 * @param {Buffer | string} [payload]
 * @param {boolean} [fin]
 */
export function encodeClientFrame(opcode, payload = Buffer.alloc(0), fin = true) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = randomBytes(4);
  const first = (fin ? 0x80 : 0) | opcode;
  let header;
  if (data.length < 126) {
    header = Buffer.from([first, data.length | 0x80]);
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) masked[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/**
 * Read the HTTP handshake off the socket, returning the leftover bytes that
 * belong to the WebSocket stream.
 * @param {import('node:net').Socket} socket
 * @param {number} timeoutMs
 */
function readHandshake(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('WebSocket handshake timed out'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buffer.subarray(0, end).toString('latin1');
      const rest = buffer.subarray(end + 4);
      const lines = head.split('\r\n');
      const statusLine = /^HTTP\/1\.1 (\d{3})/.exec(lines[0] ?? '');
      /** @type {Record<string, string>} */
      const headers = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      cleanup();
      resolve({ status: Number(statusLine?.[1] ?? 0), headers, rest });
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

/**
 * @param {string} baseUrl
 * @param {{token?: string, deviceId?: string, headers?: Record<string,string>, query?: string, timeoutMs?: number}} [options]
 */
export async function openWebSocket(baseUrl, options = {}) {
  const url = new URL('/api/v1/ws', baseUrl);
  if (options.deviceId) url.searchParams.set('device_id', options.deviceId);
  if (options.token) url.searchParams.set('token', options.token);
  if (options.query) for (const [key, value] of Object.entries(options.query)) url.searchParams.set(key, value);

  const key = randomBytes(16).toString('base64');
  const socket = connect({ host: url.hostname, port: Number(url.port) });
  socket.setNoDelay?.(true);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  const extra = Object.entries(options.headers ?? {}).map(([name, value]) => `${name}: ${value}`);
  const request = [
    `GET ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    ...extra,
    '',
    '',
  ].join('\r\n');
  socket.write(request);

  const result = await readHandshake(socket, options.timeoutMs ?? 3000);
  if (result.status !== 101) {
    socket.destroy();
    const error = new Error(`WebSocket handshake failed with ${result.status}`);
    error.status = result.status;
    error.headers = result.headers;
    throw error;
  }
  if (result.headers['sec-websocket-accept'] !== websocketAccept(key)) {
    socket.destroy();
    throw new Error('invalid Sec-WebSocket-Accept');
  }
  return new TestWebSocket(socket, result.rest, options);
}

/** Minimal client used by tests: unmasked server frames, masked client frames. */
export class TestWebSocket {
  /**
   * @param {import('node:net').Socket} socket
   * @param {Buffer} initial
   * @param {{autoPong?: boolean}} [options]
   */
  constructor(socket, initial = Buffer.alloc(0), options = {}) {
    this.socket = socket;
    this.autoPong = options.autoPong ?? true;
    this.buffer = Buffer.alloc(0);
    /** @type {Array<{opcode: number, payload: Buffer}>} */
    this.frames = [];
    /** @type {Array<{resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
    this.waiters = [];
    this.closed = false;
    /** @type {{code: number, reason: string} | null} */
    this.closeEvent = null;
    this.fragments = null;

    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#onClose());
    socket.on('error', () => this.#onClose());
    if (initial.length) this.#onData(initial);
  }

  /** @param {Buffer} chunk */
  #onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (true) {
      const parsed = parseServerFrame(this.buffer);
      if (!parsed) return;
      this.buffer = parsed.rest;
      const frame = parsed.frame;

      if (frame.opcode === 0x9) {
        if (this.autoPong) this.sendPong(frame.payload);
        this.#push(frame);
        continue;
      }
      if (frame.opcode === 0xa) {
        this.#push(frame);
        continue;
      }
      if (frame.opcode === 0x8) {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        const reason = frame.payload.subarray(2).toString('utf8');
        this.closeEvent = { code, reason };
        this.#push(frame);
        continue;
      }
      if (!frame.fin) {
        this.fragments = this.fragments ?? { opcode: frame.opcode, chunks: [] };
        this.fragments.chunks.push(frame.payload);
        continue;
      }
      if (this.fragments) {
        this.fragments.chunks.push(frame.payload);
        const payload = Buffer.concat(this.fragments.chunks);
        const opcode = this.fragments.opcode;
        this.fragments = null;
        this.#push({ opcode, payload });
        continue;
      }
      this.#push(frame);
    }
  }

  /** @param {{opcode: number, payload: Buffer}} frame */
  #push(frame) {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    this.frames.push(frame);
  }

  #onClose() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('WebSocket closed'));
    }
  }

  /** @param {number} timeoutMs */
  nextFrame(timeoutMs = 3000) {
    if (this.frames.length) return Promise.resolve(this.frames.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('timed out waiting for a WebSocket frame'));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  /**
   * Read text frames until predicate matches. Non-matching events are dropped,
   * which is fine for event-stream assertions.
   * @param {(value: any) => boolean} [predicate]
   * @param {number} [timeoutMs]
   */
  async nextJson(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frame = await this.nextFrame(Math.max(1, deadline - Date.now()));
      if (frame.opcode !== 0x1) continue;
      let value;
      try {
        value = JSON.parse(frame.payload.toString('utf8'));
      } catch {
        continue;
      }
      if (!predicate || predicate(value)) return value;
    }
    throw new Error('timed out waiting for a matching WebSocket JSON message');
  }

  /** @param {string} text */
  sendText(text) {
    this.socket.write(encodeClientFrame(CLIENT_OPCODE.text, Buffer.from(text, 'utf8')));
  }

  /** @param {Buffer | string} [payload] */
  sendPong(payload = Buffer.alloc(0)) {
    this.socket.write(encodeClientFrame(CLIENT_OPCODE.pong, payload));
  }

  /** @param {number} [code] */
  sendClose(code = 1000) {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.socket.write(encodeClientFrame(CLIENT_OPCODE.close, payload));
  }

  close() {
    if (!this.closed) {
      try {
        this.sendClose(1000);
      } catch {
        /* ignore */
      }
    }
    this.socket.end();
    this.socket.destroySoon?.();
  }
}

/**
 * Parse an unmasked (server) frame.
 * @param {Buffer} buffer
 * @returns {{frame: {fin: boolean, opcode: number, payload: Buffer}, rest: Buffer} | null}
 */
export function parseServerFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  let mask;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;
  let payload = buffer.subarray(offset, offset + length);
  if (masked) {
    const unmasked = Buffer.alloc(length);
    for (let i = 0; i < length; i += 1) unmasked[i] = payload[i] ^ mask[i & 3];
    payload = unmasked;
  }
  return { frame: { fin, opcode, payload }, rest: buffer.subarray(offset + length) };
}
