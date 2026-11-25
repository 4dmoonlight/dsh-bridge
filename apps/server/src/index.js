#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHubApp } from './app.js';
import { openDatabase } from './db.js';

const args = parseArgs(process.argv.slice(2));
const dataDir = resolve(args['data-dir'] ?? process.env.BRIDGE_DATA_DIR ?? join(homedir(), '.dsh-bridge'));
const host = args.host ?? process.env.BRIDGE_HOST ?? '127.0.0.1';
const port = Number(args.port ?? process.env.BRIDGE_PORT ?? 8787);
const token = await resolveToken(dataDir, process.env.BRIDGE_TOKEN ?? args.token);

// Open bridge.sqlite before listening so a broken schema/database fails at
// startup instead of on the first cross-device request. The app attaches the
// /api/v1/ws 'upgrade' handler when it creates the HTTP server.
const db = openDatabase({ dataDir });
const app = await createHubApp({ dataDir, instanceToken: token, db });
const { port: actualPort, url } = await app.listen(port, host);

console.log(
  JSON.stringify({
    event: 'listening',
    url,
    host,
    port: actualPort,
    dataDir,
    database: db.file,
    protocol: app.version,
    tokenSource: process.env.BRIDGE_TOKEN || args.token ? 'env' : 'file',
  }),
);
// Never print the token: stdout goes to journald/supervisors. It is already in
// BRIDGE_TOKEN or the 0600 data-dir token file; use `dsh-bridge doctor` to check it.
if (!process.env.BRIDGE_TOKEN && !args.token) {
  console.log(`hub token file: ${join(dataDir, 'instance-token')}`);
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
