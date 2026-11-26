import { createHash } from 'node:crypto';
import { STATUS_CODES } from 'node:http';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** A single WebSocket frame is capped at 1 MiB by contract. */
export const MAX_FRAME_BYTES = 1024 * 1024;
export const PING_INTERVAL_MS = 30_000;
export const PONG_TIMEOUT_MS = 90_000;
export const WS_PATH = '/api/v1/ws';

export const OPCODE = Object.freeze({
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
});

/** RFC 6455 protocol violations close the connection with these codes. */
export class WsFrameError extends Error {
  /**
   * @param {string} message
   * @param {number} [code]
   */
  constructor(message, code = 1002) {
    super(message);
    this.name = 'WsFrameError';
    this.code = code;
  }
}

/** @param {string} key */
export function acceptKey(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/**
 * Encode an unmasked server-to-client frame.
 * @param {number} opcode
 * @param {Buffer | Uint8Array | string} [payload]
 * @param {{fin?: boolean}} [options]
 * @returns {Buffer}
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0), options = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const fin = options.fin ?? true;
  const first = (fin ? 0x80 : 0) | opcode;
  let header;
  if (data.length < 126) {
    header = Buffer.from([first, data.length]);
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

/**
 * Parse one client frame from the front of buffer. Returns null when the frame is
 * incomplete; throws WsFrameError for protocol violations (including frames
 * larger than 1 MiB, which must be rejected before buffering their payload).
 * @param {Buffer | Uint8Array} buffer
 * @param {{requireMask?: boolean, maxPayloadBytes?: number}} [options]
 * @returns {{frame: {fin: boolean, opcode: number, payload: Buffer}, rest: Buffer} | null}
 */
export function parseFrame(buffer, options = {}) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const requireMask = options.requireMask ?? true;
  const maxPayloadBytes = options.maxPayloadBytes ?? MAX_FRAME_BYTES;
  if (data.length < 2) return null;

  const first = data[0];
  const second = data[1];
  if (first & 0x70) throw new WsFrameError('reserved bits must be zero');

  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  if (opcode > 0x2 && opcode < 0x8) throw new WsFrameError(`reserved opcode ${opcode}`);
  if (opcode > 0xa) throw new WsFrameError(`reserved opcode ${opcode}`);

  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (opcode >= 0x8) {
    if (!fin) throw new WsFrameError('control frames must not be fragmented');
    if (length > 125) throw new WsFrameError('control frame payload too large');
  }

  if (length === 126) {
    if (data.length < 4) return null;
    length = data.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (data.length < 10) return null;
    const wide = data.readBigUInt64BE(2);
    if (wide > BigInt(maxPayloadBytes)) throw new WsFrameError(frameLimitReason(maxPayloadBytes), 1009);
    length = Number(wide);
    offset = 10;
  }
  if (length > maxPayloadBytes) throw new WsFrameError(frameLimitReason(maxPayloadBytes), 1009);
  if (requireMask && !masked) throw new WsFrameError('client frames must be masked');

  const maskOffset = offset;
  if (masked) offset += 4;
  if (data.length < offset + length) return null;

  let payload;
  if (masked) {
    const mask = data.subarray(maskOffset, maskOffset + 4);
    payload = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) payload[i] = data[offset + i] ^ mask[i & 3];
  } else {
    payload = data.subarray(offset, offset + length);
  }

  return { frame: { fin, opcode, payload }, rest: data.subarray(offset + length) };
}

function frameLimitReason(limit) {
  return limit === MAX_FRAME_BYTES ? 'frame exceeds 1 MiB' : 'frame exceeds configured limit';
}

/**
 * @param {number} [code]
 * @param {string} [reason]
 * @returns {Buffer}
 */
export function closePayload(code = 1000, reason = '') {
  const text = Buffer.from(String(reason), 'utf8').subarray(0, 123);
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return payload;
}

/**
 * Reject an HTTP Upgrade with a JSON error, keeping the same error envelope as
 * the REST endpoints.
 * @param {import('node:net').Socket} socket
 * @param {number} status
 * @param {string} code
 * @param {string} [message]
 * @param {Record<string, string>} [extraHeaders]
 */
export function rejectUpgrade(socket, status, code, message, extraHeaders = {}) {
  const body = JSON.stringify({ error: { code, message: message ?? code } });
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    connection: 'close',
    ...extraHeaders,
  };
  let head = `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\n`;
  for (const [name, value] of Object.entries(headers)) head += `${name}: ${value}\r\n`;
  head += '\r\n';
  try {
    socket.end(head + body);
  } catch {
    socket.destroy();
  }
}

