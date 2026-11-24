# AGENTS.md

Instructions for coding agents that need to install, run, or extend
`dsh-relay-sync`. Read this before touching the repository.

## What it is

Relay-mediated **session sync** for DeepSeek Harness on macOS:

- `server/` — zero-dependency Node relay: session store + live command relay.
- `apps/macos/` — Swift package: `relay-sync` CLI + SwiftUI window.
  Reads local DSH sessions (`~/.dsh/sessions`) and pushes/answers over HTTP.
- scope: **session sync only**. No chat, no terminals, no file transfer, no E2E.

## Non-interactive install (copy-paste)

Local machine, everything at once:

```bash
git clone https://github.com/OWNER/dsh-relay-sync.git
cd dsh-relay-sync
./install.sh all --yes
```

Remote relay already running at `$RELAY` with token `$TOKEN`:

```bash
git clone https://github.com/OWNER/dsh-relay-sync.git
cd dsh-relay-sync
./install.sh mac --relay "$RELAY" --token "$TOKEN" --yes
```

Sandboxed CI (nested sandbox blocks SwiftPM): prefix with
`DSH_RELAY_SWIFTPM_SANDBOX=disable`.

Installer side effects, in order: writes `~/.dsh-relay-sync/relay.env` (0600),
optionally a LaunchAgent, `swift build -c release`, copies the binary to
`~/.local/bin/relay-sync`, registers the device, writes
`~/.dsh-relay-sync/macos.json` (0600), optionally a second LaunchAgent.
Use `--no-agent` to avoid launchd, `--dry-run` to print without acting,
`--state-dir`/`--prefix` to relocate state.

## Verify (must pass before claiming success)

```bash
~/.local/bin/relay-sync doctor            # sessions dir, zstd, config, relay
~/.local/bin/relay-sync push --limit 2    # scan + upload
~/.local/bin/relay-sync list              # reads back what the relay stored
bash scripts/e2e.sh                       # server + Mac, live relay + fallback
```

Expected `doctor` output is four `ok` lines. `list` must show the same session ids
that `push` reported as scanned.

## Failure playbook

| Symptom | Action |
| --- | --- |
| `swift build` → `sandbox_apply: Operation not permitted` | set `DSH_RELAY_SWIFTPM_SANDBOX=disable` |
| `EADDRINUSE` | pick `--port`; check `launchctl list | grep dsh-relay-sync` |
| `401 unauthorized` | token in `relay.env` ≠ token used by the client |
| `409 host_offline` | start `relay-sync serve`; the host poll is what makes the device live |
| empty list | run `push` first; `serve` pushes at start and every 30 s |
| `zstd` missing | `brew install zstd` (only for `.zstd` session files) |

Never hand-edit `relay-store.json`; restart the relay and re-push instead.

## Repository map

```
server/src/app.js      routes + auth + error mapping
server/src/store.js    JSON store, atomic writes, revision counter
server/src/relay.js    long-poll command relay, timeouts
server/src/events.js   SSE hub
server/src/model.js    session validation/normalization
server/test/*.test.js  node:test suite (12 tests)
apps/macos/Sources/RelaySyncKit/   models, client, DSHReader, SyncEngine, config
apps/macos/Sources/RelaySyncCLI/   main.swift (CLI) + UI.swift (SwiftUI)
apps/macos/Tests/                  XCTest suite
scripts/e2e.sh                     cross-component proof
docs/PROTOCOL.md                   wire contract (relay/1)
docs/ARCHITECTURE.md               data paths + comparison with references
```

## Development commands

```bash
cd server && npm test                      # no install step, no dependencies
cd apps/macos && swift build && swift test
bash scripts/e2e.sh                        # needs node + swift + zstd
```

## Rules for changes

- Keep the server dependency-free (`node:` builtins only). CI runs on Node 24.
- `relay/1` is versioned: additive fields are fine; renaming or removing a field
  or endpoint requires a new protocol version and a doc update in `docs/PROTOCOL.md`.
- Any change to on-disk behaviour must stay crash-safe: write temp file, then
  rename; never write `relay-store.json` directly.
- The Mac must never require an inbound port. If a feature needs push, extend the
  host poll, do not add a server→Mac connection.
- Update `docs/` in the same commit as behaviour; `README.md` and `README.en.md`
  must stay in sync.
