# dsh-relay-sync

Relay-mediated **session sync** for DeepSeek Harness (DSH). A Mac reads its local
sessions and pushes them to a relay you control; other devices read from the relay,
or ask it to fetch the live version from the Mac.

This first release is macOS-only and **session sync only** — no terminals, files,
attachments, or chat forwarding.

```
Mac (relay-sync)  ──push──►  relay server  ◄──list/read──  other clients
       ▲                        │
       └──── long-poll ─────────┘   live fetch while online, stored copy while offline
```

## Why this shape

Two mature implementations were used as references:

- [ds-harness-remote](https://github.com/liguobao/ds-harness-remote): WebSocket
  control plane, blind relay, Noise end-to-end encryption; the server never stores
  session content. Complete, but large.
- [dsh-mobile-plugin](https://github.com/WNLUO/dsh-mobile-plugin): host dials out
  over WSS with a binary frame codec and QR pairing.

This project keeps their core shape — **host dials outward, device identity on
every request, monotonic server revision, explicit live vs stored distinction** —
but swaps in plain HTTP with a long-poll and actually persists the snapshot:

- no public IP, inbound port, or certificate on the Mac;
- clients still see the last snapshot while the Mac is asleep;
- about 2.2k lines of implementation (900 server, 1.3k Mac), no build chain (zero-dependency server, one SwiftPM package).

The cost: the relay holds plaintext sessions, single-tenant, no E2E — see
[docs/SECURITY.md](docs/SECURITY.md).

## Quickstart

Requirements: macOS 13+, Node ≥ 22.5, Xcode command line tools, `zstd`
(`brew install zstd`).

```bash
git clone https://github.com/4dmoonlight/dsh-relay-sync.git
cd dsh-relay-sync
./install.sh all
```

The installer generates a relay token, starts the relay (LaunchAgent, port 8787),
builds and installs `relay-sync` to `~/.local/bin`, registers this Mac, and starts
the host loop (second LaunchAgent).

Verify:

```bash
~/.local/bin/relay-sync doctor
~/.local/bin/relay-sync push --limit 50
~/.local/bin/relay-sync list
```

GUI: `~/.local/bin/relay-sync ui`.

## Commands

| Command | Purpose |
| --- | --- |
| `register --relay URL --token T` | register this Mac, store a device token |
| `push [--limit N] [--full]` | read `~/.dsh/sessions` and upload |
| `serve` | host mode: periodic push + answer live relay fetches |
| `list [--query Q]` | list sessions on the relay |
| `show <id>` | print one session |
| `ui` | SwiftUI window |
| `doctor` | check sessions dir, zstd, config, relay health |
| `config` | print config (tokens masked) |

## Relay

Zero dependencies:

```bash
RELAY_TOKEN=secret RELAY_PORT=8787 RELAY_DATA_DIR=~/.dsh-relay-sync/relay-data \
  node apps/server/src/index.js
```

For remote deployments always put it behind TLS (Caddy, nginx, Cloudflare Tunnel).
See [docs/INSTALL.md](docs/INSTALL.md).

## Docs

- [docs/PROTOCOL.md](docs/PROTOCOL.md) — `relay/1`, all endpoints and error codes
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — data paths and trade-offs
- [docs/INSTALL.md](docs/INSTALL.md) — install and troubleshooting
- [docs/SECURITY.md](docs/SECURITY.md) — threat model and limits
- [AGENTS.md](AGENTS.md) — install/verify playbook for coding agents

## Tests

```bash
cd apps/server && npm test          # 12 cases: auth, sync, stale skip, restart, live relay, SSE
cd apps/macos && swift test    # models, config, DSH v4 parsing
bash scripts/e2e.sh            # real relay + real binary, live and stored paths
```

## Limits

- Sessions only: no terminals, files, attachments, or model configuration.
- Single tenant: every valid token reads every stored session.
- No end-to-end encryption; the relay stores plaintext snapshots (2000 messages
  per session, 20k chars per message).
- Single-process storage (atomic JSON replace); never share a data dir between
  instances.
- macOS host only; iOS/web clients are not implemented yet (the protocol is ready).

## License

MIT
