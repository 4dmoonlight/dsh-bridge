import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { test } from 'node:test'
import { connectRelayStream, relayClientTls } from '../lib/relay-transport.js'
import { registerWebAccess } from '../lib/web-access.js'

const hub = 'https://hub.fixture.test'
const local = 'http://127.0.0.1:3080'
const token = 'web_' + 'x'.repeat(48)
const authority = 'f'.repeat(32) + '.dsh-relay.localhost:4080'
const leaseId = 'L'.repeat(32)
const incoming = (connectionId) => ({
  type: 'incoming', connection_id: connectionId, lease_id: leaseId,
  authority, grant_hash: 'A'.repeat(43), expires_at: Date.now() + 60_000,
})

function fixture(t, loginProvider = 'google') {
  const handlers = new Map()
  const wire = []
  const frames = new EventEmitter()
  const config = { web: { hub_url: hub, device_id: 'fixture', token, login_provider: loginProvider } }
  const json = (res, status, body) => Object.assign(res, { status, body })
  const originalFetch = globalThis.fetch
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
  let devices = () => ({ control_ready: true, devices: [] })
  let hostRegistrationAvailable = true
  let disposer
  const hubRequests = []

  class FixtureWebSocket extends EventTarget {
    constructor(url) {
      super()
      assert.equal(url.href, 'wss://hub.fixture.test/api/v1/web/relay')
      this.readyState = 0
      queueMicrotask(() => {
        if (this.readyState !== 0) return
        this.readyState = 1
        this.dispatchEvent(new Event('open'))
      })
    }

    receive(frame) {
      this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(frame) }))
    }

    send(text) {
      assert.equal(this.readyState, 1)
      const frame = JSON.parse(text)
      if (!this.first) {
        this.first = frame
        wire.push({ socket: this, frame })
        frames.emit('sent')
        if (frame.type === 'host' && hostRegistrationAvailable) queueMicrotask(() => this.receive({ type: 'ready' }))
      } else queueMicrotask(() => this.peer?.receive(frame))
    }

    close() {
      // No close notification to the remote peer: revocation must not need
      // an acknowledgement, even when the network has stopped responding.
      this.readyState = 3
    }
  }

  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: FixtureWebSocket })
  globalThis.fetch = async (url, init) => {
    hubRequests.push({ url, method: init.method })
    assert.equal(init.headers.authorization, 'Bearer ' + token)
    if (url === hub + '/api/v1/web/presence') return { ok: true, text: async () => '{}' }
    assert.equal(url, hub + '/api/v1/web/relay/devices')
    const data = await devices()
    return { ok: true, text: async () => JSON.stringify(data) }
  }
  function restart() {
    disposer?.()
    disposer = registerWebAccess({
      ctx: { webServer: {
        protocol: 'http:', port: 3080, getOrigin: () => local,
        register({ path, handler }) { handlers.set(path, handler); return () => handlers.delete(path) },
      } },
      getConfig: () => config,
      saveIdentity() { assert.fail('control permission must not persist') },
      json,
      readBody: async req => req.body,
      guard(req, res, opts) {
        assert.deepEqual(opts, { requireHeader: true })
        if (req.owner && req.headers['x-cross-device'] === '1') return true
        json(res, 403, { error: { code: 'forbidden' } })
        return false
      },
    })
  }
  restart()
  t.after(() => {
    disposer()
    globalThis.fetch = originalFetch
    if (originalWebSocket) Object.defineProperty(globalThis, 'WebSocket', originalWebSocket)
    else delete globalThis.WebSocket
  })

  return {
    restart, wire, hubRequests,
    setDevices: create => { devices = create },
    setHostRegistrationAvailable: value => { hostRegistrationAvailable = value },
    async call(path, body, options = {}) {
      const res = {}
      const { owner = true, origin = local, header = '1', address = '127.0.0.1' } = options
      await handlers.get('/api/cross-device/web/' + path)({
        method: body === undefined ? 'GET' : 'POST', body, owner,
        headers: { origin, host: '127.0.0.1:3080', 'x-cross-device': header },
        socket: { remoteAddress: address },
      }, res)
      return res
    },
    async sent(type, ordinal = 0) {
      const signal = AbortSignal.timeout(5000)
      for (;;) {
        const item = wire.filter(({ frame }) => frame.type === type)[ordinal]
        if (item) return item
        await once(frames, 'sent', { signal })
      }
    },
  }
}

