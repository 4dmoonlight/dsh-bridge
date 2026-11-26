import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { HttpError, readJson, safeEqual, sendEmpty, sendJson } from './util.js';
import { WEB_API_PATH } from './web-api.js';

export const GOOGLE_API_PATH = WEB_API_PATH + '/google';
const CALLBACK_PATH = GOOGLE_API_PATH + '/callback';
const RETURN_PATH = '/dsh-bridge-google';
const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const FLOW_TTL_MS = 10 * 60_000;
const GRANT_TTL_MS = 2 * 60_000;
const MAX_FLOWS = 256;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_PROVIDER_BYTES = 64 * 1024;
const PROVIDER_TIMEOUT_MS = 5_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NO_LEAK_HEADERS = {
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};

/** @typedef {{clientId: string, clientSecret: string, redirectUri: string, allowedEmails: string[], returnOrigins?: string[], fetch?: typeof fetch}} GoogleOptions */

export function createGoogleOAuth({ google, db, bodyLimit }) {
  const config = googleConfig(google);
  const now = () => db.now();
  const verifyIdToken = config && createIdTokenVerifier(config, now);
  // In-memory and neither portable across Hub instances nor recoverable by polling.
  // Pending, exchanging, and approved flows all share the same bounded capacity.
  const flows = new Map();
  const byState = new Map();

  function remove(flow) {
    if (flows.get(flow.id) === flow) flows.delete(flow.id);
    if (flow.pending) byState.delete(flow.pending.state);
  }

  function purgeExpired() {
    const time = now();
    for (const flow of flows.values()) {
      if (flow.expiresAt <= time) remove(flow);
    }
    return time;
  }

  async function readBody(req) {
    const limit = Math.min(bodyLimit, MAX_BODY_BYTES);
    if (Number(req.headers['content-length']) > limit) throw new HttpError(413, 'payload_too_large');
    // Unlike IncomingMessage's default iterator, this leaves the connection
    // writable so chunked oversized bodies can also receive a sanitized 413.
    try {
      const body = await readJson(req.iterator({ destroyOnReturn: false }), limit);
      if (!isObject(body)) throw new HttpError(400, 'invalid_body');
      return body;
    } catch (error) {
      if (error instanceof HttpError && error.status === 413) req.resume();
      throw error;
    }
  }

  async function start(req, res) {
    const headers = req.headersDistinct.authorization;
    let deviceId = null;
    if (headers) {
      const match = headers.length === 1 && /^Bearer +([^\s,]+)$/i.exec(headers[0]);
      if (!match) throw new HttpError(401, 'unauthorized');
      try { deviceId = db.findDeviceId(match[1]); } catch { throw new HttpError(500, 'internal_error'); }
      if (!deviceId) throw new HttpError(401, 'unauthorized');
    }
    const body = await readBody(req);
    const deviceName = typeof body.device_name === 'string' ? body.device_name.trim() : '';
    if (!deviceName || deviceName.length > 200 || /[\x00-\x1f\x7f]/.test(deviceName)) {
      throw new HttpError(400, 'invalid_device_name');
    }
    const origin = canonicalOrigin(body.return_origin);
    if (!origin || (!isHttpLoopback(origin) && !config.returnOrigins.has(origin.origin))) {
      throw new HttpError(400, 'invalid_return_origin');
    }
    if (!isSecret(body.challenge)) throw new HttpError(400, 'invalid_challenge');
    const time = purgeExpired();
    if (flows.size >= MAX_FLOWS) throw new HttpError(429, 'google_flow_limit');

    let id, state;
    do { id = randomSecret(); } while (flows.has(id));
    do { state = randomSecret(); } while (byState.has(state));
    const nonce = randomSecret();
    const providerVerifier = randomSecret();
    const expiresAt = time + FLOW_TTL_MS;
    const flow = {
      id, deviceId, deviceName, expiresAt, returnOrigin: origin.origin,
      challenge: body.challenge, pending: { state, nonce, providerVerifier }, approved: null,
    };
    flows.set(id, flow);
    byState.set(state, flow);

    const url = new URL(AUTHORIZATION_URL);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: sha256Url(providerVerifier),
      code_challenge_method: 'S256',
    }).toString();
    sendJson(res, 200, { flow_id: id, authorization_url: url.href, expires_at: new Date(expiresAt).toISOString() }, NO_LEAK_HEADERS);
  }

  async function callback(res, params) {
    purgeExpired();
    const state = singleParam(params, 'state');
    const flow = isSecret(state) && byState.get(state);
    if (!flow) throw new HttpError(400, 'invalid_google_state');
    // Consume before the first await, even when Google returned an error. An
    // overlapping callback cannot exchange the same state or mint a second grant.
    const { nonce, providerVerifier } = flow.pending;
    byState.delete(state);
    flow.pending = null;
    try {
      const code = singleParam(params, 'code');
      if (params.has('error') || !isPrintable(code, 4096)) throw new HttpError(400, 'google_callback_failed');
      const { data } = await providerJson(config.fetch, TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          code_verifier: providerVerifier,
        }),
      });
      if (!isObject(data) || Object.hasOwn(data, 'error')) throw new HttpError(502, 'google_provider_error');
      const subject = await verifyIdToken(data.id_token, nonce);
      const time = now();
      if (flow.expiresAt <= time || flows.get(flow.id) !== flow) throw new HttpError(400, 'invalid_google_state');
      const grant = randomSecret();
      flow.approved = { subject, grantHash: sha256Url(grant) };
      flow.expiresAt = Math.min(flow.expiresAt, time + GRANT_TTL_MS);
      sendEmpty(res, 303, {
        ...NO_LEAK_HEADERS,
        location: flow.returnOrigin + RETURN_PATH + '#flow_id=' + flow.id + '&grant=' + grant,
      });
    } catch (error) {
      remove(flow);
      throw error;
    }
  }

  async function redeem(req, res) {
    const { flow_id: id, grant, verifier } = await readBody(req);
    purgeExpired();
    const flow = typeof id === 'string' && /^[A-Za-z0-9_-]{24,64}$/.test(id) && flows.get(id);
    if (!flow?.approved || !isSecret(grant) || typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
        !safeEqual(sha256Url(grant), flow.approved.grantHash) || !safeEqual(sha256Url(verifier), flow.challenge)) {
      throw new HttpError(400, 'invalid_google_grant');
    }
    // Correct proofs consume the grant before any database work. Failed proofs
    // do not let a party that only intercepted the grant burn the real login.
    remove(flow);
    let identity;
    try {
      identity = db.signInGoogle({ deviceId: flow.deviceId, subject: flow.approved.subject, deviceName: flow.deviceName });
    } catch (error) {
      // Relay only known conflicts, not database error text or details.
      if (error instanceof HttpError && error.status === 409 && error.code === 'google_account_mismatch') {
        throw new HttpError(409, 'google_account_mismatch');
      }
      if (error instanceof HttpError && error.status === 401 && error.code === 'unauthorized') {
        throw new HttpError(401, 'unauthorized');
      }
      throw new HttpError(500, 'internal_error');
    }
    if (!identity || typeof identity.device_id !== 'string' || !identity.device_id ||
        (flow.deviceId === null && (typeof identity.token !== 'string' || !identity.token))) {
      throw new HttpError(500, 'internal_error');
    }
    const result = { device_id: identity.device_id };
    if (flow.deviceId === null) result.token = identity.token;
    sendJson(res, 200, result, NO_LEAK_HEADERS);
  }

  return async function handleGoogle(req, res, { url, path, method }) {
    try {
      const route = method + ' ' + path;
      if (route === 'GET ' + GOOGLE_API_PATH + '/status' || route === 'HEAD ' + GOOGLE_API_PATH + '/status') {
        return sendJson(res, 200, { enabled: Boolean(config) }, NO_LEAK_HEADERS);
      }
      if (!config) throw new HttpError(404, 'google_disabled');
      if (url.searchParams.has('token') || url.searchParams.has('access_token')) throw new HttpError(401, 'unauthorized');
      if (route === 'POST ' + GOOGLE_API_PATH + '/start') return await start(req, res);
      if (route === 'GET ' + CALLBACK_PATH) return await callback(res, url.searchParams);
      if (route === 'POST ' + GOOGLE_API_PATH + '/redeem') return await redeem(req, res);
      throw new HttpError(404, 'not_found');
    } catch (error) {
      // Provider and database failures must not log or echo codes, credentials,
      // claims, request URLs, provider payloads, or exception details.
      if (res.headersSent || res.destroyed) return res.end();
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : 'internal_error';
      return sendJson(res, status, { error: { code } }, NO_LEAK_HEADERS);
    }
  };
}

