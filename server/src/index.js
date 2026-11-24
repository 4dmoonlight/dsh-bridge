#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRelayApp } from './app.js';

const args = parseArgs(process.argv.slice(2));
const dataDir = resolve(args['data-dir'] ?? process.env.RELAY_DATA_DIR ?? join(homedir(), '.dsh-relay-sync'));
const host = args.host ?? process.env.RELAY_HOST ?? '127.0.0.1';
const port = Number(args.port ?? process.env.RELAY_PORT ?? 8787);
const token = await resolveToken(dataDir, process.env.RELAY_TOKEN ?? args.token);

const app = await createRelayApp({ dataDir, instanceToken: token });
const { port: actualPort, url } = await app.listen(port, host);

console.log(
  JSON.stringify({
    event: 'listening',
    url,
    host,
    port: actualPort,
    dataDir,
    protocol: app.version,
    tokenSource: process.env.RELAY_TOKEN || args.token ? 'env' : 'file',
  }),
);
// Never print the token: stdout goes to journald/supervisors. It is already in
// RELAY_TOKEN or the 0600 data-dir token file; use `relay-sync doctor` to check it.
if (!process.env.RELAY_TOKEN && !args.token) {
  console.log(`relay token file: ${join(dataDir, 'instance-token')}`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

async function resolveToken(dir, provided) {
  if (provided && String(provided).trim()) return String(provided).trim();
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'instance-token');
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (existing) return existing;
  } catch {
    /* not created yet */
  }
  const generated = randomBytes(32).toString('base64url');
  await writeFile(file, generated + '\n', { mode: 0o600 });
  return generated;
}

function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}
