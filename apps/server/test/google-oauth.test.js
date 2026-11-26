import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { test } from 'node:test';
import { INSTANCE_TOKEN, call, registerDevice, startHub } from './helpers.js';

const BASE = '/api/v1/web/google';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const START_MS = Date.parse('2026-01-01T00:00:00Z');
const LOCAL = 'http://127.0.0.1:3080';
const REMOTE = 'https://harness.example:8443';
const EMAIL = 'user@example.test';
const SUBJECT = 'google-fixture-subject';
const CLIENT_ID = 'fixture.apps.googleusercontent.com';
const CLIENT_SECRET = 'fixture-not-a-secret';
const REDIRECT = 'https://hub.example' + BASE + '/callback';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const kid = 'google-fixture-key';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };

function secret() { return randomBytes(32).toString('base64url'); }
function challenge(verifier) { return createHash('sha256').update(verifier).digest('base64url'); }
function b64json(data) { return Buffer.from(JSON.stringify(data)).toString('base64url'); }
function bodyJson(data, status = 200) { return Response.json(data, { status }); }

function fixtureProvider(now) {
  const calls = [];
  const codes = new Map();
  return {
    calls,
    issue(flow, overrides = {}) {
      const code = 'fixture/authorization+code=' + (codes.size + 1);
      codes.set(code, { flow, ...overrides });
      return BASE + '/callback?' + new URLSearchParams({ code, state: flow.auth.searchParams.get('state') });
    },
    async fetch(url, init) {
      calls.push({ url, init });
      assert.equal(init.redirect, 'error');
      assert.equal(init.referrerPolicy, 'no-referrer');
      assert.ok(init.signal instanceof AbortSignal);
      if (url === JWKS) {
        assert.equal(init.method ?? 'GET', 'GET');
        return Response.json({ keys: [jwk] }, { headers: { 'cache-control': 'public, max-age=600' } });
      }
      assert.equal(url, TOKEN);
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
      const form = new URLSearchParams(init.body);
      const script = codes.get(form.get('code'));
      assert.ok(script, 'exchange only uses a fixture-issued Google code');
      assert.deepEqual([...form.keys()].sort(), ['client_id', 'client_secret', 'code', 'code_verifier', 'grant_type', 'redirect_uri']);
      assert.equal(form.get('client_id'), CLIENT_ID);
      assert.equal(form.get('client_secret'), CLIENT_SECRET);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('redirect_uri'), REDIRECT);
      assert.equal(challenge(form.get('code_verifier')), script.flow.auth.searchParams.get('code_challenge'));
      assert.notEqual(form.get('code_verifier'), script.flow.verifier);
      if (script.wait) await script.wait();
      if (script.fail) return script.fail();
      const input = b64json({ alg: 'RS256', kid, typ: 'JWT', ...script.header }) + '.' + b64json({
        iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Math.floor(now() / 1000) + 60,
        nonce: script.flow.auth.searchParams.get('nonce'), sub: SUBJECT,
        email: EMAIL, email_verified: true, ...script.claims,
      });
      const signature = sign('RSA-SHA256', Buffer.from(input), script.key ?? privateKey).toString('base64url');
      return bodyJson({ id_token: input + '.' + signature, access_token: 'never-forward', refresh_token: 'never-store' });
    },
  };
}

