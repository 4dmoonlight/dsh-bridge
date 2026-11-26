import { createHash, randomBytes } from 'node:crypto'
import { setMaxListeners } from 'node:events'
import { createServer } from 'node:net'
import { connectRelayStream, createRelayCertificate, registerRelayHost, relayClientTls, relayError, relayServerTls } from './relay-transport.js'
import { createRelayTarget } from './relay-target.js'

const ID = /^[A-Za-z0-9_-]{20,100}$/
const FINGERPRINT = /^[a-f0-9]{64}$/
const HASH = /^[A-Za-z0-9_-]{43}$/
const MAX_LEASE_MS = 30 * 60 * 1000
const MAX_CONNECTIONS = 12
const MAX_VIEWS = 6
const MAX_INCOMING = 24
const BIND_HOST = '127.0.0.1'
const IDLE_VIEW_MS = 60_000
const LOCAL_ENTRY = '/dsh-relay-enter'

function validExpiry(expires) {
  const now = Date.now()
  return Number.isSafeInteger(expires) && expires > now && expires <= now + MAX_LEASE_MS + 60_000
}

function validIncoming(frame) {
  return frame.type === 'incoming' && typeof frame.connection_id === 'string' && ID.test(frame.connection_id) &&
    typeof frame.lease_id === 'string' && ID.test(frame.lease_id) && typeof frame.authority === 'string' &&
    /^[a-f0-9]{32}\.dsh-relay\.localhost:[1-9]\d{0,4}$/.test(frame.authority) &&
    Number(frame.authority.split(':')[1]) <= 65535 &&
    typeof frame.grant_hash === 'string' && HASH.test(frame.grant_hash) && validExpiry(frame.expires_at)
}

