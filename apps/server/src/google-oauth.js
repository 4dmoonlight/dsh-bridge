import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { HttpError, readJson, safeEqual, sendEmpty, sendJson } from './util.js';
import { WEB_API_PATH } from './web-api.js';

export const GOOGLE_API_PATH = WEB_API_PATH + '/google';
const CALLBACK_PATH = GOOGLE_API_PATH + '/callback';
const PORTAL_START_PATH = '/remote/auth/start';
const PORTAL_BINDING_COOKIE = '__Host-dsh-portal-google';
const RETURN_PATH = '/dsh-bridge-google';
const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const FLOW_TTL_MS = 10 * 60_000;
const GRANT_TTL_MS = 2 * 60_000;
const FLOW_LIMITS = { web: 256, portal: 64 };
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
/** @typedef {{origin: string, completeAuthentication: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, identity: {subject: string}) => void}} GooglePortalOptions */

export function createGoogleOAuth({ google, db, bodyLimit, portal }) {
  const config = googleConfig(google);
  const portalOrigin = config && canonicalOrigin(portal?.origin);
  const completePortal = portalOrigin?.protocol === 'https:' && portalOrigin.origin + CALLBACK_PATH === config.redirectUri &&
    typeof portal.completeAuthentication === 'function' ? portal.completeAuthentication.bind(portal) : null;
  const now = () => db.now();
  const verifyIdToken = config && createIdTokenVerifier(config, now);
  // In-memory and neither portable across Hub instances nor recoverable by polling.
  // Each purpose has a bounded budget, including exchanges and pending grants.
  const flows = new Map();
  const purposeCounts = { web: 0, portal: 0 };
  const byState = new Map();

  function remove(flow) {
    if (flows.get(flow.id) === flow) {
      flows.delete(flow.id);
      purposeCounts[flow.purpose]--;
    }
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
    const flow = beginFlow({
      purpose: 'web', deviceId, deviceName, returnOrigin: origin.origin,
      challenge: body.challenge, approved: null,
    });
    sendJson(res, 200, {
      flow_id: flow.id, authorization_url: authorizationUrl(flow), expires_at: new Date(flow.expiresAt).toISOString(),
    }, NO_LEAK_HEADERS);
  }

  async function startPortal(req, res) {
    try {
      if (req.method !== 'POST' || req.url !== PORTAL_START_PATH) throw new HttpError(404, 'not_found');
      if (!completePortal) throw new HttpError(404, 'google_portal_disabled');
      if (!exactHeader(req, 'host', portalOrigin.host) || !exactHeader(req, 'origin', portalOrigin.origin) ||
          !optionalExactHeader(req, 'sec-fetch-site', 'same-origin') || !isDocumentNavigation(req)) {
        throw new HttpError(403, 'forbidden');
      }
      // The form supplies no inputs to OAuth, but apply the same request size
      // bounds as Web sign-in, including to chunked requests.
      const limit = Math.min(bodyLimit, MAX_BODY_BYTES);
      if (Number(req.headers['content-length']) > limit) throw new HttpError(413, 'payload_too_large');
      let bytes = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > limit) {
          req.resume();
          throw new HttpError(413, 'payload_too_large');
        }
      }
      const binding = randomSecret();
      const flow = beginFlow({ purpose: 'portal', bindingHash: sha256Url(binding) });
      sendEmpty(res, 303, {
        ...NO_LEAK_HEADERS,
        'set-cookie': portalBindingCookie(binding, FLOW_TTL_MS / 1000),
        location: authorizationUrl(flow),
      });
    } catch (error) {
      return fail(res, error);
    }
  }

  function beginFlow(details) {
    const time = purgeExpired();
    if (purposeCounts[details.purpose] >= FLOW_LIMITS[details.purpose]) throw new HttpError(429, 'google_flow_limit');
    let id, state;
    do { id = randomSecret(); } while (flows.has(id));
    do { state = randomSecret(); } while (byState.has(state));
    const flow = {
      ...details, id, expiresAt: time + FLOW_TTL_MS,
      pending: { state, nonce: randomSecret(), providerVerifier: randomSecret() },
    };
    flows.set(id, flow);
    purposeCounts[flow.purpose]++;
    byState.set(state, flow);
    return flow;
  }

  function authorizationUrl({ pending: { state, nonce, providerVerifier } }) {
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
    return url.href;
  }

  async function callback(req, res, params) {
    purgeExpired();
    const state = singleParam(params, 'state');
    const flow = isSecret(state) && byState.get(state);
    if (!flow) throw new HttpError(400, 'invalid_google_state');
    const isPortal = flow.purpose === 'portal';
    if (isPortal) {
      const binding = readPortalBinding(req);
      // Google's cross-site GET may carry the Lax cookie; require a top-level
      // document navigation, not a same-origin fetch or an embedded frame.
      if (req.method !== 'GET' || !req.url?.startsWith(CALLBACK_PATH + '?') || req.url.includes('#') ||
          !exactHeader(req, 'host', portalOrigin.host) || !optionalExactHeader(req, 'origin', portalOrigin.origin) ||
          !isDocumentNavigation(req) ||
          !binding || !safeEqual(sha256Url(binding), flow.bindingHash)) {
        throw new HttpError(400, 'invalid_google_state');
      }
      res.appendHeader('set-cookie', portalBindingCookie('', 0));
    }
    // Consume before the first await, even when Google returned an error. An
    // overlapping callback cannot exchange the same state or mint a second grant.
    const { nonce, providerVerifier } = flow.pending;
    byState.delete(state);
    flow.pending = null;
    try {
      const code = singleParam(params, 'code');
      if (params.has('error') || !isPrintable(code, 4096) || (isPortal && new Set(params.keys()).size !== params.size)) {
        throw new HttpError(400, 'google_callback_failed');
      }
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
      if (isPortal) {
        remove(flow);
        for (const [name, value] of Object.entries(NO_LEAK_HEADERS)) res.setHeader(name, value);
        res.setHeader('cache-control', 'no-store');
        // The portal owns the independent session cookie and fixed /remote
        // redirect. It must append its own Set-Cookie to the binding deletion.
        try { completePortal(req, res, { subject }); } catch { throw new HttpError(500, 'internal_error'); }
        return;
      }
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
    if (flow?.purpose !== 'web' || !flow.approved || !isSecret(grant) || typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
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

  async function handleGoogle(req, res, { url, path, method }) {
    try {
      const route = method + ' ' + path;
      if (route === 'GET ' + GOOGLE_API_PATH + '/status' || route === 'HEAD ' + GOOGLE_API_PATH + '/status') {
        return sendJson(res, 200, { enabled: Boolean(config) }, NO_LEAK_HEADERS);
      }
      if (!config) throw new HttpError(404, 'google_disabled');
      if (url.searchParams.has('token') || url.searchParams.has('access_token')) throw new HttpError(401, 'unauthorized');
      if (route === 'POST ' + GOOGLE_API_PATH + '/start') return await start(req, res);
      if (route === 'GET ' + CALLBACK_PATH) return await callback(req, res, url.searchParams);
      if (route === 'POST ' + GOOGLE_API_PATH + '/redeem') return await redeem(req, res);
      throw new HttpError(404, 'not_found');
    } catch (error) {
      return fail(res, error);
    }
  }
  handleGoogle.startPortal = startPortal;
  handleGoogle.portalReady = Boolean(completePortal);
  return handleGoogle;
}

function fail(res, error) {
  // Provider and database failures must not log or echo codes, credentials,
  // claims, request URLs, provider payloads, or exception details.
  if (res.headersSent || res.destroyed) return res.end();
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'internal_error';
  return sendJson(res, status, { error: { code } }, NO_LEAK_HEADERS);
}

function exactHeader(req, name, value) {
  return req.headers[name] === value && req.headersDistinct[name]?.length === 1;
}

function optionalExactHeader(req, name, value) {
  return req.headers[name] === undefined || exactHeader(req, name, value);
}

function isDocumentNavigation(req) {
  // Some browsers omit Fetch Metadata; when present it must describe a
  // top-level navigation. Exact Host and the independent proofs are mandatory.
  return optionalExactHeader(req, 'sec-fetch-mode', 'navigate') && optionalExactHeader(req, 'sec-fetch-dest', 'document');
}

function portalBindingCookie(value, maxAge) {
  return PORTAL_BINDING_COOKIE + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + maxAge;
}

function readPortalBinding(req) {
  if (typeof req.headers.cookie !== 'string') return null;
  let binding = null;
  for (const part of req.headers.cookie.split(';')) {
    const pair = part.trim();
    const equals = pair.indexOf('=');
    if ((equals === -1 ? pair : pair.slice(0, equals)).trim() !== PORTAL_BINDING_COOKIE) continue;
    if (binding !== null || equals === -1) return null;
    binding = pair.slice(equals + 1);
    if (!isSecret(binding)) return null;
  }
  return binding;
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