const ok = { status: 200, body: { ok: true } }
const enable = { enabled: true }
const disable = { enabled: false }
const errorCode = result => result.body.error.code

async function assertStatus(bridge, normal, portalEnabled) {
  const res = await bridge.call('status')
  assert.equal(res.status, 200)
  assert.equal(res.body.remote_control_enabled, normal)
  assert.equal(res.body.portal_access_enabled, portalEnabled)
  return res.body
}

function linkedStream(bridge, ordinal, abort) {
  const viewerOrdinal = bridge.wire.filter(({ frame }) => frame.type === 'viewer').length
  const pending = connectRelayStream(hub, { type: 'viewer', token, lease_id: leaseId }, abort.signal)
  return Promise.all([bridge.sent('join', ordinal), bridge.sent('viewer', viewerOrdinal)]).then(([join, viewer]) => {
    join.socket.peer = viewer.socket
    viewer.socket.peer = join.socket
    join.socket.receive({ type: 'connected' })
    viewer.socket.receive({ type: 'connected' })
    return pending
  })
}

async function enter(bridge, registration, ordinal, abort) {
  registration.socket.receive(incoming((ordinal + 1).toString().repeat(32)))
  const stream = await linkedStream(bridge, ordinal, abort)
  const socket = await relayClientTls(stream, registration.frame.fingerprint)
  const reply = once(socket, 'data', { signal: AbortSignal.timeout(3000) })
  socket.write('GET /dsh-relay-enter HTTP/1.1\r\nHost: ' + authority + '\r\n\r\n')
  assert.match((await reply)[0].toString(), /^HTTP\/1\.1 200 OK/)
  return { socket, join: await bridge.sent('join', ordinal) }
}

test('control changes are owner-guarded, local only, and require ordinary sharing first', async (t) => {
  const bridge = fixture(t)
  await assertStatus(bridge, false, false)
  assert.equal(errorCode(await bridge.call('portal-control', enable, { owner: false })), 'forbidden')
  assert.equal(errorCode(await bridge.call('portal-control', enable, { header: '' })), 'forbidden')
  assert.equal(errorCode(await bridge.call('portal-control', enable, { origin: hub })), 'local_control_only')
  assert.equal(errorCode(await bridge.call('portal-control', disable, { address: '192.0.2.1' })), 'local_control_only')
  assert.equal(errorCode(await bridge.call('portal-control', { enabled: 'true' })), 'invalid_body')
  assert.equal(errorCode(await bridge.call('portal-control', enable)), 'remote_control_required')
  assert.deepEqual(await bridge.call('portal-control', disable), ok)
  assert.equal(bridge.wire.length, 0)
  await assertStatus(bridge, false, false)
})

test('legacy identities cannot enable portal sharing', async (t) => {
  // A joined identity without a Google binding has no sharing permissions.
  const unbound = fixture(t, 'legacy')
  await assertStatus(unbound, false, false)
  assert.equal(errorCode(await unbound.call('portal-control', enable)), 'google_binding_required')
  assert.equal(unbound.wire.length, 0)
})

test('abort immediately after the relay handshake rejects before returning a stream', async (t) => {
  const bridge = fixture(t)
  const abort = new AbortController()
  const pending = connectRelayStream(hub, { type: 'viewer', token, lease_id: leaseId }, abort.signal)
  const viewer = await bridge.sent('viewer')
  viewer.socket.receive({ type: 'connected' })
  abort.abort()
  await assert.rejects(pending, { message: 'relay_closed' })
  assert.equal(viewer.socket.readyState, 3)
})

