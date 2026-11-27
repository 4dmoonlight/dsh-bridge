import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import vm from 'node:vm';
import { createWebPortal } from '../src/web-portal.js';

const CONTROL = 'https://hub.example.test';
const CONTROL_HOST = new URL(CONTROL).host;
const DATA = 'views.example.test';
const ENTRY = '/_dsh/enter';

function request(host, url, { method = 'GET', headers = {}, body, hosts = [host] } = {}) {
  return Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
    method, url, headers: { host, ...(body && { 'content-type': 'application/json' }), ...headers },
    headersDistinct: { host: hosts, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, [v]])) },
  });
}

function response() {
  return { writeHead(status, headers) { Object.assign(this, { status, headers }); },
    appendHeader(name, value) { this[name] = value; }, end(body) { this.body = body?.toString(); } };
}

function fixture(t, dataPort) {
  let lease;
  const options = { origin: CONTROL, dataDomain: DATA, dataPort };
  const portal = createWebPortal({ options, relay: {
    openPortalLease(spec) { lease = spec; return { lease_id: 'lease', expires_at: Date.now() + 60_000 }; },
    closePortalLease() {},
  } });
  t.after(() => portal.close());
  const login = response();
  portal.completeAuthentication(request(CONTROL_HOST, '/callback'), login, { subject: 'owner' });
  const cookie = login['set-cookie'].split(';', 1)[0];
  async function http(host, path, options) {
    const res = response();
    const handled = await portal.handleHttp(request(host, path, options), res);
    return { ...res, handled };
  }
  async function open() {
    const reply = await http(CONTROL_HOST, '/remote/api/open', { method: 'POST', headers: { origin: CONTROL, cookie },
      body: { device_id: 'fixture' } });
    assert.equal(reply.status, 200);
    return { url: new URL(JSON.parse(reply.body).entry_url), lease };
  }
  return { portal, options, http, open };
}

async function browser(page, urls) {
  const script = page.body.match(/<script>(.*)<\/script>/)[1];
  const hash = createHash('sha256').update(script).digest('base64');
  assert.ok(page.headers['content-security-policy'].includes("'sha256-" + hash + "'"));
  const assigned = [];
  let open, listed;
  const ready = new Promise(resolve => { listed = resolve; });
  const button = { addEventListener(event, fn) { if (event === 'click') open = fn; } };
  const list = { replaceChildren() {}, querySelectorAll: () => [button], append: listed };
  let next;
  vm.runInNewContext(script, { URL, location: { assign: url => assigned.push(url) }, document: {
    getElementById: id => id === 'devices' ? list : { addEventListener() {} },
    createElement: tag => tag === 'button' ? button : { append() {} },
  }, fetch: async path => ({ ok: true, json: async () => path === '/remote/api/open' ? { entry_url: next } :
    { devices: [{ device_id: 'fixture', device_name: 'Fixture' }] } }) });
  await ready;
  for (const url of urls) { next = url; await open(); }
  return assigned;
}

for (const [dataPort, port] of [[undefined, ''], ['8443', ':8443']]) {
  test('portal issues and opens only the configured data authority ' + (port || '(default)'), async t => {
    const f = fixture(t, dataPort);
    // Configuration is copied at startup, not live or provided by the API response.
    f.options.dataPort = port ? '443' : '8443';
    const { url, lease } = await f.open();
    assert.match(url.hostname, /^[a-f0-9]{32}\.views\.example\.test$/);
    assert.equal(url.host, url.hostname + port);
    assert.match(lease.authority, /^[a-f0-9]{32}\.dsh-relay\.localhost:3080$/);
    assert.equal((await f.http(url.host, ENTRY, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 200);
    const wrongPort = port ? '' : ':8443';
    const wrongOrigin = 'https://' + url.hostname + wrongPort;
    assert.equal((await f.http(url.host, ENTRY, { headers: { origin: wrongOrigin } })).status, 403);
    assert.equal((await f.http(url.host, ENTRY, { method: 'POST', headers: { origin: wrongOrigin },
      body: { proof: url.hash.slice(1) } })).status, 403);

    for (const host of [url.hostname + wrongPort, url.hostname + ':443', url.hostname + ':08443', url.hostname + ':bad',
      url.hostname.toUpperCase() + port, url.hostname + '.' + port, url.hostname.replace('.', '%2E') + port,
      DATA + ':9999', 'nested.alias.' + DATA + ':9999']) {
      const reply = await f.http(host, '/health');
      assert.deepEqual([reply.handled, reply.status], [true, 404], host);
      let response;
      assert.equal(f.portal.handleUpgrade(request(host, '/api/remote.mux'), { on() {}, end(text) { response = text; } }), true, host);
      assert.match(response, /^HTTP\/1.1 403/, host);
    }
    assert.equal((await f.http('unrelated.example.test:8443', '/health')).handled, false);
    assert.equal((await f.http('unrelated.example.test', '/health', { hosts: ['unrelated.example.test', DATA + ':443'] })).status, 404);

    const path = url.pathname + url.hash;
    assert.deepEqual(await browser(await f.http(CONTROL_HOST, '/remote'), [wrongOrigin + path,
      'https://' + url.hostname + ':443' + path, 'https://' + url.hostname + ':08443' + path,
      'https://' + url.hostname + ':9999' + path, url.href]), [url.href]);
  });
}

test('portal data port only allows canonical 443 or 8443 values', t => {
  for (const dataPort of ['', '0443', '08443', ' 8443', '+8443', '8443 ', 80, 8444, null]) {
    assert.throws(() => createWebPortal({ options: { origin: CONTROL, dataDomain: DATA, dataPort } }), /BRIDGE_PORTAL_DATA_PORT/);
  }
  for (const dataPort of ['443', 443, 8443]) fixture(t, dataPort);
});
