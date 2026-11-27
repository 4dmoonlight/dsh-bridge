import { execFile } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Duplex } from 'node:stream'
import { connect as connectTls, createSecureContext, TLSSocket } from 'node:tls'
import { promisify } from 'node:util'

const ROUTE = '/api/v1/web/relay'
const CHUNK = 32768
const TIMEOUT_MS = 12000
const CONTROL_TIMEOUT_MS = 12000
const FRAME_TYPES = new Set(['data', 'ack', 'end'])
const CLOSED = 3
const OPEN = 1

export function relayError(code, status = 502) {
  return Object.assign(new Error(code), { status })
}

function socketUrl(hub) {
  const url = new URL(hub)
  if (hub !== url.origin || url.username || url.password || url.search || url.hash) throw relayError('invalid_hub_url', 400)
  if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  else throw relayError('invalid_hub_url', 400)
  url.pathname = ROUTE
  return url
}

function parseFrame(input) {
  if (typeof input !== 'string' || input.length > 44000) throw relayError('relay_protocol_error')
  const body = JSON.parse(input)
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.type !== 'string') {
    throw relayError('relay_protocol_error')
  }
  return body
}

function closeSocket(socket) {
  if (socket.readyState !== CLOSED) {
    try { socket.close() } catch { /* state changed concurrently */ }
  }
}

function openRelay(hub, frame, expected, { signal, onFrame, onClose }) {
  if (typeof WebSocket !== 'function') throw relayError('relay_not_supported', 503)
  if (signal?.aborted) return Promise.reject(relayError('relay_closed'))
  const ws = new WebSocket(socketUrl(hub))
  return new Promise((resolve, reject) => {
    let established = false
    let done = false
    const timer = setTimeout(() => close(relayError('relay_timeout', 504)), CONTROL_TIMEOUT_MS)
    timer.unref?.()
    const abort = () => close(relayError('relay_closed'))
    const failed = () => close(relayError('relay_unavailable'))
    function close(err) {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      closeSocket(ws)
      if (established) onClose?.(err)
      else reject(err)
    }
    signal?.addEventListener('abort', abort, { once: true })
    // Native WebSocket doesn't use custom request headers on all supported Node versions.
    // Device credentials are used only as a first WSS message, never as URL parameters.
    ws.addEventListener('open', () => {
      if (done) return
      try { ws.send(JSON.stringify(frame)) } catch { failed() }
    }, { once: true })
    ws.addEventListener('close', event => {
      if (event.reason === 'host_replaced') close(relayError('host_replaced', 409))
      else failed()
    }, { once: true })
    ws.addEventListener('error', failed, { once: true })
    ws.addEventListener('message', event => {
      if (done) return
      try {
        const value = parseFrame(event.data)
        if (!established) {
          if (value.type !== expected) throw relayError('relay_rejected', 403)
          clearTimeout(timer)
          established = true
          resolve(ws)
        } else onFrame(value, ws)
      } catch { close(relayError('relay_protocol_error')) }
    })
  })
}

export function registerRelayHost(hub, token, fingerprint, { portalAccess, ...callbacks }) {
  const frame = { type: 'host', token, fingerprint }
  // An explicit false would break legacy Hubs' exact normal-mode frame shape.
  if (portalAccess === true) frame.portal_access = true
  return openRelay(hub, frame, 'ready', callbacks)
}

// Wrap one independent WSS stream as a bounded duplex transport for node:tls.
// Each direction must receive an acknowledgement before sending another chunk.
class RelayStream extends Duplex {
  constructor(ws) {
    super({ readableHighWaterMark: CHUNK * 2, writableHighWaterMark: CHUNK * 2 })
    this.ws = ws
    this.writeState = null
    this.receivePending = false
    this.remoteEnded = false
    this.on('error', () => {})
  }

  send(message) {
    if (this.ws.readyState !== OPEN) throw relayError('relay_closed')
    this.ws.send(JSON.stringify(message))
  }

  receive(message) {
    if (this.destroyed) return
    try {
      if (!FRAME_TYPES.has(message.type)) throw relayError('relay_protocol_error')
      if (message.type === 'ack') {
        const state = this.writeState
        if (!state) throw relayError('relay_protocol_error')
        if (state.offset >= state.bytes.length) {
          this.writeState = null
          state.complete()
        } else this.sendChunk()
        return
      }
      if (this.remoteEnded || this.receivePending) throw relayError('relay_protocol_error')
      if (message.type === 'end') {
        this.remoteEnded = true
        this.push(null)
        return
      }
      const bytes = typeof message.data === 'string' && Buffer.from(message.data, 'base64')
      if (!bytes || bytes.length === 0 || bytes.length > CHUNK || bytes.toString('base64') !== message.data) {
        throw relayError('relay_protocol_error')
      }
      if (this.push(bytes)) this.send({ type: 'ack' })
      else this.receivePending = true
    } catch (err) { this.destroy(err) }
  }