/** Complete the common RFC 6455 handshake. Relay opts into canonical key validation. */
export function acceptHandshake(req, socket, { strictKey = false } = {}) {
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
    rejectUpgrade(socket, 405, 'method_not_allowed', 'WebSocket handshake must use GET');
    return false;
  }
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  const connection = String(req.headers.connection ?? '').toLowerCase();
  if (upgrade !== 'websocket' || !connection.split(/\s*,\s*/).includes('upgrade')) {
    rejectUpgrade(socket, 400, 'invalid_handshake', 'WebSocket Upgrade headers required');
    return false;
  }
  const version = req.headers['sec-websocket-version'];
  if (String(version ?? '') !== '13') {
    rejectUpgrade(socket, 426, 'unsupported_websocket_version', 'Sec-WebSocket-Version must be 13', {
      'sec-websocket-version': '13',
    });
    return false;
  }
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !key.trim() || (strictKey && !/^[A-Za-z0-9+/]{21}[AQgw]==$/.test(key))) {
    rejectUpgrade(socket, 400, 'invalid_handshake', 'Sec-WebSocket-Key required');
    return false;
  }

  const response =
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key.trim())}\r\n\r\n`;
  socket.write(response);
  return true;
}

/**
 * In-memory WebSocket hub. Connections are double-indexed: a set for broadcasts
 * and a device_id -> set map so a specific device can be addressed later.
 */
export class WebSocketHub {
  /**
   * @param {{pingIntervalMs?: number, pongTimeoutMs?: number, logger?: {info?: Function, error?: Function}}} [options]
   */
  constructor(options = {}) {
    this.pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    this.pongTimeoutMs = options.pongTimeoutMs ?? PONG_TIMEOUT_MS;
    this.logger = options.logger ?? console;
    /** @type {Set<WebSocketConnection>} */
    this.connections = new Set();
    /** @type {Map<string, Set<WebSocketConnection>>} */
    this.byDevice = new Map();
    this.timer = null;
    this.closed = false;
  }

  /**
   * Complete the handshake and register the connection. The caller already
   * checked the path and bearer token.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:net').Socket} socket
   * @param {Buffer} head
   * @param {{deviceId: string}} options
   * @returns {boolean}
   */
  accept(req, socket, head, options) {
    if (this.closed) {
      rejectUpgrade(socket, 503, 'server_closed', 'hub is shutting down');
      return false;
    }
    if (!acceptHandshake(req, socket)) return false;

    const conn = new WebSocketConnection(this, socket, options.deviceId);
    this.connections.add(conn);
    let deviceSet = this.byDevice.get(options.deviceId);
    if (!deviceSet) {
      deviceSet = new Set();
      this.byDevice.set(options.deviceId, deviceSet);
    }
    deviceSet.add(conn);
    this.#ensureTimer();

    // Contract: hello is the first server frame after the handshake.
    conn.sendJson({ type: 'hello', device_id: options.deviceId });
    if (head && head.length) conn.feedData(head);
    return true;
  }

  /** @param {string} deviceId @param {Record<string, unknown>} event */
  sendToDevice(deviceId, event) {
    const targets = this.byDevice.get(deviceId);
    if (!targets) return 0;
    const frame = encodeFrame(OPCODE.text, Buffer.from(JSON.stringify(event)));
    let sent = 0;
    for (const conn of targets) {
      if (conn.sendRaw(frame)) sent += 1;
    }
    return sent;
  }

  /** @param {Record<string, unknown>} event */
  broadcast(event) {
    if (this.connections.size === 0) return 0;
    const frame = encodeFrame(OPCODE.text, Buffer.from(JSON.stringify(event)));
    let sent = 0;
    for (const conn of this.connections) {
      if (conn.sendRaw(frame)) sent += 1;
    }
    return sent;
  }

  /** @param {WebSocketConnection} conn */
  remove(conn) {
    this.connections.delete(conn);
    const deviceSet = this.byDevice.get(conn.deviceId);
    if (deviceSet) {
      deviceSet.delete(conn);
      if (deviceSet.size === 0) this.byDevice.delete(conn.deviceId);
    }
    if (this.connections.size === 0) this.#stopTimer();
  }

  #ensureTimer() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.#heartbeat(), this.pingIntervalMs);
    this.timer.unref?.();
  }

  #stopTimer() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  #heartbeat() {
    const now = Date.now();
    for (const conn of [...this.connections]) {
      if (now - conn.lastPongAt >= this.pongTimeoutMs) {
        conn.close(1001, 'pong timeout');
        continue;
      }
      conn.ping();
    }
  }

  get size() {
    return this.connections.size;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.#stopTimer();
    for (const conn of [...this.connections]) conn.terminate(1001, 'server shutdown');
    this.connections.clear();
    this.byDevice.clear();
  }
}

/** One upgraded socket: frame buffering, fragmentation, ping/pong, cleanup. */
class WebSocketConnection {
  /**
   * @param {WebSocketHub} hub
   * @param {import('node:net').Socket} socket
   * @param {string} deviceId
   */
  constructor(hub, socket, deviceId) {
    this.hub = hub;
    this.socket = socket;
    this.deviceId = deviceId;
    /** Bytes received but not yet parsed into a complete frame. */
    this.buffer = Buffer.alloc(0);
    /** Set while a fragmented text message is being assembled. */
    this.fragments = null;
    this.lastPongAt = Date.now();
    this.closeSent = false;
    this.closed = false;

    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => this.feedData(chunk));
    socket.on('close', () => this.#destroy());
    socket.on('error', () => this.#destroy());
  }

  /** @param {Buffer} chunk */
  feedData(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (!this.closed) {
      let parsed;
      try {
        parsed = parseFrame(this.buffer);
      } catch (error) {
        this.close(error.code ?? 1002, error.message);
        return;
      }
      if (!parsed) return;
      this.buffer = parsed.rest;
      try {
        this.#onFrame(parsed.frame);
      } catch (error) {
        this.close(error.code ?? 1002, error.message);
        return;
      }
    }
  }

  /** @param {{fin: boolean, opcode: number, payload: Buffer}} frame */
  #onFrame(frame) {
    switch (frame.opcode) {
      case OPCODE.text:
        if (this.fragments) throw new WsFrameError('new data frame while fragmented');
        if (frame.fin) {
          this.#onMessage(frame.payload);
        } else {
          this.fragments = { chunks: [frame.payload], size: frame.payload.length };
        }
        break;
      case OPCODE.continuation:
        if (!this.fragments) throw new WsFrameError('unexpected continuation frame');
        this.fragments.size += frame.payload.length;
        if (this.fragments.size > MAX_FRAME_BYTES) throw new WsFrameError('message exceeds 1 MiB', 1009);
        this.fragments.chunks.push(frame.payload);
        if (frame.fin) {
          const payload = Buffer.concat(this.fragments.chunks);
          this.fragments = null;
          this.#onMessage(payload);
        }
        break;
      case OPCODE.binary:
        throw new WsFrameError('binary frames are not supported', 1003);
      case OPCODE.ping:
        this.sendRaw(encodeFrame(OPCODE.pong, frame.payload));
        break;
      case OPCODE.pong:
        this.lastPongAt = Date.now();
        break;
      case OPCODE.close:
        this.#onClose(frame.payload);
        break;
      default:
        throw new WsFrameError(`unsupported opcode ${frame.opcode}`);
    }
  }

  /** @param {Buffer} payload */
  #onMessage(payload) {
    let message;
    try {
      message = JSON.parse(payload.toString('utf8'));
    } catch {
      return;
    }
    if (message && message.type === 'ping') this.sendJson({ type: 'pong' });
  }

  /** @param {Buffer} payload */
  #onClose(payload) {
    let code = 1000;
    if (payload.length >= 2) code = payload.readUInt16BE(0);
    if (!this.closeSent) this.closeSent = true;
    if (!this.closed) {
      this.sendRaw(encodeFrame(OPCODE.close, closePayload(code, '')));
      this.closed = true;
      this.hub.remove(this);
      try {
        this.socket.end();
      } catch {
        this.socket.destroy();
      }
    }
  }

  /** @param {Buffer} frame */
  sendRaw(frame) {
    if (this.closed || !this.socket.writable) return false;
    try {
      this.socket.write(frame);
      return true;
    } catch {
      return false;
    }
  }

  /** @param {Record<string, unknown>} value */
  sendJson(value) {
    return this.sendRaw(encodeFrame(OPCODE.text, Buffer.from(JSON.stringify(value))));
  }

  ping() {
    this.sendRaw(encodeFrame(OPCODE.ping));
  }

  /**
   * Server-initiated close handshake: send Close, then FIN the TCP stream.
   * @param {number} [code]
   * @param {string} [reason]
   */
  close(code = 1000, reason = '') {
    if (this.closed) return;
    if (!this.closeSent) {
      this.closeSent = true;
      this.sendRaw(encodeFrame(OPCODE.close, closePayload(code, reason)));
    }
    this.closed = true;
    this.hub.remove(this);
    try {
      this.socket.end();
    } catch {
      this.socket.destroy();
    }
    const timer = setTimeout(() => this.socket.destroy(), 1000);
    timer.unref?.();
  }

  /** Abrupt teardown, used on hub shutdown. */
  terminate(code = 1001, reason = '') {
    if (!this.closeSent) this.sendRaw(encodeFrame(OPCODE.close, closePayload(code, reason)));
    this.closeSent = true;
    this.#destroy();
  }

  #destroy() {
    if (this.closed && !this.hub.connections.has(this)) return;
    this.closed = true;
    this.fragments = null;
    this.hub.remove(this);
    this.socket.destroy();
  }
}
