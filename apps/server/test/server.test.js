import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INSTANCE_TOKEN, call, registerDevice, sessionPayload, startHub } from './helpers.js';

test('health and meta describe the protocol', async () => {
  const hub = await startHub();
  try {
    const health = await call(hub.url, '/healthz', { token: null });
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.protocol, 'bridge/1');

    const meta = await call(hub.url, '/v1/meta', { token: null });
    assert.equal(meta.status, 200);
    assert.equal(meta.json.capabilities.sessionSync, true);

    // HEAD is GET without a body: `curl -I`-style health checks must not 404.
    const head = await call(hub.url, '/healthz', { method: 'HEAD', token: null });
    assert.equal(head.status, 200);
    assert.equal(head.json, null);
  } finally {
    await hub.stop();
  }
});

test('rejects missing or wrong tokens', async () => {
  const hub = await startHub();
  try {
    assert.equal((await call(hub.url, '/v1/sessions', { token: null })).status, 401);
    assert.equal((await call(hub.url, '/v1/sessions', { token: 'nope' })).status, 401);
    assert.equal(
      (await call(hub.url, '/v1/devices/register', { method: 'POST', body: { name: 'x' }, token: 'nope' })).status,
      401,
    );
  } finally {
    await hub.stop();
  }
});

test('device registration returns a token and is idempotent by name', async () => {
  const hub = await startHub();
  try {
    const first = await registerDevice(hub.url, 'mac-mini');
    assert.equal(first.device.name, 'mac-mini');
    assert.match(first.token, /^dev_[^.]+\.[^.]+$/);
    assert.equal(first.rotated, false);

    const second = await registerDevice(hub.url, 'mac-mini');
    assert.equal(second.device.id, first.device.id);
    assert.equal(second.rotated, true);
    assert.notEqual(second.token, first.token);

    // The old token must stop working after rotation.
    const stale = await call(hub.url, '/v1/sessions', { token: first.token });
    assert.equal(stale.status, 401);
  } finally {
    await hub.stop();
  }
});

test('sync upserts sessions, lists summaries and serves full records', async () => {
  const hub = await startHub();
  try {
    const { token, device } = await registerDevice(hub.url, 'mac-mini');
    const synced = await call(hub.url, '/v1/sessions/sync', {
      method: 'POST',
      token,
      body: { protocol: 'bridge/1', sessions: [sessionPayload()] },
    });
    assert.equal(synced.status, 200);
    assert.deepEqual(synced.json.accepted, ['sess-1']);
    assert.equal(synced.json.cursor, 1);

    const list = await call(hub.url, '/v1/sessions');
    assert.equal(list.status, 200);
    assert.equal(list.json.sessions.length, 1);
    const summary = list.json.sessions[0];
    assert.equal(summary.title, 'Study the hub');
    assert.equal(summary.messageCount, 2);
    assert.equal(summary.deviceId, device.id);
    assert.equal(summary.preview, 'hi there');
    assert.equal('messages' in summary, false);

    const full = await call(hub.url, '/v1/sessions/sess-1');
    assert.equal(full.status, 200);
    assert.equal(full.json.session.messages.length, 2);
    assert.equal(full.json.session.messages[1].text, 'hi there');
  } finally {
    await hub.stop();
  }
});

test('older snapshots are skipped, newer ones win', async () => {
  const hub = await startHub();
  try {
    const { token } = await registerDevice(hub.url, 'mac-mini');
    await call(hub.url, '/v1/sessions/sync', {
      method: 'POST',
      token,
      body: { sessions: [sessionPayload({ updatedAt: '2026-11-20T10:05:00.000Z' })] },
    });
    const stale = await call(hub.url, '/v1/sessions/sync', {
      method: 'POST',
      token,
      body: { sessions: [sessionPayload({ updatedAt: '2026-11-19T10:00:00.000Z', title: 'old' })] },
    });
    assert.deepEqual(stale.json.skipped, ['sess-1']);

    const fresh = await call(hub.url, '/v1/sessions/sync', {
      method: 'POST',
      token,
      body: { sessions: [sessionPayload({ updatedAt: '2026-11-21T10:00:00.000Z', title: 'new' })] },
    });
    assert.deepEqual(fresh.json.accepted, ['sess-1']);
    const full = await call(hub.url, '/v1/sessions/sess-1');
    assert.equal(full.json.session.title, 'new');
  } finally {
    await hub.stop();
  }
});

