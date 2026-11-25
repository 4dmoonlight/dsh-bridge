# AGENTS.md

Instructions for coding agents that need to install, run, or extend
`dsh-bridge`. Read this before touching the repository.

## What it is

Hub-mediated **session sync** for DeepSeek Harness on macOS:

- `apps/server/` — zero-dependency Node hub: session store, live command hub,
  SQLite-backed cross-device API and a hand-written WebSocket.
- `packages/dsh-cross-device/` — DSH plugin that publishes this machine's sessions
  and renders other machines' sessions in the sidebar.
- `apps/macos/` — Swift package: `dsh-bridge` CLI + SwiftUI window.
  Reads local DSH sessions (`~/.dsh/sessions`) and pushes/answers over HTTP.
- scope: **session sync only**. No chat, no terminals, no file transfer, no E2E.

## Non-interactive install (copy-paste)

The repo is public: plain `git clone` works. If you fork it privately, pass a
read token to the deploy script (`--github-token`).

Local machine, everything at once:

```bash
git clone https://github.com/4dmoonlight/dsh-bridge.git
cd dsh-bridge
./install.sh all --yes
```

Remote hub already running at `$HUB` with token `$TOKEN`:

```bash
git clone https://github.com/4dmoonlight/dsh-bridge.git
cd dsh-bridge
./install.sh mac --hub "$HUB" --token "$TOKEN" --yes
```

Sandboxed CI (nested sandbox blocks SwiftPM): prefix with
`DSH_BRIDGE_SWIFTPM_SANDBOX=disable`.

Installer side effects, in order: writes `~/.dsh-bridge/hub.env` (0600),
optionally a LaunchAgent, `swift build -c release`, copies the binary to
`~/.local/bin/dsh-bridge`, registers the device, writes
`~/.dsh-bridge/macos.json` (0600), optionally a second LaunchAgent.
Use `--no-agent` to avoid launchd, `--dry-run` to print without acting,
`--state-dir`/`--prefix` to relocate state.

## Verify (must pass before claiming success)

```bash
~/.local/bin/dsh-bridge doctor            # sessions dir, zstd, config, hub
~/.local/bin/dsh-bridge push --limit 2    # scan + upload
~/.local/bin/dsh-bridge list              # reads back what the hub stored
bash scripts/e2e.sh                       # server + Mac, live hub + fallback
```

Expected `doctor` output is four `ok` lines. `list` must show the same session ids
that `push` reported as scanned.

## Failure playbook

| Symptom | Action |
| --- | --- |
| `swift build` → `sandbox_apply: Operation not permitted` | set `DSH_BRIDGE_SWIFTPM_SANDBOX=disable` |
| `EADDRINUSE` | pick `--port`; check `launchctl list | grep dsh-bridge` |
| `401 unauthorized` | token in `hub.env` ≠ token used by the client |
| `409 host_offline` | start `dsh-bridge serve`; the host poll is what makes the device live |
| empty list | run `push` first; `serve` pushes at start and every 30 s |
| `zstd` missing | `brew install zstd` (only for `.zstd` session files) |

Never hand-edit `hub-store.json`; restart the hub and re-push instead.

## Repository map

```
apps/server/src/app.js      routes + auth + error mapping
apps/server/src/api-v1.js   /api/v1 cross-device API + pairing codes
apps/server/src/db.js       SQLite schema (devices/sessions/messages/pairing_codes)
apps/server/src/ws.js       hand-written RFC6455 server, 30s ping keepalive
apps/server/src/store.js    JSON store, atomic writes, revision counter
apps/server/src/hub.js    long-poll command hub, timeouts
apps/server/src/events.js   SSE hub
apps/server/src/model.js    session validation/normalization
apps/server/test/*.test.js  node:test suite (12 tests)
apps/macos/Sources/BridgeSyncKit/   models, client, DSHReader, SyncEngine, config
apps/macos/Sources/BridgeSyncCLI/   main.swift (CLI) + UI.swift (SwiftUI)
apps/macos/Tests/                  XCTest suite
packages/dsh-cross-device/         the plugin (lib/, cordis.patch.yml, scripts/install.sh)
scripts/e2e.sh                     cross-component proof
docs/PROTOCOL.md                   wire contract (bridge/1)
docs/ARCHITECTURE.md               data paths + comparison with references
```

## Development commands

```bash
cd apps/server && npm test                      # no install step, no dependencies
cd apps/macos && swift build && swift test
bash scripts/e2e.sh                        # needs node + swift + zstd
```

## Rules for changes

- Keep the server dependency-free (`node:` builtins only). CI runs on Node 24.
- `bridge/1` is versioned: additive fields are fine; renaming or removing a field
  or endpoint requires a new protocol version and a doc update in `docs/PROTOCOL.md`.
- Any change to on-disk behaviour must stay crash-safe: write temp file, then
  rename; never write `hub-store.json` directly.
- The Mac must never require an inbound port. If a feature needs push, extend the
  host poll, do not add a server→Mac connection.
- Update `docs/` in the same commit as behaviour; `README.md` and `README.en.md`
  must stay in sync.
