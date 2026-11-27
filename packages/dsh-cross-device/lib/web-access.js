/** Google-bound discovery and owner-approved remote DSH Web. */
import { createHubClient } from './hub-client.js'
import { createGoogleWebLogin, GOOGLE_HANDOFF, serveGoogleHandoff } from './google-web.js'
import { createRelayController } from './relay-control.js'

const LOCAL_API = '/api/cross-device/web'
const HUB_API = '/api/v1/web'
const HEARTBEAT_MS = 25_000
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

function hubRoot(value) {
  const url = parseUrl(value)
  if (!url || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) return null
  return url.origin
}

function identityOf(config) {
  const identity = config.web
  if (!identity || !hubRoot(identity.hub_url) ||
      typeof identity.device_id !== 'string' || !DEVICE_ID.test(identity.device_id) ||
      typeof identity.token !== 'string' || !TOKEN.test(identity.token)) return null
  return identity
}

export function registerWebAccess({ ctx, getConfig, saveIdentity, json, readBody, guard }) {
  let stopped = false
  let mutable = false
  let heartbeat = Promise.resolve()
  const disposers = []
  const relay = createRelayController(ctx)

  function relayIdentity(identity) {
    return { hub: hubRoot(identity.hub_url), token: identity.token }
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
    // Serialize presence updates; the new plugin never publishes a direct URL.
    const pending = heartbeat.then(async () => {
      if (stopped) return
      const config = getConfig()
      const identity = identityOf(config)
      if (identity) {
        await forDevice(identity, 'POST', '/presence', {
          device_name: deviceName(), web_url: null,
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
    saveIdentity({ hub_url: hub, device_id: result.device_id, token: result.token,
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
      const next = { ...existing, login_provider: 'google' }
      saveIdentity(next)
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
      hub_url: identity?.hub_url || syncHub || '',
      device_name: deviceName(),
      devices: [],
    }
    const localControl = (hubReady = false) => ({
      remote_control_enabled: relay.enabled(),
      portal_access_enabled: relay.portalAccessEnabled(),
      control_ready: hubReady && relay.ready(),
      ...(relay.error() ? { control_error: errorCode({ message: relay.error() }) } : {}),
    })
    if (identity?.login_provider !== 'google') return { ...result, ...localControl() }
    let data
    try {
      data = await forDevice(identity, 'GET', '/relay/devices')
      if (!Array.isArray(data?.devices)) throw failure('invalid_hub_response', 502)
    } catch (err) {
      // Keep local sharing controls available even when the Hub is unreachable.
      // Do not return stale peers or fall back to the unscoped sync sidebar.
      return { ...result, ...localControl(), web_error: err?.status === 404 ? 'relay_not_ready' : errorCode(err) }
    }
    result.devices = data.devices.filter(d =>
      typeof d?.device_id === 'string' && DEVICE_ID.test(d.device_id) && d.device_id !== identity.device_id &&
      typeof d.device_name === 'string' && (d.status === 'online' || d.status === 'offline'),
    ).map(d => ({
      device_id: d.device_id, device_name: d.device_name, status: d.status,
      web_enabled: d.web_enabled === true,
    }))
    return { ...result, ...localControl(data.control_ready === true) }
  }

  function requireGoogleIdentity() {
    const identity = identityOf(getConfig())
    if (identity?.login_provider !== 'google') throw failure('google_binding_required', 403)
    return identity
  }

  function requireLocalControl(req) {
    const localHosts = ['127.0.0.1', 'localhost', '[::1]']
    const localAddresses = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
    const origin = parseUrl(req.headers.origin)
    if (!origin || origin.origin !== req.headers.origin || !localHosts.includes(origin.hostname) ||
        origin.protocol !== ctx.webServer.protocol || origin.host !== req.headers.host ||
        Number(origin.port || (origin.protocol === 'https:' ? '443' : '80')) !== ctx.webServer.port ||
        !localAddresses.includes(req.socket.remoteAddress)) {
      throw failure('local_control_only', 403)
    }
  }

  async function setControl(body, req) {
    requireLocalControl(req)
    if (typeof body.enabled !== 'boolean') throw failure('invalid_body')
    const identity = requireGoogleIdentity()
    // Opt in for this running DSH instance only. Restarts never grant remote access.
    if (body.enabled) relay.enable(relayIdentity(identity))
    else relay.disable()
    return { ok: true }
  }

  function setPortalControl(body, req) {
    requireLocalControl(req)
    if (typeof body.enabled !== 'boolean') throw failure('invalid_body')
    const identity = requireGoogleIdentity()
    relay.setPortalAccess(relayIdentity(identity), body.enabled)
    return { ok: true }
  }

  async function open(body) {
    const identity = requireGoogleIdentity()
    if (typeof body.device_id !== 'string' || !DEVICE_ID.test(body.device_id) || body.device_id === identity.device_id) {
      throw failure('invalid_device_id')
    }
    return relay.open(relayIdentity(identity), body.device_id,
      data => forDevice(identity, 'POST', '/relay/open', data),
      data => forDevice(identity, 'POST', '/relay/close', data))
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
  register('/control', 'POST', setControl)
  register('/portal-control', 'POST', setPortalControl)
  register('/open', 'POST', open)
  register('/google/start', 'POST', google.start, true)
  register('/google/complete', 'POST', google.complete, true)
  disposers.push(ctx.webServer.register({ kind: 'exact', path: GOOGLE_HANDOFF, handler: serveGoogleHandoff }))

  const timer = setInterval(() => void publishPresence().catch(() => {}), HEARTBEAT_MS)
  timer.unref?.()
  void publishPresence().catch(() => {})
  return () => {
    stopped = true
    relay.close()
    google.dispose()
    clearInterval(timer)
    for (const dispose of disposers) dispose()
  }
}
