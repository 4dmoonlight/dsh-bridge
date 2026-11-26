/** Google account enrollment. The grant handoff never puts a Web device token in the browser. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const LOCAL_COMPLETE = '/api/cross-device/web/google/complete'
const HUB_CALLBACK = '/api/v1/web/google/callback'
export const GOOGLE_HANDOFF = '/dsh-bridge-google'
const ID = /^[A-Za-z0-9_-]{24,64}$/
const SECRET = /^[A-Za-z0-9_-]{32,128}$/
const MAX_PENDING = 32
const MAX_FLOW_MS = 10 * 60_000

function error(code, status = 400) {
  return Object.assign(new Error(code), { status })
}

function hash(value) {
  return createHash('sha256').update(value).digest()
}

function requestOrigin(req) {
  const raw = req.headers.origin
  if (typeof raw !== 'string') throw error('invalid_return_origin')
  try {
    const origin = new URL(raw)
    if (origin.origin === raw && (origin.protocol === 'https:' ||
        (origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)))) {
      return raw
    }
  } catch { /* fail closed */ }
  throw error('invalid_return_origin')
}

function authUrl(value, hub) {
  if (typeof value !== 'string' || value.length > 4096) throw error('invalid_hub_response', 502)
  let url
  try { url = new URL(value) } catch { throw error('invalid_hub_response', 502) }
  const params = url.searchParams
  const scopes = params.get('scope')?.split(/\s+/).sort().join(' ')
  // Only navigate to Google's code flow for the selected Hub, never a Hub-provided
  // login page, different callback, or request for Google API/refresh-token access.
  if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' ||
      url.username || url.password || value.includes('#') ||
      scopes !== 'email openid profile' ||
      params.get('response_type') !== 'code' || params.get('redirect_uri') !== hub + HUB_CALLBACK ||
      params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge') || '') ||
      !ID.test(params.get('state') || '') || !ID.test(params.get('nonce') || '') ||
      !params.get('client_id') || params.get('access_type') === 'offline' ||
      new Set(params.keys()).size !== [...params.keys()].length) {
    throw error('invalid_hub_response', 502)
  }
  return url.href
}

function cookieName(flowId) { return 'dsh_bridge_google_' + flowId }

function setCookie(res, origin, flowId, secret, age) {
  // A dedicated host-only, HTTP-only flow cookie binds redemption to the same
  // browser that started it. The static landing page's fetch is same-origin.
  res.setHeader('set-cookie', cookieName(flowId) + '=' + secret + '; Path=' + LOCAL_COMPLETE +
    '; HttpOnly; SameSite=Strict; Max-Age=' + age + (origin.startsWith('https:') ? '; Secure' : ''))
}

function cookieSecret(req, flowId) {
  const header = req.headers.cookie
  if (typeof header !== 'string') return null
  const prefix = cookieName(flowId) + '='
  const values = header.split(';').map(piece => piece.trim()).filter(piece => piece.startsWith(prefix))
  if (values.length !== 1) return null
  const secret = values[0].slice(prefix.length)
  return SECRET.test(secret) ? secret : null
}

