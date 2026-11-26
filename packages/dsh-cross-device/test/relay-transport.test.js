import assert from 'node:assert/strict'
import { once } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'
import { test } from 'node:test'
import { createRelayCertificate, relayClientTls, relayServerTls } from '../lib/relay-transport.js'

function link() {
  const left = new PassThrough()
  const right = new PassThrough()
  const chunks = []
  left.on('data', chunk => chunks.push(Buffer.from(chunk)))
  right.on('data', chunk => chunks.push(Buffer.from(chunk)))
  return { viewer: Duplex.from({ readable: left, writable: right }), host: Duplex.from({ readable: right, writable: left }), chunks }
}

test('device-to-device TLS authenticates a target cert and keeps plaintext out of the carrier', async () => {
  const certificate = await createRelayCertificate()
  const { viewer, host, chunks } = link()
  const [client, server] = await Promise.all([relayClientTls(viewer, certificate.fingerprint), relayServerTls(host, certificate)])
  try {
    assert.equal(client.getProtocol(), 'TLSv1.3')
    const received = once(server, 'data')
    const sensitive = 'fixture application payload should not reach relay in plaintext'
    client.write(sensitive)
    assert.equal((await received)[0].toString(), sensitive)
    assert.equal(Buffer.concat(chunks).includes(sensitive), false)
  } finally {
    client.destroy()
    server.destroy()
  }
})

test('a different target TLS certificate fails closed before application traffic', async () => {
  const certificate = await createRelayCertificate()
  const { viewer, host } = link()
  const result = relayServerTls(host, certificate).then(socket => { socket.destroy() }, () => {})
  await assert.rejects(relayClientTls(viewer, '0'.repeat(64)), { message: 'relay_bad_certificate' })
  await result
})