async function setup(t, { google = {}, ...options } = {}) {
  let clock = START_MS;
  const errors = [];
  const now = () => clock;
  const provider = fixtureProvider(now);
  const hub = await startHub({
    now,
    logger: { info() {}, error(...args) { errors.push(args); } },
    google: google === null ? undefined : {
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT,
      allowedEmails: [' User@Example.Test '], returnOrigins: [REMOTE], fetch: provider.fetch,
      ...google,
    },
    ...options,
  });
  t.after(async () => { await hub.stop(); assert.deepEqual(errors, []); });
  async function request(path, { body, authorization, method = body === undefined ? 'GET' : 'POST' } = {}) {
    const response = await fetch(hub.url + path, {
      method, redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(authorization === undefined ? {} : { authorization }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const text = await response.text();
    return { status: response.status, location: response.headers.get('location'), json: text ? JSON.parse(text) : null };
  }
  const start = (body = {}, authorization, path = BASE + '/start') => request(path, {
    body: { device_name: 'Google device', return_origin: LOCAL, challenge: challenge(secret()), ...body }, authorization,
  });
  async function begin({ origin = LOCAL, verifier = secret(), authorization } = {}) {
    const result = await start({ return_origin: origin, challenge: challenge(verifier) }, authorization);
    assert.equal(result.status, 200, JSON.stringify(result.json));
    const { flow_id: id, authorization_url: authUrl, expires_at: expiresAt } = result.json;
    assert.match(id, /^[A-Za-z0-9_-]{24,64}$/);
    return { id, auth: new URL(authUrl), expiresAt, verifier };
  }
  const redeem = (flow, grant, verifier = flow.verifier) => request(BASE + '/redeem', {
    body: { flow_id: flow.id, grant, verifier },
  });
  return { ...hub, provider, request, start, begin, redeem, advance(ms) { clock += ms; } };
}

function expectFailure(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.json));
  assert.deepEqual(response.json, { error: { code } });
  assert.equal(response.location, null);
}

function grantOf(response, origin, flow) {
  assert.equal(response.status, 303, JSON.stringify(response.json));
  assert.equal(response.json, null);
  const url = new URL(response.location);
  assert.equal(url.origin, origin);
  assert.equal(url.pathname, '/dsh-bridge-google');
  assert.equal(url.search, '');
  const fragment = new URLSearchParams(url.hash.slice(1));
  assert.deepEqual([...fragment.keys()], ['flow_id', 'grant']);
  assert.equal(fragment.get('flow_id'), flow.id);
  const grant = fragment.get('grant');
  assert.match(grant, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(response.location, origin + '/dsh-bridge-google#flow_id=' + flow.id + '&grant=' + grant);
  return grant;
}

test('missing or invalid Google configuration disables Google only', async (t) => {
  for (const google of [null, { clientSecret: '' }, { allowedEmails: [] }, { allowedEmails: ['not-an-email'] },
    { redirectUri: REDIRECT + '?extra' }, { redirectUri: REDIRECT + '/' },
    { redirectUri: 'http://hub.example' + BASE + '/callback' }, { returnOrigins: [REMOTE + '/some/path'] }]) {
    const hub = await setup(t, { google });
    assert.deepEqual((await hub.request(BASE + '/status')).json, { enabled: false });
    expectFailure(await hub.start(), 404, 'google_disabled');
    assert.equal(hub.provider.calls.length, 0);
    assert.equal((await call(hub.url, '/healthz')).status, 200);
    assert.equal((await call(hub.url, '/api/v1/web/enroll', { method: 'POST', body: { device_name: 'Independent Web' } })).status, 200);
  }
});

test('start requires exact origins, bounded canonical proof and only existing Web bearer tokens', async (t) => {
  const hub = await setup(t);
  assert.deepEqual((await hub.request(BASE + '/status')).json, { enabled: true });
  for (const origin of [LOCAL, 'http://localhost', 'http://[::1]:65535', REMOTE]) await hub.begin({ origin });
  for (const origin of [LOCAL + '/', LOCAL + '/.', LOCAL + '?', LOCAL + '#', LOCAL + '@outside.example',
    'http://@127.0.0.1:3080', 'http://127.1:3080', 'http://2130706433:3080', 'http://127.0.0.2:3080',
    'http://localhost.:3080', 'http://localhost:080', 'http://localhost:0', 'http://localhost:65536',
    'http://[0:0:0:0:0:0:0:1]:3080', 'https://127.0.0.1:3080', 'https://harness.example',
    REMOTE + '#flow_id=other', 'https://harness.example:8443/../', 'HTTPS://harness.example:8443',
    'https://harness.example.evil:8443', 'https://user:pass@harness.example:8443', '//localhost:3080']) {
    expectFailure(await hub.start({ return_origin: origin }), 400, 'invalid_return_origin');
  }
  for (const proof of ['A'.repeat(42), 'B'.repeat(43), 'A'.repeat(43) + '=', null]) {
    expectFailure(await hub.start({ challenge: proof }), 400, 'invalid_challenge');
  }
  expectFailure(await hub.start({ device_name: 'a'.repeat(201) }), 400, 'invalid_device_name');
  expectFailure(await hub.start({ device_name: 'a'.repeat(8192) }), 413, 'payload_too_large');
  const chunked = await fetch(hub.url + BASE + '/start', {
    method: 'POST', duplex: 'half', headers: { 'content-type': 'application/json' },
    body: new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.alloc(4096, 'x'));
      controller.enqueue(Buffer.alloc(4097, 'x'));
      controller.close();
    } }),
  });
  assert.equal(chunked.status, 413);
  assert.equal(chunked.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await chunked.json(), { error: { code: 'payload_too_large' } });

  const legacy = await registerDevice(hub.url, 'Not a Web credential');
  const mobileCode = (await call(hub.url, '/api/v1/pairing/code', { method: 'POST', body: {} })).json.code;
  const mobile = (await call(hub.url, '/api/v1/pairing/claim', { method: 'POST', token: null, body: { code: mobileCode } })).json;
  assert.equal(typeof mobile.token, 'string');
  for (const token of [INSTANCE_TOKEN, legacy.token, mobile.token, 'wrong-web-token']) {
    expectFailure(await hub.start({}, 'Bearer ' + token), 401, 'unauthorized');
  }
  for (const header of ['Bearer', 'Basic abc', 'Bearer one, Bearer two']) {
    expectFailure(await hub.start({}, header), 401, 'unauthorized');
  }
  expectFailure(await hub.start({}, undefined, BASE + '/start?access_token=other'), 401, 'unauthorized');
  assert.equal(hub.provider.calls.length, 0, 'no provider request starts until callback');
});

