# dsh-bridge

Hub-mediated **session sync** for DeepSeek Harness (DSH). A Mac reads its local
sessions and pushes them to a hub you control; other devices read from the hub,
or ask it to fetch the live version from the Mac.

The native clients still synchronize sessions only, not terminals, files,
model settings or chat. The Cross-device plugin can also list paired devices and
open the original DSH Web running on a device in a new tab.

```
Mac (dsh-bridge)  ──push──►  hub server  ◄──list/read──  other clients
       ▲                        │
       └──── long-poll ─────────┘   live fetch while online, stored copy while offline
```

## Why this shape

Two mature implementations were used as references:

- [ds-harness-remote](https://github.com/liguobao/ds-harness-remote): WebSocket
  control plane, blind hub, Noise end-to-end encryption; the server never stores
  session content. Complete, but large.
- [dsh-mobile-plugin](https://github.com/WNLUO/dsh-mobile-plugin): host dials out
  over WSS with a binary frame codec and QR pairing.

This project keeps their core shape — **host dials outward, device identity on
every request, monotonic server revision, explicit live vs stored distinction** —
but swaps in plain HTTP with a long-poll and actually persists the snapshot:

- no public IP, inbound port, or certificate on the Mac;
- clients still see the last snapshot while the Mac is asleep;
- about 2.2k lines of implementation (900 server, 1.3k Mac), no build chain (zero-dependency server, one SwiftPM package).

The cost: the hub holds plaintext sessions, single-tenant, no E2E — see
[docs/SECURITY.md](docs/SECURITY.md).

## Quickstart

Requirements: macOS 13+, Node ≥ 22.5, Xcode command line tools, `zstd`
(`brew install zstd`).

```bash
git clone https://github.com/4dmoonlight/dsh-bridge.git
cd dsh-bridge
./install.sh all
```

The installer generates a hub token, starts the hub (LaunchAgent, port 8787),
builds and installs `dsh-bridge` to `~/.local/bin`, registers this Mac, and starts
the host loop (second LaunchAgent).

Verify:

```bash
~/.local/bin/dsh-bridge doctor
~/.local/bin/dsh-bridge push --limit 50
~/.local/bin/dsh-bridge list
```

GUI: `~/.local/bin/dsh-bridge ui`.

## Open remote DSH in the browser

Update the Hub and the plugin on both computers, then sign into Cross-device
with the same Google account. Turn on remote control on the target: it is off
by default. Click the target device to open its DSH Web, with its own plugins,
sidebar and sessions. There is no per-device HTTPS address, Web pairing code,
or desktop mirror. See [Google sign-in and Web setup](docs/WEB-ACCESS.md).

## Commands

| Command | Purpose |
| --- | --- |
| `register --hub URL --token T` | register this Mac, store a device token |
| `push [--limit N] [--full]` | read `~/.dsh/sessions` and upload |
| `serve` | host mode: periodic push + answer live hub fetches |
| `list [--query Q]` | list sessions on the hub |
| `show <id>` | print one session |
| `ui` | SwiftUI window |
| `doctor` | check sessions dir, zstd, config, hub health |
| `config` | print config (tokens masked) |

## Hub

Zero dependencies:

```bash
BRIDGE_PORT=8787 BRIDGE_DATA_DIR=~/.dsh-bridge/hub-data \
  node apps/server/src/index.js
```

For remote deployments always put it behind TLS (Caddy, nginx, Cloudflare Tunnel).
See [docs/INSTALL.md](docs/INSTALL.md).

## Docs

- [docs/PROTOCOL.md](docs/PROTOCOL.md) — `bridge/1`, all endpoints and error codes
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — data paths and trade-offs
- [docs/INSTALL.md](docs/INSTALL.md) — install and troubleshooting
- [docs/SECURITY.md](docs/SECURITY.md) — threat model and limits
- [AGENTS.md](AGENTS.md) — install/verify playbook for coding agents

## Tests

```bash
(cd apps/server && npm test)   # Hub auth, pairing, sync and forwarding
node --test packages/dsh-cross-device/test/*.test.js  # device panel
(cd apps/macos && swift test)  # models, config, DSH v4 parsing
bash scripts/e2e.sh           # native client live and stored paths
node scripts/e2e-web.mjs      # requires the dsh CLI; two local profiles, simulated Google and relay
```

## Limits

- Legacy session sync does not transfer terminals, files, attachments or model
  settings. Remote DSH Web uses the capabilities DSH provides; Web traffic
  goes through the Hub encrypted.
- Session sync is single-tenant: every valid sync token reads every stored
  session. Web-device credentials do not grant this access.
- Session-sync snapshots are stored in plaintext (2000 messages
  per session, 20k chars per message).
- Single-process storage (atomic JSON replace); never share a data dir between
  instances.
- The macOS host and iOS client continue to use the session-sync protocol;
  Web pairing uses separate authorization.

## License

MIT
