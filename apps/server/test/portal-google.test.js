import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { createGoogleOAuth, GOOGLE_API_PATH } from '../src/google-oauth.js';

const ORIGIN = 'https://hub.example.test:8443';
const HOST = new URL(ORIGIN).host;
const START = '/remote/auth/start';
const CALLBACK = GOOGLE_API_PATH + '/callback';
const REDIRECT = ORIGIN + CALLBACK;
const TOKEN = 'https://oauth2.googleapis.com/token';
const JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const CLIENT = 'fixture.apps.googleusercontent.com';
const EMAIL = 'allowed@example.test';
const SUBJECT = 'synthetic-google-subject';
const BINDING = '__Host-dsh-portal-google';
const PORTAL_SESSION = '__Host-dsh-portal=synthetic-session; Path=/; Secure; HttpOnly; SameSite=Lax';
const NAVIGATION = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
const secret = () => randomBytes(32).toString('base64url');
const challenge = (value) => createHash('sha256').update(value).digest('base64url');
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

async function fixture(t, { portal = {}, google = {} } = {}) {
  let time = Date.parse('2026-01-01T00:00:00Z');
  const exchanges = new Map();
  const calls = [];
  const completed = [];
  const deviceWrites = [];
  const handler = createGoogleOAuth({
    bodyLimit: 16 * 1024,
    db: {
      now: () => time,
      signInGoogle(details) {
        deviceWrites.push(details);
        return { device_id: 'synthetic-device', token: 'synthetic-web-token' };
      },
    },
    google: {
      clientId: CLIENT, clientSecret: 'fixture-only', redirectUri: REDIRECT, allowedEmails: [EMAIL],
      async fetch(url, init) {
        calls.push(url);
        assert.equal(init.redirect, 'error');
        assert.ok(init.signal instanceof AbortSignal);
        if (url === JWKS) return Response.json({ keys: [jwk] });
        assert.equal(url, TOKEN);
        const form = init.body;
        const exchange = exchanges.get(form.get('code'));
        assert.ok(exchange);
        assert.equal(init.method, 'POST');
        assert.equal(form.get('redirect_uri'), REDIRECT);
        assert.equal(form.get('grant_type'), 'authorization_code');
        assert.equal(challenge(form.get('code_verifier')), exchange.auth.searchParams.get('code_challenge'));
        await exchange.beforeToken?.();
        const input = encode({ alg: 'RS256', kid: jwk.kid }) + '.' + encode({
          iss: 'https://accounts.google.com', aud: CLIENT, exp: Math.floor(time / 1000) + 60,
          nonce: exchange.auth.searchParams.get('nonce'), sub: SUBJECT, email: EMAIL, email_verified: true,
          ...exchange.claims,
        });
        const signature = sign('RSA-SHA256', Buffer.from(input), privateKey);
        if (exchange.invalidSignature) signature[0] ^= 1;
        return Response.json({ id_token: input + '.' + signature.toString('base64url'), access_token: 'never-forward' });
      },
      ...google,
    },
    portal: portal === null ? undefined : {
      origin: ORIGIN,
      completeAuthentication(req, res, identity) {
        completed.push(identity);
        res.appendHeader('set-cookie', PORTAL_SESSION);
        res.writeHead(303, { location: '/remote' });
        res.end();
      },
      ...portal,
    },
  });
  const server = createServer((req, res) => {
    // Intentionally loose mounting so the handler itself verifies raw method/path.
    if (req.url.startsWith(START)) return void handler.startPortal(req, res);
    const url = new URL(req.url, 'http://fixture.invalid');
    void handler(req, res, { url, path: url.pathname, method: req.method });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  function request(path, { method = 'GET', headers = {}, body } = {}) {
    const requestHeaders = Array.isArray(headers) ? headers : Object.fromEntries(
      Object.entries({ host: HOST, ...headers }).filter(([, value]) => value !== undefined),
    );
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1', port: server.address().port, path, method,
        headers: requestHeaders,
        signal: AbortSignal.timeout(5_000),
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('error', reject);
        res.on('end', () => {
          try {
            assert.equal(res.headers['cache-control'], 'no-store');
            assert.equal(res.headers['referrer-policy'], 'no-referrer');
            resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null });
          } catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      if (Array.isArray(body)) {
        for (const chunk of body) req.write(chunk);
        req.end();
      } else {
        req.end(body);
      }
    });
  }
  const start = ({ path = START, method = 'POST', headers = {}, body } = {}) => request(path, {
    method, body, headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...NAVIGATION, ...headers },
  });
  async function begin(options) {
    const result = await start(options);
    assert.equal(result.status, 303, JSON.stringify(result.body));
    const [setCookie] = result.headers['set-cookie'];
    return { result, auth: new URL(result.headers.location), cookie: setCookie.split(';')[0] };
  }
  const issue = (flow, script = {}) => {
    const code = 'fixture-authorization-code-' + exchanges.size;
    exchanges.set(code, { auth: flow.auth, ...script });
    return CALLBACK + '?' + new URLSearchParams({ code, state: flow.auth.searchParams.get('state') });
  };
  const finish = (path, cookie, headers = {}) => request(path, {
    headers: { 'sec-fetch-site': 'cross-site', ...NAVIGATION, cookie, ...headers },
  });
  const webPost = (action, body) => request(GOOGLE_API_PATH + '/' + action, { method: 'POST', body: JSON.stringify(body) });
  const webStart = (verifier = secret()) => webPost('start', {
    device_name: 'Web fixture', return_origin: 'http://localhost:3080', challenge: challenge(verifier),
  });
  return { start, begin, issue, finish, request, webPost, webStart, completed, deviceWrites, calls, advance(ms) { time += ms; } };
}

