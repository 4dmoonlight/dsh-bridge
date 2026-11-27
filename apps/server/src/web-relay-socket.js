import { closePayload, encodeFrame, OPCODE, parseFrame } from './ws.js';

export const MAX_CHUNK_BYTES = 32 * 1024;
// Allow ordinary native Web assets to complete over fast local links without
// changing the sustained allowance or the bounded per-stream buffering.
export const RELAY_BYTE_BURST = 8 * 1024 * 1024;
export const RELAY_BYTES_PER_SECOND = 16 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 4 * Math.ceil(MAX_CHUNK_BYTES / 3) + 256;
const MAX_AUTH_BYTES = 2048;
const MAX_FRAGMENTS = 64;
const MAX_QUEUED_BYTES = 2 * MAX_MESSAGE_BYTES;
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Monotonic token bucket; the caller decides what a unit represents. */
export class RateLimit {
  constructor(burst, perSecond) {
    this.burst = burst;
    this.perMs = perSecond / 1000;
    this.tokens = burst;
    this.at = performance.now();
  }

  take(cost = 1) {
    const now = performance.now();
    this.tokens = Math.min(this.burst, this.tokens + (now - this.at) * this.perMs);
    this.at = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/** Relay-specific framing/limits; the legacy sync connection keeps its own policy. */
export class RelaySocket {
  constructor(socket, { onMessage, onClose, onDispose }) {
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.onDispose = onDispose;
    this.role = 'auth';
    this.closed = false;
    this.lastPongAt = performance.now();
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
    this.frames = new RateLimit(512, 1024);
    this.bytes = new RateLimit(RELAY_BYTE_BURST, RELAY_BYTES_PER_SECOND);
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.feedData(chunk));
    socket.on('end', () => this.terminate());
    socket.on('error', () => this.terminate());
    socket.on('close', () => {
      clearTimeout(this.destroyTimer);
      this.#markClosed();
      this.onDispose(this);
    });
  }

  feedData(chunk) {
    if (this.closed || !chunk.length) return;
    if (!this.bytes.take(chunk.length)) return this.close(1008, 'rate_limited');
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (!this.closed) {
      const limit = this.role === 'viewer' || this.role === 'join' ? MAX_MESSAGE_BYTES : MAX_AUTH_BYTES;
      let parsed;
      try {
        parsed = parseFrame(this.buffer, { maxPayloadBytes: limit });
      } catch (error) {
        return this.close(error.code ?? 1002, error.code === 1009 ? 'message_too_large' : 'invalid_frame');
      }
      if (!parsed) return;
      this.buffer = parsed.rest;
      if (!this.frames.take()) return this.close(1008, 'rate_limited');
      this.#frame(parsed.frame, limit);
    }
  }

  #frame({ fin, opcode, payload }, limit) {
    switch (opcode) {
      case OPCODE.text:
        if (this.fragments) return this.close(1002, 'invalid_fragment');
        if (fin) return this.#message(payload);
        this.fragments = { size: payload.length, chunks: [payload] };
        return;
      case OPCODE.continuation: {
        const fragments = this.fragments;
        if (!fragments) return this.close(1002, 'invalid_fragment');
        fragments.size += payload.length;
        if (fragments.size > limit || fragments.chunks.length >= MAX_FRAGMENTS) {
          return this.close(1009, 'message_too_large');
        }
        fragments.chunks.push(payload);
        if (!fin) return;
        this.fragments = null;
        return this.#message(Buffer.concat(fragments.chunks, fragments.size));
      }
      case OPCODE.binary:
        return this.close(1003, 'text_required');
      case OPCODE.ping:
        if (!this.#write(encodeFrame(OPCODE.pong, payload))) this.close(1008, 'backpressure');
        return;
      case OPCODE.pong:
        this.lastPongAt = performance.now();
        return;
      case OPCODE.close:
        return payload.length === 1 ? this.close(1002, 'invalid_frame') : this.close(1000);
    }
  }

  #message(payload) {
    let message;
    try {
      message = JSON.parse(decoder.decode(payload));
    } catch {
      return this.close(1007, 'invalid_json');
    }
    try {
      this.onMessage(this, message);
    } catch {
      // A parse/processing exception may include credentials from the first frame.
      this.close(1011, 'relay_error');
    }
  }

  #write(frame) {
    if (this.closed || !this.socket.writable || this.socket.destroyed ||
        this.socket.writableLength + frame.length > MAX_QUEUED_BYTES) return false;
    try {
      this.socket.write(frame);
      return true;
    } catch {
      return false;
    }
  }

  send(value) {
    return this.#write(encodeFrame(OPCODE.text, JSON.stringify(value)));
  }

  ping() {
    if (!this.#write(encodeFrame(OPCODE.ping))) this.close(1008, 'backpressure');
  }

  #markClosed() {
    if (this.closed) return;
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
    this.onClose(this);
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const notified = this.#write(encodeFrame(OPCODE.close, closePayload(code, reason)));
    this.#markClosed(); // synchronous revocation, before TCP FIN can be delayed by a peer
    if (!notified) return this.socket.destroy();
    this.socket.end();
    this.destroyTimer = setTimeout(() => this.socket.destroy(), 1000);
    this.destroyTimer.unref();
  }

  terminate() {
    this.#markClosed();
    this.socket.destroy();
  }
}
