import { BlockList, isIP } from 'node:net';
import { HttpError, readJson, safeEqual, sendJson } from './util.js';

export const WEB_API_PATH = '/api/v1/web';
const CLAIM_FAILURE_LIMIT = 12;
const CLAIM_WINDOW_MS = 60_000;
const WEB_BODY_LIMIT = 8 * 1024;

export function createWebApi({ db, instanceToken, bodyLimit = WEB_BODY_LIMIT }) {
  // One failure window for the entire hub, not per identity or source IP.
  // This is independent of the legacy sync pairing quota.
  let failedClaims = [];
  const bodyOf = async (req) => {
    const body = await readJson(req, Math.min(WEB_BODY_LIMIT, bodyLimit));
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'invalid_body', 'JSON object body required');
    }
    return body;
  };
  const requireWeb = (token) => {
    const deviceId = token ? db.findDeviceId(token) : null;
    if (!deviceId) throw new HttpError(401, 'unauthorized');
    return deviceId;
  };

  const routes = new Map([
    ['POST /enroll', async (req, res, token) => {
      if (!token || !instanceToken || !safeEqual(token, instanceToken)) throw new HttpError(401, 'unauthorized');
      const body = await bodyOf(req);
      sendJson(res, 200, db.createDevice(requiredString(body, 'device_name')));
    }],
    ['POST /pairing/code', async (req, res, token) => {
      const deviceId = requireWeb(token);
      const body = await bodyOf(req);
      if (Object.keys(body).length !== 0) throw new HttpError(400, 'invalid_body', 'empty JSON object required');
      sendJson(res, 200, db.issueCode(deviceId));
    }],
    ['POST /pairing/claim', async (req, res, token) => {
      // Omitting the header means enroll a new device. A presented but bad
      // credential must never silently change this into an unauthenticated claim.
      const deviceId = token === null ? null : requireWeb(token);
      const body = await bodyOf(req);
      const deviceName = requiredString(body, 'device_name');
      const now = db.now();
      failedClaims = failedClaims.filter((time) => now - time < CLAIM_WINDOW_MS);
      if (failedClaims.length >= CLAIM_FAILURE_LIMIT) {
        throw new HttpError(429, 'rate_limited', 'too many failed Web pairing claims');
      }
      if (typeof body.code !== 'string' || !/^[a-zA-Z0-9_-]{24}$/.test(body.code)) {
        failedClaims.push(now);
        throw new HttpError(400, 'invalid_code', 'pairing code must be 24 URL-safe characters');
      }
      const identity = db.claimCode({ code: body.code, deviceId, deviceName });
      if (identity === 'self') throw new HttpError(400, 'self_claim');
      if (!identity) {
        failedClaims.push(now);
        throw new HttpError(404, 'pairing_code_invalid', 'code is wrong, used, or expired');
      }
      sendJson(res, 200, identity);
    }],
    ['POST /presence', async (req, res, token) => {
      const deviceId = requireWeb(token);
      const body = await bodyOf(req);
      db.publishPresence(deviceId, requiredString(body, 'device_name'), webOrigin(body.web_url));
      sendJson(res, 200, { ok: true });
    }],
    ['GET /devices', (req, res, token) => {
      sendJson(res, 200, { devices: db.listPeers(requireWeb(token)) });
    }],
    ['POST /open', async (req, res, token) => {
      const deviceId = requireWeb(token);
      const peerId = requiredString(await bodyOf(req), 'device_id');
      const peer = peerId === deviceId ? null : db.findPeer(deviceId, peerId);
      if (!peer) throw new HttpError(404, 'not_paired');
      if (peer.status !== 'online') throw new HttpError(409, 'device_offline');
      if (!peer.url) throw new HttpError(409, 'web_not_enabled');
      sendJson(res, 200, { url: peer.url });
    }],
    ['POST /unpair', async (req, res, token) => {
      const deviceId = requireWeb(token);
      const peerId = requiredString(await bodyOf(req), 'device_id');
      if (!db.unpair(deviceId, peerId)) throw new HttpError(404, 'not_paired');
      sendJson(res, 200, { ok: true });
    }],
  ]);

  return async function handleWeb(req, res, { url, path, method }) {
    const handler = routes.get(method + ' ' + path.slice(WEB_API_PATH.length));
    if (!handler) throw new HttpError(404, 'not_found');
    // Never accept credentials in URLs or turn a query-only claim into a new identity.
    if (url.searchParams.has('token') || url.searchParams.has('access_token')) {
      throw new HttpError(401, 'unauthorized');
    }
    return handler(req, res, bearerOf(req));
  };
}

function bearerOf(req) {
  const headers = req.headersDistinct.authorization;
  if (!headers) return null;
  const match = headers.length === 1 && /^Bearer +([^\s,]+)$/i.exec(headers[0]);
  if (!match) throw new HttpError(401, 'unauthorized');
  return match[1];
}

function requiredString(body, field) {
  const value = typeof body[field] === 'string' ? body[field].trim() : '';
  if (!value || value.length > 200) throw new HttpError(400, 'invalid_' + field);
  return value;
}

const localAddresses = new BlockList();
localAddresses.addSubnet('0.0.0.0', 8, 'ipv4');
localAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
// BlockList also matches IPv4-mapped IPv6 with the IPv4 rules above. These
// IPv6 ranges cover ::, ::1, and the deprecated IPv4-compatible forms.
localAddresses.addSubnet('::', 104, 'ipv6');
localAddresses.addSubnet('::127.0.0.0', 104, 'ipv6');
const LOCAL_HOSTS = new Set([
  'localhost', 'localhost.localdomain', 'localhost6', 'localhost6.localdomain6', 'ip6-localhost', 'ip6-loopback',
]);
const HTTPS_ORIGIN = /^https:\/\/(?:\[[0-9a-f:.]+\]|[^:/?#@%\\]+)(?::[0-9]+)?\/?$/i;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function webOrigin(value) {
  if (value === null) return null;
  const invalid = () => new HttpError(400, 'invalid_web_url', 'a non-loopback HTTPS origin or null is required');
  // Check the original string first: URL would normalize away dot paths,
  // empty userinfo and some whitespace. Even an empty ? or # isn't an origin.
  if (typeof value !== 'string' || value.length > 2048 || !HTTPS_ORIGIN.test(value) || /[\s\u0000-\u001f\u007f]/.test(value)) {
    throw invalid();
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid();
  }
  // Only syntax is checked: resolution, certificates and navigation are the
  // browser's job. The hub never looks up or contacts the supplied address.
  const host = parsed.hostname.replace(/\.$/, '');
  const address = host.startsWith('[') ? host.slice(1, -1) : host;
  const family = isIP(address);
  if (family) {
    if (localAddresses.check(address, family === 6 ? 'ipv6' : 'ipv4')) throw invalid();
  } else if (
    LOCAL_HOSTS.has(host) || host.endsWith('.localhost') ||
    host.length > 253 || !host.split('.').every((label) => DNS_LABEL.test(label))
  ) {
    throw invalid();
  }
  return parsed.origin;
}
