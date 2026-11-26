/** Device pairing for opening an independently authenticated, original DSH Web. */
import { createHubClient } from './hub-client.js'
import { createGoogleWebLogin, GOOGLE_HANDOFF, serveGoogleHandoff } from './google-web.js'

const LOCAL_API = '/api/cross-device/web'
const HUB_API = '/api/v1/web'
const ENTRY_PATH = '/dsh-bridge-enter'
const HEARTBEAT_MS = 25_000
const CODE = /^[a-zA-Z0-9_-]{24}$/
const DEVICE_ID = /^[a-zA-Z0-9_-]{1,200}$/
const TOKEN = /^[a-zA-Z0-9_.-]{24,256}$/

function failure(code, status = 400) {
  return Object.assign(new Error(code), { status })
}

function errorCode(err) {
  return typeof err?.message === 'string' && /^[a-z0-9_]{1,64}$/.test(err.message)
    ? err.message : 'hub_unavailable'
}

function parseUrl(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (raw.length > 2048 || !/^https?:\/\/[^/]/i.test(raw) || /[@?#\\\s\u0000-\u001f\u007f]/.test(raw)) return null
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

function isLoopback(host) {
  const name = host.toLowerCase().replace(/\.$/, '')
  return name === 'localhost' || name.endsWith('.localhost') || name === '[::1]' ||
    name.startsWith('127.') || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]+\]$/.test(name)
}

function hubRoot(value) {
  const url = parseUrl(value)
  if (!url || (url.protocol !== 'https:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) return null
  return url.href.replace(/\/+$/, '')
}

export function webOrigin(value) {
  const url = parseUrl(value)
  if (!url || url.protocol !== 'https:' || isLoopback(url.hostname) ||
      url.hostname === '0.0.0.0' || url.hostname === '[::]') return null
  // DSH's plugin routes are root-relative. Don't accept a path that URL parsing
  // normalizes away (e.g. /other/..); this field is an origin, not a redirect.
  if (!/^https:\/\/[^/]+\/?$/i.test(value.trim()) || url.pathname !== '/') return null
  return url.origin
}

function identityOf(config) {
  const identity = config.web
  if (!identity || !hubRoot(identity.hub_url) ||
      typeof identity.device_id !== 'string' || !DEVICE_ID.test(identity.device_id) ||
      typeof identity.token !== 'string' || !TOKEN.test(identity.token)) return null
  return identity
}

const entryPage = '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
  '<meta http-equiv="refresh" content="0;url=./">' +
  '<title>打开远端 DeepSeek Harness</title><a href="./">继续打开 DeepSeek Harness</a></html>'

export function registerWebAccess({ ctx, getConfig, saveIdentity, json, readBody, guard }) {
  let stopped = false
  let mutable = false
  let heartbeat = Promise.resolve()
  const disposers = []

  function advertisedOrigin() {
    return webOrigin(ctx.webApp.getAdvertisedUrl())
  }

  function publishedOrigin(config) {
    const url = webOrigin(config.web?.web_url)
    // Never publish some other site, or a URL left over from an old deployment.
    return url && url === advertisedOrigin() ? url : null
  }

  function deviceName() {
    const name = getConfig().device_name
    return (typeof name === 'string' && name.trim() || 'DSH').slice(0, 200)
  }

  function request(hub, token, method, endpoint, body) {
    return createHubClient({ getConfig: () => ({ hub_url: hub, hub_token: token }), redirect: 'error' })
      .request(method, HUB_API + endpoint, body, { authenticated: token !== undefined })
  }

  function forDevice(identity, method, endpoint, body) {
    return request(hubRoot(identity.hub_url), identity.token, method, endpoint, body)
  }

  function publishPresence() {
    // Serialize writes so an old heartbeat can't re-publish an address after clearing it.
    const pending = heartbeat.then(async () => {
      if (stopped) return
      const config = getConfig()
      const identity = identityOf(config)
      if (identity) {
        await forDevice(identity, 'POST', '/presence', {
          device_name: deviceName(), web_url: publishedOrigin(config),
        })
      }
    })
    heartbeat = pending.catch(() => {})
    return pending
  }

  function receiveIdentity(hub, result, provider = null) {
    if (typeof result?.device_id !== 'string' || !DEVICE_ID.test(result.device_id) ||
        typeof result.token !== 'string' || !TOKEN.test(result.token)) {
      throw failure('invalid_hub_response', 502)
    }
    saveIdentity({ hub_url: hub, device_id: result.device_id, token: result.token, web_url: null,
      ...(provider ? { login_provider: provider } : {}) })
    void publishPresence().catch(() => {})
  }

  const google = createGoogleWebLogin({
    normalizeHub: hubRoot,
    savedHub: () => getConfig().hub_url,
    currentIdentity: () => identityOf(getConfig()),
    deviceName, request,
    accept(hub, reply, existing) {
      if (!existing) return receiveIdentity(hub, reply, 'google')
      if (reply?.device_id !== existing.device_id || reply.token !== undefined) {
        throw failure('invalid_hub_response', 502)
      }
      saveIdentity({ ...existing, login_provider: 'google' })
      void publishPresence().catch(() => {})
    },
  })

  async function status() {
    const config = getConfig()
    const identity = identityOf(config)
    const syncHub = hubRoot(config.hub_url)
    const result = {
      joined: Boolean(identity),
      login_provider: identity?.login_provider === 'google' ? 'google' : null,
      can_enroll: !identity && Boolean(syncHub && config.hub_token),
      hub_url: identity?.hub_url || syncHub || '',
      device_name: deviceName(),
      web_url: publishedOrigin(config),
      advertised_web_url: advertisedOrigin(),
      devices: [],
    }
    if (!identity) return result
    let data
    try {
      data = await forDevice(identity, 'GET', '/devices')
      if (!Array.isArray(data?.devices)) throw failure('invalid_hub_response', 502)
    } catch (err) {
      // Keep local sharing controls available even when the Hub is unreachable.
      // Do not return stale peers or fall back to the unscoped sync sidebar.
      return { ...result, web_error: errorCode(err) }
    }
    result.devices = data.devices.filter(d =>
      typeof d?.device_id === 'string' && DEVICE_ID.test(d.device_id) && d.device_id !== identity.device_id &&
      typeof d.device_name === 'string' && (d.status === 'online' || d.status === 'offline'),
    ).map(d => ({
      device_id: d.device_id, device_name: d.device_name, status: d.status,
      web_enabled: d.web_enabled === true,
    }))
    return result
  }

  async function enroll() {
    const config = getConfig()
    if (identityOf(config)) return { ok: true }
    const hub = hubRoot(config.hub_url)
    if (!hub || !config.hub_token) throw failure('instance_token_required', 403)
    const result = await request(hub, config.hub_token, 'POST', '/enroll', { device_name: deviceName() }).catch(err => {
      if (err.status === 401 || err.status === 403) throw failure('instance_token_required', 403)
      throw err
    })
    receiveIdentity(hub, result)
    return { ok: true }
  }

  async function claim(body) {
    const identity = identityOf(getConfig())
    const hub = hubRoot(body.hub_url)
    if (!hub) throw failure('invalid_hub_url')
    if (identity && hub !== hubRoot(identity.hub_url)) throw failure('web_hub_mismatch', 409)
    if (typeof body.code !== 'string' || !CODE.test(body.code)) throw failure('invalid_code')
    const result = await request(hub, identity?.token, 'POST', '/pairing/claim', {
      code: body.code, device_name: deviceName(),
    })
    if (!identity) receiveIdentity(hub, result)
    else if (result?.device_id !== identity.device_id) throw failure('invalid_hub_response', 502)
    return { ok: true }
  }

  function requireIdentity() {
    const identity = identityOf(getConfig())
    if (!identity) throw failure('web_not_joined', 409)
    return identity
  }

  async function pairingCode() {
    const result = await forDevice(requireIdentity(), 'POST', '/pairing/code', {})
    if (typeof result?.code !== 'string' || !CODE.test(result.code) ||
        typeof result.expires_at !== 'string' || !Number.isFinite(Date.parse(result.expires_at))) {
      throw failure('invalid_hub_response', 502)
    }
    return { code: result.code, expires_at: result.expires_at }
  }

  async function presence(body) {
    const identity = requireIdentity()
    const url = body.web_url === null ? null : webOrigin(body.web_url)
    if (!url && body.web_url !== null) throw failure('invalid_web_url')
    if (url && url !== advertisedOrigin()) throw failure('web_url_not_advertised', 409)
    saveIdentity({ ...identity, web_url: url })
    await publishPresence()
    return { ok: true }
  }

  function targetOf(body) {
    if (typeof body.device_id !== 'string' || !DEVICE_ID.test(body.device_id)) throw failure('invalid_device_id')
    return { device_id: body.device_id }
  }

  async function open(body, req) {
    const result = await forDevice(requireIdentity(), 'POST', '/open', targetOf(body))
    const url = webOrigin(result?.url)
    if (!url) throw failure('invalid_hub_response', 502)
    if (url === advertisedOrigin() || matchesHost(url, req.headers.host)) throw failure('web_url_same_device', 409)
    return { entry_url: url + ENTRY_PATH }
  }

  async function unpair(body) {
    await forDevice(requireIdentity(), 'POST', '/unpair', targetOf(body))
    return { ok: true }
  }

  function matchesHost(origin, host) {
    if (typeof host !== 'string') return false
    const url = new URL(origin)
    const requested = host.toLowerCase()
    return requested === url.host || (!url.port && requested === url.host + ':443')
  }

  function register(path, method, handler, mutation = false) {
    disposers.push(ctx.webServer.register({
      kind: 'exact', path: LOCAL_API + path,
      handler: async (req, res) => {
        if (!guard(req, res, { requireHeader: true })) return
        if (req.method !== method) return json(res, 405, { error: { code: 'method_not_allowed' } })
        if (mutation && mutable) return json(res, 409, { error: { code: 'web_busy' } })
        if (mutation) mutable = true
        try {
          let body
          if (method === 'POST') {
            body = await readBody(req).catch(() => { throw failure('invalid_body') })
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('invalid_body')
          }
          json(res, 200, await handler(body, req, res))
        } catch (err) {
          const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 502
          json(res, status, { error: { code: errorCode(err) } })
        } finally {
          if (mutation) mutable = false
        }
      },
    }))
  }

  register('/status', 'GET', status)
  register('/enroll', 'POST', enroll, true)
  register('/pairing/code', 'POST', pairingCode)
  register('/pairing/claim', 'POST', claim, true)
  register('/presence', 'POST', presence, true)
  register('/open', 'POST', open)
  register('/unpair', 'POST', unpair, true)
  register('/google/start', 'POST', google.start, true)
  register('/google/complete', 'POST', google.complete, true)
  disposers.push(ctx.webServer.register({ kind: 'exact', path: GOOGLE_HANDOFF, handler: serveGoogleHandoff }))

  disposers.push(ctx.webServer.register({
    kind: 'exact', path: ENTRY_PATH,
    handler: (req, res) => {
      const origin = publishedOrigin(getConfig())
      if (!origin || !matchesHost(origin, req.headers.host)) return json(res, 404, { error: { code: 'not_found' } })
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: { code: 'method_not_allowed' } })
      // A cross-site first navigation does not send DSH's SameSite=Strict cookie.
      // This fixed, public handoff makes the subsequent navigation same-origin.
      // It contains no device/user data and doesn't authenticate anyone to DSH.
      res.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      })
      res.end(req.method === 'HEAD' ? undefined : entryPage)
    },
  }))

  const timer = setInterval(() => void publishPresence().catch(() => {}), HEARTBEAT_MS)
  timer.unref?.()
  void publishPresence().catch(() => {})
  return () => {
    stopped = true
    google.dispose()
    clearInterval(timer)
    for (const dispose of disposers) dispose()
  }
}