test('portal control rotates the wire registration and kills live and pending local leases', { timeout: 12000 }, async (t) => {
  const bridge = fixture(t)
  const viewer = new AbortController()
  t.after(() => viewer.abort())
  await assertStatus(bridge, false, false)
  assert.deepEqual(await bridge.call('control', enable), ok)
  const normal = await bridge.sent('host')
  const { fingerprint, ...initial } = normal.frame
  assert.match(fingerprint, /^[a-f0-9]{64}$/)
  assert.deepEqual(initial, { type: 'host', token })
  await assertStatus(bridge, true, false)

  const original = await enter(bridge, normal, 0, viewer)
  assert.deepEqual(await bridge.call('portal-control', enable), ok)
  assert.equal(normal.socket.readyState, 3)
  assert.equal(original.join.socket.readyState, 3)
  const portal = await bridge.sent('host', 1)
  assert.deepEqual(portal.frame, { type: 'host', token, fingerprint: portal.frame.fingerprint, portal_access: true })
  const active = await enter(bridge, portal, 1, viewer)
  portal.socket.receive(incoming('P'.repeat(32)))
  const pending = await bridge.sent('join', 2)
  assert.deepEqual(await bridge.call('portal-control', enable), ok)
  assert.equal(portal.socket.readyState, 1, 'setting same permission is idempotent')
  await assertStatus(bridge, true, true)

  let finishStatus
  bridge.setDevices(() => new Promise(resolve => { finishStatus = resolve }))
  const delayed = bridge.call('status')
  const previousCalls = bridge.hubRequests.length
  bridge.setDevices(() => { throw Error('relay_unavailable') })
  bridge.setHostRegistrationAvailable(false)
  assert.deepEqual(await bridge.call('portal-control', disable), ok)
  assert.equal(bridge.hubRequests.length, previousCalls, 'revocation never calls the Hub REST API')
  assert.equal(portal.socket.readyState, 3)
  assert.equal(active.join.socket.readyState, 3)
  assert.equal(pending.socket.readyState, 3)
  const reset = await bridge.sent('host', 2)
  assert.deepEqual(reset.frame, { type: 'host', token, fingerprint: reset.frame.fingerprint })
  finishStatus({ control_ready: true, devices: [] })
  const lateStatus = (await delayed).body
  assert.equal(lateStatus.portal_access_enabled, false, 'slow status reflects current local consent')
  assert.equal(lateStatus.control_ready, false, 'revocation succeeds without waiting for a replacement Hub registration')
  assert.equal((await assertStatus(bridge, true, false)).web_error, 'relay_unavailable')
  portal.socket.receive(incoming('S'.repeat(32)))
  await new Promise(setImmediate)
  assert.equal(bridge.wire.filter(({ frame }) => frame.type === 'join').length, 3, 'revoked control ignores new incoming frames')

  bridge.setHostRegistrationAvailable(true)
  assert.deepEqual(await bridge.call('portal-control', enable), ok)
  const next = await bridge.sent('host', 3)
  assert.equal(next.frame.portal_access, true)
  const secondary = await enter(bridge, next, 3, viewer)
  assert.deepEqual(await bridge.call('control', disable), ok)
  assert.equal(next.socket.readyState, 3)
  assert.equal(secondary.join.socket.readyState, 3)
  await assertStatus(bridge, false, false)
  assert.deepEqual(await bridge.call('control', enable), ok)
  const normalAgain = await bridge.sent('host', 4)
  assert.equal(Object.hasOwn(normalAgain.frame, 'portal_access'), false)
  await assertStatus(bridge, true, false)

  assert.deepEqual(await bridge.call('portal-control', enable), ok)
  const beforeRestart = await bridge.sent('host', 5)
  assert.equal(beforeRestart.frame.portal_access, true)
  bridge.restart()
  assert.equal(beforeRestart.socket.readyState, 3)
  await assertStatus(bridge, false, false)
  assert.equal(errorCode(await bridge.call('portal-control', enable)), 'remote_control_required')
})
