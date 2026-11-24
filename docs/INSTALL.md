# Install

Two halves: the **relay server** (runs anywhere with Node) and the **macOS app**
(reads local DSH sessions and keeps a relay poll open).

## Requirements

| Component | Needs |
| --- | --- |
| relay | Node.js **≥ 22.5** (uses ESM + `node:test`; no dependencies) |
| macOS app | macOS 13+, Xcode command line tools (`swift`), `zstd` (`brew install zstd`) for compressed DSH session files |
| DSH | `~/.dsh/sessions` populated by a normal DeepSeek Harness install |

## One-click (same machine)

```bash
git clone https://github.com/OWNER/dsh-relay-sync.git
cd dsh-relay-sync
./install.sh all
```

That:

1. generates a relay token into `~/.dsh-relay-sync/relay.env`;
2. installs a LaunchAgent `com.dsh-relay-sync.relay` (port 8787, restarts on crash);
3. builds `relay-sync` in release mode and copies it to `~/.local/bin`;
4. registers this Mac as a device (token saved to `~/.dsh-relay-sync/macos.json`, mode 0600);
5. installs a LaunchAgent `com.dsh-relay-sync.host` running `relay-sync serve`.

Verify:

```bash
~/.local/bin/relay-sync doctor
~/.local/bin/relay-sync list
```

`doctor` checks the sessions directory, `zstd`, the config, and relay health.

## One-click with a remote relay

On the server (Linux or macOS, Node ≥ 22.5):

```bash
git clone https://github.com/OWNER/dsh-relay-sync.git
cd dsh-relay-sync
RELAY_TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')" \
RELAY_PORT=8787 RELAY_DATA_DIR=/var/lib/dsh-relay-sync \
  nohup node server/src/index.js >/tmp/dsh-relay-sync.log 2>&1 &
echo "$RELAY_TOKEN"
```

Put it behind TLS (Caddy example):

```
relay.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

On the Mac:

```bash
./install.sh mac --relay https://relay.example.com --token "<token>" --yes
```

## Manual (no LaunchAgents)

```bash
# relay
RELAY_TOKEN=secret RELAY_PORT=8787 RELAY_DATA_DIR=~/.dsh-relay-sync/relay-data \
  node server/src/index.js

# macOS app
cd apps/macos && swift build -c release
.build/release/relay-sync register --relay http://127.0.0.1:8787 --token secret --name my-mac
.build/release/relay-sync push --limit 50      # one-shot push
.build/release/relay-sync serve                # host mode: push + answer relay fetches
.build/release/relay-sync list                 # read what the relay holds
.build/release/relay-sync ui                   # SwiftUI window
```

## Installer flags

```
--token T        instance token (default: generated, or read from relay.env)
--relay URL      relay base URL (default http://127.0.0.1:8787)
--name NAME      device name (default: mac ComputerName)
--port N         relay port (default 8787)
--prefix DIR     CLI install prefix (default ~/.local)
--state-dir DIR  state directory (default ~/.dsh-relay-sync)
--yes            do not prompt
--no-agent       write files only; do not touch launchd
--dry-run        print every action without doing it
```

## Uninstall

```bash
./install.sh uninstall
```

State under `~/.dsh-relay-sync` (tokens, config, stored sessions) is kept; remove
it manually to wipe everything.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `EADDRINUSE` on 8787 | another relay is running; `launchctl bootout gui/$(id -u)/com.dsh-relay-sync.relay` or use `--port` |
| `401 unauthorized` | token mismatch; check `~/.dsh-relay-sync/relay.env` and the plist it wrote |
| `409 host_offline` | the Mac's host loop is not running: `relay-sync serve`, or check `~/.dsh-relay-sync/host.err.log` |
| `doctor` says zstd missing | `brew install zstd` (only needed for compressed `session.v4.jsonl.zstd`) |
| `swift build` fails with `sandbox_apply` | you are inside another sandbox (CI, DSH); set `DSH_RELAY_SWIFTPM_SANDBOX=disable` |
| empty session list | run `relay-sync push` once; `serve` pushes at start but only every 30 s afterwards |