test('signed Google identity yields only a loopback/allowlisted fragment, redeemed once with local proof', async (t) => {
  const hub = await setup(t);
  const flow = await hub.begin({ origin: REMOTE, verifier: '-._~' + 'a'.repeat(39) });
  assert.equal(flow.expiresAt, new Date(START_MS + 600_000).toISOString());
  const auth = flow.auth;
  assert.equal(auth.origin + auth.pathname, AUTH);
  assert.equal(auth.searchParams.get('response_type'), 'code');
  assert.equal(auth.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(auth.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(auth.searchParams.get('scope'), 'openid email profile');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  for (const field of ['state', 'nonce', 'code_challenge']) assert.match(auth.searchParams.get(field), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(auth.searchParams.get('state'), auth.searchParams.get('nonce'));
  assert.notEqual(auth.searchParams.get('code_challenge'), challenge(flow.verifier));
  assert.equal(auth.searchParams.get('client_secret'), null);
  assert.equal(auth.searchParams.get('access_type'), null);

  const callback = hub.provider.issue(flow, { claims: { aud: [CLIENT_ID], azp: CLIENT_ID, iss: 'accounts.google.com' } });
  expectFailure(await hub.redeem(flow, secret()), 400, 'invalid_google_grant');
  expectFailure(await hub.request(BASE + '/poll?flow_id=' + flow.id), 404, 'not_found');
  assert.equal((await hub.request(callback, { method: 'HEAD' })).status, 404);
  const grant = grantOf(await hub.request(callback), REMOTE, flow);
  expectFailure(await hub.request(callback), 400, 'invalid_google_state');
  expectFailure(await hub.redeem(flow, grant, secret()), 400, 'invalid_google_grant');
  const other = await hub.begin();
  const otherGrant = grantOf(await hub.request(hub.provider.issue(other)), LOCAL, other);
  expectFailure(await hub.redeem(flow, otherGrant), 400, 'invalid_google_grant');
  expectFailure(await hub.redeem(other, grant), 400, 'invalid_google_grant');
  const results = await Promise.all([hub.redeem(flow, grant), hub.redeem(flow, grant)]);
  const success = results.find((response) => response.status === 200);
  assert.ok(success);
  assert.deepEqual(Object.keys(success.json).sort(), ['device_id', 'token']);
  assert.match(success.json.token, /^web_[A-Za-z0-9_-]{43}$/);
  assert.equal(hub.app.db.web.findDeviceId(success.json.token), success.json.device_id);
  expectFailure(results.find((response) => response !== success), 400, 'invalid_google_grant');
  assert.deepEqual(hub.provider.calls.map((entry) => entry.url), [TOKEN, JWKS, TOKEN]);
});

test('an existing Web bearer links precisely the proven device without returning its token', async (t) => {
  const hub = await setup(t);
  const identity = hub.app.db.web.createDevice('Existing name');
  const opts = { authorization: 'bearer ' + identity.token };
  const flow = await hub.begin(opts);
  const grant = grantOf(await hub.request(hub.provider.issue(flow)), LOCAL, flow);
  assert.deepEqual((await hub.redeem(flow, grant)).json, { device_id: identity.device_id });
  assert.equal(hub.app.db.web.findDeviceId(identity.token), identity.device_id);

  const mismatch = await hub.begin(opts);
  const mismatchGrant = grantOf(await hub.request(hub.provider.issue(mismatch, { claims: { sub: 'other-google-subject' } })), LOCAL, mismatch);
  expectFailure(await hub.redeem(mismatch, mismatchGrant), 409, 'google_account_mismatch');
  expectFailure(await hub.redeem(mismatch, mismatchGrant), 400, 'invalid_google_grant');
});

test('callback rejects invalid signatures, JOSE headers and verified identity claims', async (t) => {
  const hub = await setup(t);
  for (const options of [
    { key: otherKey }, { header: { alg: 'HS256' } }, { header: { jku: 'https://not-google.example/jwks' } },
    { header: { kid: 'untrusted-kid' } }, { claims: { iss: 'https://not-google.example' } },
    { claims: { aud: 'another-client' } }, { claims: { aud: [CLIENT_ID, 'another-client'], azp: CLIENT_ID } },
    { claims: { azp: 'another-client' } }, { claims: { exp: Math.floor(START_MS / 1000) } },
    { claims: { exp: String(Math.floor(START_MS / 1000) + 60) } }, { claims: { nonce: secret() } },
    { claims: { sub: '' } }, { claims: { email: 'not-allowlisted@example.test' } },
    { claims: { email_verified: false } }, { claims: { email_verified: 'true' } },
  ]) {
    const flow = await hub.begin();
    const callback = hub.provider.issue(flow, options);
    expectFailure(await hub.request(callback), 401, 'invalid_google_identity');
    expectFailure(await hub.request(callback), 400, 'invalid_google_state');
    expectFailure(await hub.redeem(flow, secret()), 400, 'invalid_google_grant');
  }
  assert.ok(hub.provider.calls.every((entry) => [TOKEN, JWKS].includes(entry.url)));
});

test('callback state is one-use before exchange and upstream failures never echo details', async (t) => {
  const hub = await setup(t);
  const denied = await hub.begin();
  const deniedCallback = hub.provider.issue(denied);
  const state = denied.auth.searchParams.get('state');
  expectFailure(await hub.request(deniedCallback + '&state=' + state), 400, 'invalid_google_state');
  expectFailure(await hub.request(deniedCallback + '&error=denied&error_description=do-not-echo'), 400, 'google_callback_failed');
  expectFailure(await hub.request(deniedCallback), 400, 'invalid_google_state');
  const duplicate = hub.provider.issue(await hub.begin());
  expectFailure(await hub.request(duplicate + '&code=extra'), 400, 'google_callback_failed');
  expectFailure(await hub.request(duplicate), 400, 'invalid_google_state');
  assert.deepEqual(hub.provider.calls, []);

  const flow = await hub.begin();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const callback = hub.provider.issue(flow, { wait: async () => { started.resolve(); await release.promise; } });
  const first = hub.request(callback);
  try {
    await started.promise;
    expectFailure(await hub.request(callback), 400, 'invalid_google_state');
    assert.deepEqual(hub.provider.calls.map((entry) => entry.url), [TOKEN]);
  } finally {
    release.resolve();
  }
  grantOf(await first, LOCAL, flow);

  for (const fail of [
    () => bodyJson({ error: 'private-provider-content' }, 400),
    () => { throw new Error('private-provider-exception'); },
    () => new Response('x'.repeat(65_537)),
  ]) {
    const failed = hub.provider.issue(await hub.begin(), { fail });
    expectFailure(await hub.request(failed), 502, 'google_provider_error');
    expectFailure(await hub.request(failed), 400, 'invalid_google_state');
  }
});

test('expired pending flows and delivered grants cannot complete, including expiry during exchange', async (t) => {
  const hub = await setup(t);
  const expired = await hub.begin();
  hub.advance(600_000);
  expectFailure(await hub.request(hub.provider.issue(expired)), 400, 'invalid_google_state');
  assert.deepEqual(hub.provider.calls, []);

  const exchanging = await hub.begin();
  const lateCallback = hub.provider.issue(exchanging, { wait: () => hub.advance(600_000) });
  expectFailure(await hub.request(lateCallback), 400, 'invalid_google_state');
  const flow = await hub.begin();
  const grant = grantOf(await hub.request(hub.provider.issue(flow)), LOCAL, flow);
  hub.advance(120_000);
  expectFailure(await hub.redeem(flow, grant), 400, 'invalid_google_grant');

  const clipped = await hub.begin();
  hub.advance(599_000);
  const clippedGrant = grantOf(await hub.request(hub.provider.issue(clipped)), LOCAL, clipped);
  hub.advance(1000);
  expectFailure(await hub.redeem(clipped, clippedGrant), 400, 'invalid_google_grant');
});

test('pending Google flow capacity is bounded and reclaimed on expiry', async (t) => {
  const hub = await setup(t);
  for (let n = 0; n < 256; n += 1) await hub.begin();
  expectFailure(await hub.start(), 429, 'google_flow_limit');
  hub.advance(600_000);
  await hub.begin();
  assert.deepEqual(hub.provider.calls, []);
});