export function createRelayController(ctx) {
  let control = null
  let closed = false
  const views = new Set()

  function disable() {
    const current = control
    control = null
    if (!current) return
    stopConnection(current)
    if (current.timer) clearTimeout(current.timer)
  }

  function stopConnection(current) {
    current.ready = false
    current.target?.close()
    current.target = null
    const abort = current.abort
    current.abort = null
    abort?.abort()
  }

  async function acceptIncoming(current, abort, certificate, frame) {
    if (control !== current || abort.signal.aborted || !current.target || current.incoming >= MAX_INCOMING) return
    current.incoming++
    let raw, socket
    try {
      raw = await connectRelayStream(current.identity.hub, {
        type: 'join', token: current.identity.token, connection_id: frame.connection_id,
      }, abort.signal)
      socket = await relayServerTls(raw, certificate)
      if (control !== current || abort.signal.aborted || !current.target) throw relayError('relay_closed')
      current.target.accept(frame, socket)
      if (!socket.destroyed) {
        socket.once('close', () => { current.incoming-- })
        return
      }
    } catch {
      raw?.destroy()
      socket?.destroy()
    }
    current.incoming--
  }

  function ensureLoopback() {
    const local = new URL(ctx.webServer.getOrigin())
    if (!['127.0.0.1', '[::1]'].includes(local.hostname)) throw relayError('relay_requires_loopback', 409)
  }

  async function connectControl(current) {
    if (control !== current) return
    current.timer = null
    const abort = new AbortController()
    setMaxListeners(MAX_INCOMING + 2, abort.signal)
    current.abort = abort
    const retry = () => {
      if (control !== current || current.abort !== abort) return
      stopConnection(current)
      current.delay = Math.min(30000, current.delay * 2)
      current.timer = setTimeout(() => { void connectControl(current) }, current.delay)
      current.timer.unref?.()
    }
    try {
      ensureLoopback()
      const certificate = await (current.certificate ??= createRelayCertificate().catch(error => {
        current.certificate = null
        throw error
      }))
      if (control !== current || abort.signal.aborted) return
      current.target = createRelayTarget(ctx)
      current.error = null
      await registerRelayHost(current.identity.hub, current.identity.token, certificate.fingerprint, {
        signal: abort.signal,
        onFrame(frame) {
          if (!validIncoming(frame)) throw relayError('relay_protocol_error')
          void acceptIncoming(current, abort, certificate, frame)
        },
        onClose(error) {
          if (error.message === 'host_replaced') { if (control === current) disable(); return }
          current.error = error.message
          retry()
        },
      })
      if (control !== current || abort.signal.aborted) return
      current.ready = true
      current.delay = 1000
    } catch (err) {
      current.error = err?.message || 'relay_unavailable'
      retry()
    }
  }

  function enable(identity) {
    if (closed) throw relayError('relay_closed')
    if (control?.identity.hub === identity.hub && control.identity.token === identity.token) return
    ensureLoopback()
    if (typeof WebSocket !== 'function') throw relayError('relay_not_supported', 503)
    disable()
    control = { identity, abort: null, target: null, certificate: null, delay: 1000, timer: null, ready: false, incoming: 0, error: null }
    void connectControl(control)
  }

  async function open(identity, deviceId, requestLease, closeLease) {
    if (closed) throw relayError('relay_closed')
    if (views.size >= MAX_VIEWS) {
      const idle = [...views].find(view => view.isIdle())
      if (!idle) throw relayError('relay_view_limit', 429)
      await idle()
      if (closed) throw relayError('relay_closed')
      if (views.size >= MAX_VIEWS) throw relayError('relay_view_limit', 429)
    }
    const controller = new AbortController()
    setMaxListeners(MAX_CONNECTIONS + 2, controller.signal)
    const sockets = new Set()
    let lease, timer, idleTimer, destroyed = false
    function idleCheck() {
      if (destroyed || !lease || sockets.size) return
      clearTimeout(idleTimer)
      idleTimer = setTimeout(release, IDLE_VIEW_MS)
      idleTimer.unref?.()
    }
    function acceptBrowser(source) {
      source.on('error', () => {})
      if (!lease || controller.signal.aborted || Date.now() >= lease.expires_at || sockets.size >= MAX_CONNECTIONS) {
        source.destroy()
        return
      }
      sockets.add(source)
      clearTimeout(idleTimer)
      source.setNoDelay(true)
      const session = new AbortController()
      const abort = () => session.abort()
      controller.signal.addEventListener('abort', abort, { once: true })
      source.once('close', () => {
        sockets.delete(source)
        idleCheck()
        controller.signal.removeEventListener('abort', abort)
        abort()
      })
      void (async () => {
        let raw, secured
        try {
          raw = await connectRelayStream(identity.hub, { type: 'viewer', token: identity.token, lease_id: lease.lease_id }, session.signal)
          secured = await relayClientTls(raw, lease.fingerprint)
          if (session.signal.aborted) throw relayError('relay_closed')
          secured.once('close', () => source.destroy())
          secured.pipe(source)
          source.pipe(secured)
        } catch {
          raw?.destroy()
          secured?.destroy()
          if (!source.destroyed) source.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        }
      })()
    }
    const server4 = createServer({ pauseOnConnect: true }, acceptBrowser)
    const server6 = createServer({ pauseOnConnect: true }, acceptBrowser)
    async function listen(server, host, port) {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen({ host, port, exclusive: true, ipv6Only: host === '::1' }, () => {
          server.off('error', reject)
          server.on('error', () => release())
          server.unref()
          if (destroyed) { server.close(); reject(relayError('relay_closed')) }
          else resolve()
        })
      })
    }
    function release() {
      if (destroyed) return
      destroyed = true
      views.delete(release)
      clearTimeout(timer)
      clearTimeout(idleTimer)
      controller.abort()
      for (const listener of [server4, server6]) if (listener.listening) listener.close()
      for (const socket of sockets) socket.destroy()
      return lease ? closeLease({ lease_id: lease.lease_id }).catch(() => {}) : undefined
    }
    release.isIdle = () => Boolean(lease) && sockets.size === 0
    views.add(release)
    try {
      await listen(server4, BIND_HOST, 0)
      const { port } = server4.address()
      try { await listen(server6, '::1', port) }
      catch (err) { if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(err?.code)) throw err }
      // Cookies do not distinguish ports. A new localhost hostname prevents
      // unrelated local services and other relay windows sharing browser cookies.
      const authority = randomBytes(16).toString('hex') + '.dsh-relay.localhost:' + port
      const grant = randomBytes(32)
      const hash = createHash('sha256').update(grant).digest('base64url')
      const info = await requestLease({ device_id: deviceId, authority, grant_hash: hash })
      if ((closed || destroyed) && typeof info?.lease_id === 'string' && ID.test(info.lease_id)) {
        void closeLease({ lease_id: info.lease_id }).catch(() => {})
        throw relayError('relay_closed')
      }
      if (typeof info?.lease_id !== 'string' || !ID.test(info.lease_id) ||
          typeof info.fingerprint !== 'string' || !FINGERPRINT.test(info.fingerprint) || !validExpiry(info.expires_at)) {
        throw relayError('invalid_hub_response')
      }
      lease = { ...info, expires_at: Math.min(info.expires_at, Date.now() + MAX_LEASE_MS) }
      timer = setTimeout(release, Math.max(0, lease.expires_at - Date.now()))
      timer.unref?.()
      idleCheck()
      return { entry_url: 'http://' + authority + LOCAL_ENTRY + '#' + grant.toString('base64url') }
    } catch (err) {
      release()
      throw err
    }
  }

  return {
    enable, disable, open,
    enabled: () => control !== null,
    ready: () => control?.ready === true,
    error: () => control?.error || null,
    close() {
      closed = true
      disable()
      for (const release of views) release()
    },
  }
}
