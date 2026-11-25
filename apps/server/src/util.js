import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} [message]
   * @param {Record<string, unknown>} [details]
   */
  constructor(status, code, message, details) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const PROTOCOL = 'bridge/1';

export function randomId(prefix, bytes = 12) {
  return prefix + randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time string comparison that also hides length differences. */
export function safeEqual(a, b) {
  const left = Buffer.from(sha256(String(a)), 'hex');
  const right = Buffer.from(sha256(String(b)), 'hex');
  return timingSafeEqual(left, right);
}

export function nowIso() {
  return new Date().toISOString();
}

export function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * Read and parse a JSON request body with a hard size limit.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limitBytes
 */
export async function readJson(req, limitBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      throw new HttpError(413, 'payload_too_large', `body exceeds ${limitBytes} bytes`);
    }
    chunks.push(chunk);
  }
  if (size === 0) throw new HttpError(400, 'empty_body');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
export function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function sendEmpty(res, status, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end();
}

export function clipText(text, max = 20000) {
  if (typeof text !== 'string') return '';
  return text.length > max ? text.slice(0, max) + '\n…[truncated]' : text;
}
