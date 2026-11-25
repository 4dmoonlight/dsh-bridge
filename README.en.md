# dsh-bridge

Hub-mediated **session sync** for DeepSeek Harness (DSH). A Mac reads its local
sessions and pushes them to a hub you control; other devices read from the hub,
or ask it to fetch the live version from the Mac.

This first release is macOS-only and **session sync only** — no terminals, files,
attachments, or chat forwarding.

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
BRIDGE_TOKEN=secret BRIDGE_PORT=8787 BRIDGE_DATA_DIR=~/.dsh-bridge/hub-data \
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
cd apps/server && npm test          # 12 cases: auth, sync, stale skip, restart, live hub, SSE
cd apps/macos && swift test    # models, config, DSH v4 parsing
bash scripts/e2e.sh            # real hub + real binary, live and stored paths
```

## Limits

- Sessions only: no terminals, files, attachments, or model configuration.
- Single tenant: every valid token reads every stored session.
- No end-to-end encryption; the hub stores plaintext snapshots (2000 messages
  per session, 20k chars per message).
- Single-process storage (atomic JSON replace); never share a data dir between
  instances.
- macOS host only; iOS/web clients are not implemented yet (the protocol is ready).

## License

MIT