function fail(result, status, code) {
  assert.equal(result.status, status);
  assert.deepEqual(result.body, { error: { code } });
  assert.equal(result.headers.location, undefined);
}

function success(result) {
  assert.equal(result.status, 303);
  assert.equal(result.headers.location, '/remote');
  assert.deepEqual(result.headers['set-cookie'], [
    BINDING + '=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0', PORTAL_SESSION,
  ]);
  assert.equal(result.body, null);
}

test('portal is opt-in on the exact canonical HTTPS origin of the existing Google callback', async (t) => {
  for (const options of [
    { portal: null }, { portal: { completeAuthentication: null } }, { portal: { origin: ORIGIN + '/' } },
    { portal: { origin: ORIGIN.toUpperCase() } }, { portal: { origin: 'https://hub.example.test' } },
    { portal: { origin: 'http://localhost:3080' }, google: { redirectUri: 'http://localhost:3080' + CALLBACK } },
  ]) {
    const hub = await fixture(t, options);
    fail(await hub.start(), 404, 'google_portal_disabled');
    assert.deepEqual((await hub.request(GOOGLE_API_PATH + '/status')).body, { enabled: true });
    assert.deepEqual(hub.calls, []);
  }
});

test('the exact portal POST checks Host, Origin, Fetch Metadata and bounded form size', async (t) => {
  const hub = await fixture(t);
  for (const path of [START + '/', START + '?', START + '?token=ignored']) fail(await hub.start({ path }), 404, 'not_found');
  fail(await hub.start({ method: 'GET' }), 404, 'not_found');
  for (const headers of [
    { host: 'other.example.test', 'x-forwarded-host': HOST, forwarded: 'host=' + HOST },
    { origin: 'https://other.example.test' }, { origin: ORIGIN + '/' }, { origin: undefined }, { origin: 'null' },
    { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-mode': 'cors' }, { 'sec-fetch-dest': 'iframe' },
    { origin: [ORIGIN, ORIGIN] },
  ]) {
    const response = await hub.start({ headers });
    fail(response, 403, 'forbidden');
    assert.equal(response.headers['set-cookie'], undefined);
  }
  fail(await hub.request(START, { method: 'POST', headers: ['Host', HOST, 'Host', HOST, 'Origin', ORIGIN] }), 403, 'forbidden');
  for (const options of [
    { headers: { 'content-length': '8193' }, body: 'x'.repeat(8193) },
    { body: [Buffer.alloc(4096), Buffer.alloc(4097)] },
  ]) fail(await hub.start(options), 413, 'payload_too_large');
  const withoutMetadata = await hub.request(START, { method: 'POST', headers: { origin: ORIGIN } });
  assert.equal(withoutMetadata.status, 303);
  assert.deepEqual(hub.calls, []);
});

test('portal PKCE and browser binding complete only an independent session on a top-level Google return', async (t) => {
  const hub = await fixture(t);
  const flow = await hub.begin({ body: 'return_to=https://outside.example' });
  assert.equal(flow.result.body, null);
  assert.equal(flow.auth.origin + flow.auth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(flow.auth.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(flow.auth.searchParams.get('client_id'), CLIENT);
  assert.equal(flow.auth.searchParams.get('response_type'), 'code');
  assert.equal(flow.auth.searchParams.get('code_challenge_method'), 'S256');
  assert.deepEqual([...flow.auth.searchParams.keys()].sort(), [
    'client_id', 'code_challenge', 'code_challenge_method', 'nonce', 'redirect_uri', 'response_type', 'scope', 'state',
  ]);
  const state = flow.auth.searchParams.get('state');
  const cookieValue = flow.cookie.slice(BINDING.length + 1);
  assert.match(flow.cookie, /^__Host-dsh-portal-google=[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(flow.result.headers['set-cookie'], [flow.cookie + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600']);
  assert.equal(Buffer.from(state, 'base64url').length, 32);
  assert.notEqual(state, cookieValue);
  assert.ok(!flow.auth.href.includes(cookieValue));

  const callback = hub.issue(flow);
  const other = await hub.begin();
  for (const [cookie, headers] of [
    [undefined, {}], ['', {}], [BINDING + '=invalid', {}], [other.cookie, {}], [flow.cookie + '; ' + flow.cookie, {}],
    [flow.cookie, { host: 'other.example.test', 'x-forwarded-host': HOST }],
    [flow.cookie, { host: 'hub.example.test' }],
    [flow.cookie, { origin: 'https://accounts.google.com' }],
    [flow.cookie, { 'sec-fetch-mode': 'no-cors' }], [flow.cookie, { 'sec-fetch-dest': 'iframe' }],
  ]) {
    const response = await hub.finish(callback, cookie, headers);
    fail(response, 400, 'invalid_google_state');
    assert.equal(response.headers['set-cookie'], undefined);
  }
  fail(await hub.finish('/alternate/..' + callback, flow.cookie), 400, 'invalid_google_state');
  fail(await hub.finish(callback + '&state=' + state, flow.cookie), 400, 'invalid_google_state');
  assert.deepEqual(hub.calls, []);
  assert.deepEqual(hub.completed, []);

  success(await hub.finish(callback + '&authuser=0&prompt=none', flow.cookie));
  fail(await hub.finish(callback, flow.cookie), 400, 'invalid_google_state');
  assert.deepEqual(hub.calls, [TOKEN, JWKS]);
  assert.deepEqual(hub.completed, [{ subject: SUBJECT }]);
  assert.deepEqual(hub.deviceWrites, []);
});

test('the portal consumes browser-bound state once; rejects duplicate code, invalid identity and expiry', async (t) => {
  const hub = await fixture(t);
  const duplicate = await hub.begin();
  const duplicateCallback = hub.issue(duplicate);
  fail(await hub.finish(duplicateCallback + '&code=other', duplicate.cookie), 400, 'google_callback_failed');
  fail(await hub.finish(duplicateCallback, duplicate.cookie), 400, 'invalid_google_state');
  assert.deepEqual(hub.calls, []);
  for (const script of [{ invalidSignature: true }, { claims: { email: 'denied@example.test' } }, { claims: { email_verified: false } },
    { claims: { sub: '' } }, { claims: { nonce: secret() } }]) {
    const flow = await hub.begin();
    const path = hub.issue(flow, script);
    fail(await hub.finish(path, flow.cookie), 401, 'invalid_google_identity');
    fail(await hub.finish(path, flow.cookie), 400, 'invalid_google_state');
  }
  const expired = await hub.begin();
  const count = hub.calls.length;
  hub.advance(600_000);
  fail(await hub.finish(hub.issue(expired), expired.cookie), 400, 'invalid_google_state');
  assert.equal(hub.calls.length, count);

  const inflight = await hub.begin();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const callback = hub.issue(inflight, { beforeToken: () => { entered.resolve(); return release.promise; } });
  const first = hub.finish(callback, inflight.cookie);
  try {
    await Promise.race([entered.promise, first.then(() => assert.fail('expected token exchange'))]);
    fail(await hub.finish(callback, inflight.cookie), 400, 'invalid_google_state');
    assert.equal(hub.calls.length, count + 1);
    hub.advance(600_000);
  } finally {
    release.resolve();
  }
  fail(await first, 400, 'invalid_google_state');
  assert.deepEqual(hub.completed, []);
  assert.deepEqual(hub.deviceWrites, []);
});

test('Web and portal use separate bounded flow pools and completion credentials', async (t) => {
  const hub = await fixture(t);
  const verifier = secret();
  const web = await hub.webStart(verifier);
  assert.equal(web.status, 200);
  for (let i = 0; i < 64; i += 1) await hub.begin();
  fail(await hub.start(), 429, 'google_flow_limit');
  assert.equal((await hub.webStart()).status, 200, 'portal saturation does not stop plugin login');
  const webFlow = { auth: new URL(web.body.authorization_url) };
  const webCallback = await hub.finish(hub.issue(webFlow), BINDING + '=' + secret(), { host: 'web-api.example.test' });
  assert.equal(webCallback.status, 303);
  assert.equal(webCallback.headers['set-cookie'], undefined);
  const webReturn = new URL(webCallback.headers.location);
  assert.equal(webReturn.origin + webReturn.pathname, 'http://localhost:3080/dsh-bridge-google');
  const grant = new URLSearchParams(webReturn.hash.slice(1)).get('grant');
  assert.equal((await hub.webPost('redeem', { flow_id: web.body.flow_id, grant, verifier })).status, 200);
  assert.deepEqual(hub.deviceWrites, [{ deviceId: null, deviceName: 'Web fixture', subject: SUBJECT }]);
  assert.deepEqual(hub.completed, []);

  fail(await hub.start(), 429, 'google_flow_limit');
  hub.advance(600_000);
  const flow = await hub.begin();
  success(await hub.request(hub.issue(flow), { headers: { cookie: flow.cookie } }));
  assert.deepEqual(hub.completed, [{ subject: SUBJECT }]);
  assert.equal(hub.deviceWrites.length, 1);
});