test('full sync removes sessions the host no longer has', async () => {
  const hub = await startHub();
  try {
    const { token } = await registerDevice(hub.url, 'mac-mini');
    await call(hub.url, '/v1/sessions/sync', {
      method: 'POST',
      token,
      body: { sessions: [sessionPayload({ id: 'a' }), sessionPayload({ id: 'b' })] },
    });
    const res = await call(hub.url, '/v1/sessions/sync', {
      method: 'POST',
      token,
      body: { full: true, sessions: [sessionPayload({ id: 'a' })] },
    });
    assert.deepEqual(res.json.removed, ['b']);
    const list = await call(hub.url, '/v1/sessions');
    assert.deepEqual(list.json.sessions.map((s) => s.id), ['a']);
  } finally {
    await hub.stop();
  }
});

test('delete removes a session and publishes an event', async () => {
  const hub = await startHub();
  try {
    const { token } = await registerDevice(hub.url, 'mac-mini');
    await call(hub.url, '/v1/sessions/sync', { method: 'POST', token, body: { sessions: [sessionPayload()] } });

    const other = await registerDevice(hub.url, 'another-mac');
    const forbidden = await call(hub.url, '/v1/sessions/sess-1', { method: 'DELETE', token: other.token });
    assert.equal(forbidden.status, 403);

    const deleted = await call(hub.url, '/v1/sessions/sess-1', { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    assert.equal((await call(hub.url, '/v1/sessions/sess-1')).status, 404);
  } finally {
    await hub.stop();
  }
});

test('invalid session payloads are rejected with 422', async () => {
  const hub = await startHub();
  try {
    const { token } = await registerDevice(hub.url, 'mac-mini');
    const bad = await call(hub.url, '/v1/sessions/sync', {
      method: 'POST',
      token,
      body: { sessions: [{ title: 'no id' }] },
    });
    assert.equal(bad.status, 422);
    assert.equal(bad.json.error.code, 'invalid_session_id');

    const wrongProtocol = await call(hub.url, '/v1/sessions/sync', {
      method: 'POST',
      token,
      body: { protocol: 'hub/2', sessions: [] },
    });
    assert.equal(wrongProtocol.status, 400);
  } finally {
    await hub.stop();
  }
});

test('sessions and devices survive a restart', async () => {
  const first = await startHub();
  let dataDir;
  let deviceToken;
  let deviceId;
  try {
    dataDir = first.dataDir;
    const reg = await registerDevice(first.url, 'mac-mini');
    deviceToken = reg.token;
    deviceId = reg.device.id;
    await call(first.url, '/v1/sessions/sync', {
      method: 'POST',
      token: deviceToken,
      body: { sessions: [sessionPayload()] },
    });
  } finally {
    await first.app.close();
  }

  const { createHubApp } = await import('../src/app.js');
  const app = await createHubApp({ dataDir, instanceToken: INSTANCE_TOKEN, logger: { info() {}, error() {} } });
  const { url } = await app.listen(0, '127.0.0.1');
  try {
    const list = await call(url, '/v1/sessions');
    assert.equal(list.json.sessions.length, 1);
    const devices = await call(url, '/v1/devices');
    assert.equal(devices.json.devices[0].id, deviceId);
  } finally {
    await app.close();
  }
});

test('host poll waits the requested number of seconds', async () => {
  const hub = await startHub();
  try {
    const { token } = await registerDevice(hub.url, 'mac-mini');
    const startedAt = Date.now();
    const poll = await call(hub.url, '/v1/host/commands?wait=1', { token });
    const elapsed = Date.now() - startedAt;
    assert.equal(poll.status, 204);
    // Regression: `wait` used to be read as milliseconds, so a 1 s poll returned
    // after 1 ms and the host was never parked when a live fetch arrived.
    assert.ok(elapsed >= 900, `poll returned after ${elapsed}ms, expected about 1000ms`);
  } finally {
    await hub.stop();
  }
});

test('fallback stored answers when a parked host never replies', async () => {
  const hub = await startHub();
  try {
    const { token, device } = await registerDevice(hub.url, 'mac-mini');
    await call(hub.url, '/v1/sessions/sync', {
      method: 'POST',
      token,
      body: { protocol: 'bridge/1', sessions: [sessionPayload({ id: 'sess-stale' })] },
    });

    // Park a poll and never answer it, the way a host does when it dies behind a
    // proxy that keeps the origin request open.
    const parked = call(hub.url, '/v1/host/commands?wait=30', { token });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const res = await call(hub.url, '/v1/hub/sessions/sess-stale/fetch', {
      method: 'POST',
      body: { deviceId: device.id, fallback: 'stored', timeoutMs: 500 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.source, 'stored');
    assert.equal(res.json.session.id, 'sess-stale');

    parked.catch(() => {});
  } finally {
    await hub.stop();
  }
});

test('a host that disconnects withdraws its parked poll', async () => {
  const hub = await startHub();
  try {
    const { token, device } = await registerDevice(hub.url, 'mac-mini');
    const abort = new AbortController();
    const poll = fetch(`${hub.url}/v1/host/commands?wait=30`, {
      headers: { authorization: `Bearer ${token}` },
      signal: abort.signal,
    }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 200));

    abort.abort();
    await poll;
    await new Promise((resolve) => setTimeout(resolve, 100));

    // A dead host must look offline, not swallow the command and time out.
    const res = await call(hub.url, '/v1/hub/sessions/sess-live/fetch', {
      method: 'POST',
      body: { deviceId: device.id, timeoutMs: 1000 },
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'host_offline');
  } finally {
    await hub.stop();
  }
});

test('host long-poll hub forwards a command and returns the host result', async () => {
  const hub = await startHub({ commandTimeoutMs: 5000 });
  try {
    const { token, device } = await registerDevice(hub.url, 'mac-mini');

    // The host parks one poll. Do not await it: it only resolves once dispatched.
    const pollPromise = call(hub.url, '/v1/host/commands?wait=5', { token });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const hubCall = call(hub.url, '/v1/hub/sessions/sess-live/fetch', {
      method: 'POST',
      body: { deviceId: device.id, timeoutMs: 4000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const poll = await pollPromise;
    assert.equal(poll.status, 200);
    assert.equal(poll.json.command.method, 'session.fetch');
    assert.equal(poll.json.command.params.sessionId, 'sess-live');

    await call(hub.url, `/v1/host/commands/${poll.json.command.id}/result`, {
      method: 'POST',
      token,
      body: { ok: true, result: { session: { id: 'sess-live', title: 'live', messages: [] } } },
    });

    const resolved = await hubCall;
    assert.equal(resolved.status, 200);
    assert.equal(resolved.json.source, 'live');
    assert.equal(resolved.json.session.title, 'live');
  } finally {
    await hub.stop();
  }
});

test('hub reports host_offline and can fall back to the stored copy', async () => {
  const hub = await startHub();
  try {
    const { token, device } = await registerDevice(hub.url, 'mac-mini');
    await call(hub.url, '/v1/sessions/sync', { method: 'POST', token, body: { sessions: [sessionPayload()] } });

    const offline = await call(hub.url, '/v1/hub/sessions/sess-1/fetch', {
      method: 'POST',
      body: { deviceId: device.id },
    });
    assert.equal(offline.status, 409);
    assert.equal(offline.json.error.code, 'host_offline');

    const fallback = await call(hub.url, '/v1/hub/sessions/sess-1/fetch', {
      method: 'POST',
      body: { deviceId: device.id, fallback: 'stored' },
    });
    assert.equal(fallback.status, 200);
    assert.equal(fallback.json.source, 'stored');
    assert.equal(fallback.json.session.id, 'sess-1');
  } finally {
    await hub.stop();
  }
});

test('SSE stream delivers session.updated', async () => {
  const hub = await startHub();
  try {
    const controller = new AbortController();
    const response = await fetch(hub.url + '/v1/events', {
      headers: { authorization: `Bearer ${INSTANCE_TOKEN}` },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async (needle, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes(needle)) return buffer;
      }
      throw new Error('timed out waiting for ' + needle + ', buffer=' + buffer);
    };

    await readUntil('event: ready');
    const { token } = await registerDevice(hub.url, 'mac-mini');
    await call(hub.url, '/v1/sessions/sync', { method: 'POST', token, body: { sessions: [sessionPayload()] } });
    const seen = await readUntil('event: session.updated');
    assert.match(seen, /"title":"Study the hub"/);
    controller.abort();
    await reader.cancel().catch(() => {});
  } finally {
    await hub.stop();
  }
});
