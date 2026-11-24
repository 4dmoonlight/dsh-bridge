import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelayApp } from '../src/app.js';

export const INSTANCE_TOKEN = 'test-instance-token';

export async function startRelay(overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-test-'));
  const app = await createRelayApp({ dataDir, instanceToken: INSTANCE_TOKEN, logger: { info() {}, error() {} }, ...overrides });
  const { url } = await app.listen(0, '127.0.0.1');
  return {
    app,
    url,
    dataDir,
    async stop() {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export async function call(url, path, { method = 'GET', token = INSTANCE_TOKEN, body, headers = {} } = {}) {
  const response = await fetch(url + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, json, headers: response.headers };
}

export async function registerDevice(url, name, platform = 'darwin') {
  const res = await call(url, '/v1/devices/register', { method: 'POST', body: { name, platform } });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

export function sessionPayload(overrides = {}) {
  return {
    id: 'sess-1',
    title: 'Study the relay',
    workspace: '/Users/me/Dev',
    engine: 'dsh',
    createdAt: '2026-11-20T10:00:00.000Z',
    updatedAt: '2026-11-20T10:05:00.000Z',
    messages: [
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi there' },
    ],
    ...overrides,
  };
}