function canonicalOrigin(value) {
  if (!isPrintable(value, 2048)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  // Compare against the serialized origin, not just parsed fields: the URL
  // parser can strip slashes, dot segments, default ports, and empty userinfo.
  if (value !== url.origin || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.port === '0') return null;
  if (!url.hostname.startsWith('[') &&
      (url.hostname.length > 253 || !url.hostname.split('.').every((label) => DNS_LABEL.test(label)))) return null;
  return url;
}

function isHttpLoopback(url) {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

function googleConfig(google) {
  if (!google || !isPrintable(google.clientId, 512) || !isPrintable(google.clientSecret, 512) ||
      typeof google.redirectUri !== 'string' || !google.redirectUri.endsWith(CALLBACK_PATH) ||
      !Array.isArray(google.allowedEmails) || !google.allowedEmails.length) return null;
  const redirectOrigin = canonicalOrigin(google.redirectUri.slice(0, -CALLBACK_PATH.length));
  if (!redirectOrigin || (redirectOrigin.protocol !== 'https:' && !isHttpLoopback(redirectOrigin))) return null;

  const allowedEmails = new Set();
  for (const value of google.allowedEmails) {
    const email = normalizeEmail(typeof value === 'string' && value.trim());
    if (!email) return null;
    allowedEmails.add(email);
  }
  const origins = google.returnOrigins === undefined ? [] : google.returnOrigins;
  const returnOrigins = new Set();
  if (!Array.isArray(origins)) return null;
  for (const value of origins) {
    const origin = canonicalOrigin(value);
    if (origin?.protocol !== 'https:') return null;
    returnOrigins.add(origin.origin);
  }
  const fetch = google.fetch === undefined ? globalThis.fetch : google.fetch;
  if (typeof fetch !== 'function') return null;
  return { clientId: google.clientId, clientSecret: google.clientSecret, redirectUri: google.redirectUri, allowedEmails, returnOrigins, fetch };
}

function normalizeEmail(value) {
  return isPrintable(value, 254) && /^[^@,<>]+@[^@,<>]+$/.test(value) ? value.toLowerCase() : null;
}

function createIdTokenVerifier(config, now) {
  let cached, loading;
  async function keys() {
    const { data, cacheControl } = await providerJson(config.fetch, JWKS_URL, { headers: { accept: 'application/json' } });
    if (!Array.isArray(data?.keys) || data.keys.length > 32) throw new HttpError(502, 'google_provider_error');
    const trusted = new Map();
    for (const jwk of data.keys) {
      if (!isObject(jwk) || jwk.kty !== 'RSA' || (jwk.alg !== undefined && jwk.alg !== 'RS256') ||
          (jwk.use !== undefined && jwk.use !== 'sig') || !isPrintable(jwk.kid, 128) ||
          (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes('verify')))) continue;
      if (typeof jwk.n !== 'string' || jwk.n.length < 342 || jwk.n.length > 683 || !decodeBase64Url(jwk.n) ||
          typeof jwk.e !== 'string' || jwk.e.length > 8 || !decodeBase64Url(jwk.e)) continue;
      let key;
      try { key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }); } catch { continue; }
      if (key.asymmetricKeyDetails.modulusLength < 2048 || key.asymmetricKeyDetails.modulusLength > 4096) continue;
      if (trusted.has(jwk.kid)) throw new HttpError(502, 'google_provider_error');
      trusted.set(jwk.kid, key);
    }
    if (!trusted.size) throw new HttpError(502, 'google_provider_error');
    const maxAge = /(?:^|,)\s*max-age\s*=\s*(\d+)\s*(?:,|$)/i.exec(cacheControl);
    const seconds = /(?:^|,)\s*no-(?:cache|store)\s*(?:,|$)/i.test(cacheControl) ? 0 : Math.min(3600, maxAge ? Number(maxAge[1]) : 300);
    cached = { trusted, expiresAt: now() + seconds * 1000 };
    return trusted;
  }

  return async function verifyIdToken(jwt, nonce) {
    const invalid = () => new HttpError(401, 'invalid_google_identity');
    if (typeof jwt !== 'string' || jwt.length > 16 * 1024) throw invalid();
    const parts = jwt.split('.');
    if (parts.length !== 3) throw invalid();
    const header = jwtObject(parts[0]);
    const signature = decodeBase64Url(parts[2]);
    if (header?.alg !== 'RS256' || !isPrintable(header.kid, 128) || !signature ||
        ['crit', 'b64', 'jku', 'jwk', 'x5u', 'x5c'].some((field) => Object.hasOwn(header, field))) throw invalid();
    let key = cached?.expiresAt > now() && cached.trusted.get(header.kid);
    if (!key) {
      // A new kid can represent rotation even if the old JWKS has not expired.
      // Coalesce concurrent loads, and never use any token-provided key or URL.
      loading ??= keys().finally(() => { loading = null; });
      key = (await loading).get(header.kid);
    }
    if (!key || !verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, signature)) throw invalid();
    const claims = jwtObject(parts[1]);
    const time = now() / 1000;
    if (!claims || !ISSUERS.has(claims.iss) ||
        !(claims.aud === config.clientId || (Array.isArray(claims.aud) && claims.aud.length === 1 && claims.aud[0] === config.clientId)) ||
        (Object.hasOwn(claims, 'azp') && claims.azp !== config.clientId) ||
        !Number.isSafeInteger(claims.exp) || claims.exp <= time ||
        (Object.hasOwn(claims, 'nbf') && (!Number.isSafeInteger(claims.nbf) || claims.nbf > time)) ||
        !isSecret(claims.nonce) || !safeEqual(claims.nonce, nonce) || !isPrintable(claims.sub, 255) ||
        claims.email_verified !== true || !config.allowedEmails.has(normalizeEmail(claims.email))) throw invalid();
    return claims.sub;
  };
}

async function providerJson(fetch, url, init) {
  try {
    const response = await fetch(url, {
      ...init, redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('bad provider response');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_PROVIDER_BYTES) throw new Error('provider response too large');
      chunks.push(chunk);
    }
    return {
      data: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))),
      cacheControl: response.headers.get('cache-control') ?? '',
    };
  } catch {
    throw new HttpError(502, 'google_provider_error');
  }
}

function jwtObject(part) {
  try {
    const bytes = decodeBase64Url(part);
    const data = bytes && JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (isObject(data)) return data;
  } catch { /* invalid signed JSON */ }
  return null;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPrintable(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[^!-~]/.test(value);
}

function singleParam(params, name) {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function randomSecret() {
  return randomBytes(32).toString('base64url');
}

function sha256Url(value) {
  return createHash('sha256').update(value).digest('base64url');
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : null;
}

function isSecret(value) {
  return typeof value === 'string' && value.length === 43 && decodeBase64Url(value) !== null;
}