export function createGoogleWebLogin({ normalizeHub, savedHub, currentIdentity, deviceName, request, accept }) {
  const pending = new Map()
  let disposed = false

  function expire(now = Date.now()) {
    for (const [id, flow] of pending) if (flow.expires <= now) pending.delete(id)
  }

  return {
    async start(body, req, res) {
      const identity = currentIdentity()
      const hub = normalizeHub(body.hub_url ?? identity?.hub_url ?? savedHub())
      if (!hub || new URL(hub).origin !== hub) throw error('invalid_hub_url')
      if (identity && normalizeHub(identity.hub_url) !== hub) throw error('web_hub_mismatch', 409)
      const origin = requestOrigin(req)
      expire()
      if (pending.size >= MAX_PENDING) throw error('rate_limited', 429)
      const verifier = randomBytes(32).toString('base64url')
      const secret = randomBytes(32).toString('base64url')
      const reply = await request(hub, identity?.token, 'POST', '/google/start', {
        device_name: deviceName(), return_origin: origin, challenge: hash(verifier).toString('base64url'),
      }).catch(err => {
        if (err.status === 404) throw error('google_not_configured', 503)
        throw err
      })
      const now = Date.now()
      const expires = Math.min(now + MAX_FLOW_MS, Date.parse(reply?.expires_at))
      if (disposed || typeof reply?.flow_id !== 'string' || !ID.test(reply.flow_id) ||
          !Number.isFinite(expires) || expires <= now || pending.has(reply.flow_id)) {
        throw error('invalid_hub_response', 502)
      }
      const url = authUrl(reply.authorization_url, hub)
      pending.set(reply.flow_id, { hub, verifier, origin, binding: hash(secret), identity, expires })
      setCookie(res, origin, reply.flow_id, secret, Math.ceil((expires - now) / 1000))
      return { authorization_url: url }
    },

    async complete(body, req, res) {
      const { flow_id: id, grant } = body
      const origin = requestOrigin(req)
      expire()
      if (typeof id !== 'string' || !ID.test(id) || typeof grant !== 'string' || !SECRET.test(grant)) {
        throw error('invalid_google_flow')
      }
      const flow = pending.get(id)
      const secret = cookieSecret(req, id)
      if (!flow || flow.origin !== origin || !secret || !timingSafeEqual(flow.binding, hash(secret))) {
        throw error('invalid_google_flow', 403)
      }
      const current = currentIdentity()
      if (flow.identity?.device_id !== current?.device_id || flow.identity?.token !== current?.token ||
          flow.identity?.hub_url !== current?.hub_url) {
        throw error('web_identity_changed', 409)
      }
      pending.delete(id)
      setCookie(res, origin, id, '', 0)
      const reply = await request(flow.hub, undefined, 'POST', '/google/redeem', {
        flow_id: id, grant, verifier: flow.verifier,
      })
      if (disposed) throw error('invalid_google_flow', 409)
      accept(flow.hub, reply, current)
      return { ok: true }
    },

    dispose() {
      disposed = true
      pending.clear()
    },
  }
}

const script = '(async()=>{ const info=document.getElementById("status");' +
  'const values=new URLSearchParams(location.hash.slice(1)); history.replaceState(null,"",location.pathname);' +
  'const flow=values.getAll("flow_id"), grant=values.getAll("grant");' +
  'if(flow.length!==1 || grant.length!==1){info.textContent="登录请求已失效，请返回跨设备页面重试。";return;}' +
  'try{const result=await fetch("' + LOCAL_COMPLETE + '",{method:"POST",mode:"same-origin",credentials:"same-origin",' +
  'redirect:"error",referrerPolicy:"origin",headers:{"content-type":"application/json","x-cross-device":"1"},' +
  'body:JSON.stringify({flow_id:flow[0],grant:grant[0]})}); const data=await result.json();' +
  'if(result.ok && data.ok===true){info.textContent="Google 登录完成。请返回原标签页查看设备。";setTimeout(()=>window.close(),500);return;}' +
  'info.textContent=data.error?.code==="google_account_mismatch"?"本设备已关联另一 Google 账号。":"无法完成登录。请在启动登录的同一个浏览器中重试。";' +
  '}catch{info.textContent="无法完成登录，请返回跨设备页面重试。";} })();'
const policy = "default-src 'none'; connect-src 'self'; script-src 'sha256-" + hash(script).toString('base64') +
  "'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
const page = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>跨设备 · Google 登录</title>' +
  '<p id="status" role="status">正在完成 Google 登录…</p><a href="/">返回 DeepSeek Harness</a>' +
  '<script>' + script + '</script></html>'

export function serveGoogleHandoff(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': policy,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cross-origin-opener-policy': 'same-origin',
  })
  res.end(req.method === 'HEAD' ? undefined : page)
}
