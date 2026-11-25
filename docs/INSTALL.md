# Install

Two halves: the **hub server** (runs anywhere with Node) and the **macOS app**
(reads local DSH sessions and keeps a hub poll open).

## Requirements

| Component | Needs |
| --- | --- |
| hub | Node.js **≥ 22.5** (uses ESM + `node:test`; no dependencies) |
| macOS app | macOS 13+, Xcode command line tools (`swift`), `zstd` (`brew install zstd`) for compressed DSH session files |
| DSH | `~/.dsh/sessions` populated by a normal DeepSeek Harness install |

## One-click (same machine)

```bash
git clone https://github.com/4dmoonlight/dsh-bridge.git
cd dsh-bridge
./install.sh all
```

That:

1. generates a hub token into `~/.dsh-bridge/hub.env`;
2. installs a LaunchAgent `com.dsh-bridge.hub` (port 8787, restarts on crash);
3. builds `dsh-bridge` in release mode and copies it to `~/.local/bin`;
4. registers this Mac as a device (token saved to `~/.dsh-bridge/macos.json`, mode 0600);
5. installs a LaunchAgent `com.dsh-bridge.host` running `dsh-bridge serve`.

Verify:

```bash
~/.local/bin/dsh-bridge doctor
~/.local/bin/dsh-bridge list
```

`doctor` checks the sessions directory, `zstd`, the config, and hub health.

## One-click with a remote hub

On the server (Linux or macOS, Node ≥ 22.5):

```bash
git clone https://github.com/4dmoonlight/dsh-bridge.git
cd dsh-bridge
BRIDGE_TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')" \
BRIDGE_PORT=8787 BRIDGE_DATA_DIR=/var/lib/dsh-bridge \
  nohup node apps/server/src/index.js >/tmp/dsh-bridge.log 2>&1 &
echo "$BRIDGE_TOKEN"
```

Put it behind TLS (Caddy example):

```
hub.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

On the Mac:

```bash
./install.sh mac --hub https://hub.example.com --token "<token>" --yes
```

## Manual (no LaunchAgents)

```bash
# hub
BRIDGE_TOKEN=secret BRIDGE_PORT=8787 BRIDGE_DATA_DIR=~/.dsh-bridge/hub-data \
  node apps/server/src/index.js

# macOS app
cd apps/macos && swift build -c release
.build/release/dsh-bridge register --hub http://127.0.0.1:8787 --token secret --name my-mac
.build/release/dsh-bridge push --limit 50      # one-shot push
.build/release/dsh-bridge serve                # host mode: push + answer hub fetches
.build/release/dsh-bridge list                 # read what the hub holds
.build/release/dsh-bridge ui                   # SwiftUI window
```

## Installer flags

```
--token T        instance token (default: generated, or read from hub.env)
--hub URL      hub base URL (default http://127.0.0.1:8787)
--name NAME      device name (default: mac ComputerName)
--port N         hub port (default 8787)
--prefix DIR     CLI install prefix (default ~/.local)
--state-dir DIR  state directory (default ~/.dsh-bridge)
--yes            do not prompt
--no-agent       write files only; do not touch launchd
--dry-run        print every action without doing it
```

## Uninstall

```bash
./install.sh uninstall
```

State under `~/.dsh-bridge` (tokens, config, stored sessions) is kept; remove
it manually to wipe everything.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `EADDRINUSE` on 8787 | another hub is running; `launchctl bootout gui/$(id -u)/com.dsh-bridge.hub` or use `--port` |
| `401 unauthorized` | token mismatch; check `~/.dsh-bridge/hub.env` and the plist it wrote |
| `409 host_offline` | the Mac's host loop is not running: `dsh-bridge serve`, or check `~/.dsh-bridge/host.err.log` |
| `doctor` says zstd missing | `brew install zstd` (only needed for compressed `session.v4.jsonl.zstd`) |
| `swift build` fails with `sandbox_apply` | you are inside another sandbox (CI, DSH); set `DSH_BRIDGE_SWIFTPM_SANDBOX=disable` |
| empty session list | run `dsh-bridge push` once; `serve` pushes at start but only every 30 s afterwards |
