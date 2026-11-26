import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createGoogleWebLogin, serveGoogleHandoff } from '../lib/google-web.js'

const hub = 'https://hub.bridge.test'
const origin = 'https://dsh.bridge.test'
const flowId = 'F'.repeat(43)
const grant = 'G'.repeat(43)

function replyUrl() {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  for (const [key, value] of Object.entries({
    client_id: 'fixture', response_type: 'code', state: flowId, nonce: 'N'.repeat(43),
    redirect_uri: hub + '/api/v1/web/google/callback', scope: 'openid email profile',
    code_challenge_method: 'S256', code_challenge: 'C'.repeat(43),
  })) url.searchParams.set(key, value)
  return url
}

function serverResponse() {
  const res = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers) },
    end(html) { this.html = html },
  }
  return res
}

function makeFlow({ identity, changeAuthorize, startError } = {}) {
  const calls = []
  const saved = []
  const flow = createGoogleWebLogin({
    normalizeHub: input => typeof input === 'string' ? input.replace(/\/$/, '') : null,
    savedHub: () => hub,
    currentIdentity: () => identity,
    deviceName: () => 'fixture',
    accept: (...args) => saved.push(args),
    request: async (remote, token, method, path, body) => {
      calls.push({ remote, token, method, path, body })
      if (path === '/google/start') {
        if (startError) throw startError
        const auth = replyUrl()
        changeAuthorize?.(auth)
        return { flow_id: flowId, authorization_url: auth.href, expires_at: new Date(Date.now() + 600_000).toISOString() }
      }
      return identity ? { device_id: identity.device_id } : { device_id: 'new', token: 'fixture' }
    },
  })
  return { flow, calls, saved, changeIdentity: value => { identity = value } }
}

function browserRequest(cookie, from = origin) { return { headers: { origin: from, ...(cookie ? { cookie } : {}) } } }

async function begin(flow) {
  const res = serverResponse()
  const reply = await flow.start({ hub_url: hub }, browserRequest(), res)
  return { reply, cookie: res.headers['set-cookie'].split(';', 1)[0], raw: res.headers['set-cookie'] }
}

test('Google handoff binds the grant to the originating browser and unexposed verifier', async () => {
  const { flow, calls, saved } = makeFlow()
  const { reply, cookie, raw } = await begin(flow)
  assert.deepEqual(Object.keys(reply), ['authorization_url'])
  assert.match(raw, /Path=\/api\/cross-device\/web\/google\/complete; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/)
  assert.equal(calls[0].body.return_origin, origin)
  const body = { flow_id: flowId, grant }
  await assert.rejects(flow.complete(body, browserRequest(), serverResponse()), { message: 'invalid_google_flow', status: 403 })
  await assert.rejects(flow.complete(body, browserRequest(cookie, 'https://other.bridge.test'), serverResponse()), { status: 403 })
  await assert.rejects(flow.complete(body, browserRequest(cookie + '; ' + cookie), serverResponse()), { status: 403 })
  assert.equal(calls.length, 1)
  const end = serverResponse()
  assert.deepEqual(await flow.complete(body, browserRequest(cookie), end), { ok: true })
  assert.match(end.headers['set-cookie'], /Max-Age=0/)
  assert.equal(calls[1].path, '/google/redeem')
  assert.equal(calls[1].token, undefined)
  assert.equal(createHash('sha256').update(calls[1].body.verifier).digest('base64url'), calls[0].body.challenge)
  assert.equal(saved.length, 1)
  await assert.rejects(flow.complete(body, browserRequest(cookie), serverResponse()), { status: 403 })
})

test('the plugin never opens a different provider, OAuth callback or additional scope', async () => {
  for (const changeAuthorize of [
    a => { a.hostname = 'impostor.bridge.test' },
    a => { a.pathname = '/unrelated' },
    a => { a.username = 'spoof' },
    a => { a.hash = 'unexpected' },
    a => { a.searchParams.set('redirect_uri', 'https://other.bridge.test/api/v1/web/google/callback') },
    a => { a.searchParams.set('scope', 'openid email profile extra') },
    a => { a.searchParams.set('access_type', 'offline') },
    a => { a.searchParams.delete('code_challenge') },
    a => { a.searchParams.append('client_id', 'duplicate') },
  ]) {
    await assert.rejects(begin(makeFlow({ changeAuthorize }).flow), { message: 'invalid_hub_response' })
  }
})

test('existing Web identity is proven at start; a changed identity cannot finish', async () => {
  const identity = { hub_url: hub, device_id: 'existing', token: 'web_existing' }
  const { flow, calls, saved, changeIdentity } = makeFlow({ identity })
  await assert.rejects(flow.start({ hub_url: 'https://another.bridge.test' }, browserRequest(), serverResponse()), { message: 'web_hub_mismatch' })
  const { cookie } = await begin(flow)
  assert.equal(calls[0].token, identity.token)
  changeIdentity({ ...identity, token: 'web_new' })
  await assert.rejects(flow.complete({ flow_id: flowId, grant }, browserRequest(cookie), serverResponse()), { message: 'web_identity_changed' })
  assert.equal(saved.length, 0)
})

test('old Hub returns actionable disabled state; handoff HTML serves an exact CSP-bound script', async () => {
  const flow = makeFlow({ startError: Object.assign(new Error('not_found'), { status: 404 }) }).flow
  await assert.rejects(begin(flow), { message: 'google_not_configured', status: 503 })
  const res = serverResponse()
  serveGoogleHandoff({ method: 'GET' }, res)
  assert.equal(res.status, 200)
  const [_, inline] = /<script>(.+)<\/script>/.exec(res.html)
  assert.ok(res.headers['content-security-policy'].includes(createHash('sha256').update(inline).digest('base64')))
  assert.ok(res.headers['content-security-policy'].includes("connect-src 'self'"))
  assert.equal(res.headers['referrer-policy'], 'no-referrer')
  // The POST still needs the browser's Origin, even though the handoff document's navigation policy is no-referrer.
  assert.ok(inline.includes('referrerPolicy:"origin"'))
  assert.match(inline, /history\.replaceState.*fetch\("\/api\/cross-device\/web\/google\/complete"/)
})