  _read() {
    if (this.receivePending) {
      this.receivePending = false
      try { this.send({ type: 'ack' }) } catch (err) { this.destroy(err) }
    }
  }

  sendChunk() {
    const state = this.writeState
    const part = state.bytes.subarray(state.offset, state.offset + CHUNK)
    state.offset += part.length
    this.send({ type: 'data', data: part.toString('base64') })
  }

  _write(bytes, encoding, complete) {
    if (bytes.length === 0) return complete()
    this.writeState = { bytes, offset: 0, complete }
    try { this.sendChunk() } catch (err) {
      this.writeState = null
      complete(err)
    }
  }

  _final(complete) {
    try { this.send({ type: 'end' }); complete() } catch (err) { complete(err) }
  }

  _destroy(err, complete) {
    closeSocket(this.ws)
    const write = this.writeState
    this.writeState = null
    write?.complete(err ?? relayError('relay_closed'))
    complete(err)
  }
}

export async function connectRelayStream(hub, frame, signal) {
  let stream
  const ws = await openRelay(hub, frame, 'connected', {
    signal,
    onFrame(value) { stream?.receive(value) },
    onClose() { stream?.destroy() },
  })
  if (signal?.aborted) throw relayError('relay_closed')
  stream = new RelayStream(ws)
  return stream
}

export async function createRelayCertificate() {
  const root = await realpath(tmpdir())
  const dir = await realpath(await mkdtemp(join(root, 'dsh-relay-tls-')))
  if (dirname(dir) !== root || !basename(dir).startsWith('dsh-relay-tls-')) throw relayError('relay_certificate_error')
  try {
    // macOS ships /usr/bin/openssl. Exact argv and an isolated 0700 directory prevent
    // command injection or the private key being written into the workspace.
    const keyFile = join(dir, 'key.pem')
    const certFile = join(dir, 'cert.pem')
    await promisify(execFile)('/usr/bin/openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '365',
      '-subj', '/CN=dsh-device-relay', '-keyout', keyFile, '-out', certFile,
    ], { timeout: 8000, maxBuffer: 64 * 1024 })
    const [key, cert] = await Promise.all([readFile(keyFile), readFile(certFile)])
    const fingerprint = createHash('sha256').update(new X509Certificate(cert).raw).digest('hex')
    return { fingerprint, context: createSecureContext({ key, cert, minVersion: 'TLSv1.3' }) }
  } catch {
    throw relayError('relay_certificate_error', 503)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function waitForTls(socket, stream, event, check) {
  return new Promise((resolve, reject) => {
    // This handler deliberately layers on a transport, not on a remote TCP origin.
    const timer = setTimeout(() => fail(relayError('relay_tls_timeout', 504)), TIMEOUT_MS)
    timer.unref?.()
    let done = false
    function cleanup() {
      clearTimeout(timer)
      socket.off(event, ready)
      socket.off('error', fail)
      socket.off('close', closed)
      stream.off('close', closed)
    }
    function fail(err) {
      if (done) return
      done = true
      cleanup()
      socket.destroy()
      stream.destroy()
      reject(err)
    }
    function closed() { fail(relayError('relay_closed')) }
    function ready() {
      try { check?.() } catch (err) { fail(err); return }
      done = true
      cleanup()
      resolve(socket)
    }
    socket.on('error', () => {})
    socket.once('error', fail)
    socket.once('close', closed)
    stream.once('close', closed)
    socket.once(event, ready)
    socket.once('close', () => stream.destroy())
    stream.once('close', () => socket.destroy())
    if (stream.destroyed || socket.destroyed) closed()
  })
}

export function relayServerTls(stream, certificate) {
  const socket = new TLSSocket(stream, { isServer: true, secureContext: certificate.context, minVersion: 'TLSv1.3' })
  return waitForTls(socket, stream, 'secure')
}

export function relayClientTls(stream, fingerprint) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    stream.destroy()
    return Promise.reject(relayError('relay_bad_certificate', 403))
  }
  // This is a freshly generated self-signed device cert. No application data is
  // written or exposed until the exact certificate supplied by the Hub matches.
  const socket = connectTls({ socket: stream, rejectUnauthorized: false, minVersion: 'TLSv1.3' })
  return waitForTls(socket, stream, 'secureConnect', () => {
    const raw = socket.getPeerCertificate()?.raw
    if (!raw || createHash('sha256').update(raw).digest('hex') !== fingerprint) throw relayError('relay_bad_certificate', 403)
    const certificate = new X509Certificate(raw)
    if (Date.now() < Date.parse(certificate.validFrom) - 300000 || Date.now() >= Date.parse(certificate.validTo)) {
      throw relayError('relay_bad_certificate', 403)
    }
  })
}
