#!/usr/bin/env bash
# dsh-bridge — one-click install for macOS.
#
#   ./install.sh all        # hub + macOS host on this machine
#   ./install.sh hub      # hub only (LaunchAgent, port 8787)
#   ./install.sh mac        # macOS host only (build, install CLI, LaunchAgent)
#   ./install.sh status     # show agent status, health, config
#   ./install.sh uninstall  # stop and remove the LaunchAgents
#
# Flags: --token T --hub URL --name NAME --port N --prefix DIR --yes --no-agent --dry-run
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMAND="${1:-all}"
if [ $# -gt 0 ]; then shift; fi

PREFIX="$HOME/.local"
PORT="8787"
HUB_URL=""
TOKEN=""
DEVICE_NAME="$(scutil --get ComputerName 2>/dev/null || hostname)"
ASSUME_YES=0
NO_AGENT=0
DRY_RUN=0
STATE_DIR="$HOME/.dsh-bridge"
HUB_DATA="$STATE_DIR/hub-data"
AGENT_DIR="$HOME/Library/LaunchAgents"

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    --hub) HUB_URL="$2"; shift 2 ;;
    --name) DEVICE_NAME="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; HUB_DATA="$2/hub-data"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --no-agent) NO_AGENT=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -n "$HUB_URL" ] || HUB_URL="http://127.0.0.1:$PORT"

log()  { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
run()  {
  if [ "$DRY_RUN" = "1" ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi
}

require_macos() {
  [ "$(uname -s)" = "Darwin" ] || die "this installer targets macOS"
}

check_node() {
  command -v node >/dev/null 2>&1 || die "node is required (>=22.5): brew install node"
  local major minor
  major="$(node -p 'process.versions.node.split(".")[0]')"
  minor="$(node -p 'process.versions.node.split(".")[1]')"
  if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 5 ]; }; then
    die "node >= 22.5 required, found $(node -v)"
  fi
  log "node $(node -v)"
}

check_zstd() {
  command -v zstd >/dev/null 2>&1 || die "zstd is required to read compressed DSH sessions: brew install zstd"
  log "zstd present"
}

load_state() {
  if [ -f "$STATE_DIR/hub.env" ]; then
    # shellcheck disable=SC1091
    . "$STATE_DIR/hub.env"
    [ -n "$TOKEN" ] || TOKEN="$BRIDGE_TOKEN"
  fi
}

new_token() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'
}

write_hub_env() {
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] write $STATE_DIR/hub.env (token, port, data dir)"
    return 0
  fi
  mkdir -p "$STATE_DIR" "$HUB_DATA"
  chmod 700 "$STATE_DIR"
  cat >"$STATE_DIR/hub.env" <<EOF
BRIDGE_TOKEN=$TOKEN
BRIDGE_PORT=$PORT
BRIDGE_DATA_DIR=$HUB_DATA
HUB_URL=$HUB_URL
EOF
  chmod 600 "$STATE_DIR/hub.env"
  log "wrote $STATE_DIR/hub.env"
}

install_hub() {
  require_macos
  check_node
  load_state
  [ -n "$TOKEN" ] || TOKEN="$(new_token)"
  step "hub server"
  write_hub_env

  if [ "$NO_AGENT" = "1" ]; then
    log "no launch agent requested; start manually:"
    log "  BRIDGE_TOKEN=$TOKEN BRIDGE_PORT=$PORT node $ROOT/apps/server/src/index.js"
    return 0
  fi

  local plist="$AGENT_DIR/com.dsh-bridge.hub.plist"
  run mkdir -p "$AGENT_DIR"
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] write $plist"
  else
    cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dsh-bridge.hub</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$ROOT/apps/server/src/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BRIDGE_TOKEN</key><string>$TOKEN</string>
    <key>BRIDGE_PORT</key><string>$PORT</string>
    <key>BRIDGE_DATA_DIR</key><string>$HUB_DATA</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$STATE_DIR/hub.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/hub.err.log</string>
</dict>
</plist>
EOF
  fi
  run launchctl bootout "gui/$(id -u)/com.dsh-bridge.hub" || true
  run launchctl bootstrap "gui/$(id -u)" "$plist"
  run launchctl enable "gui/$(id -u)/com.dsh-bridge.hub"
  health_wait
}

health_wait() {
  if [ "$DRY_RUN" = "1" ]; then return 0; fi
  for _ in $(seq 1 50); do
    if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
      log "hub healthy at http://127.0.0.1:$PORT"
      return 0
    fi
    sleep 0.2
  done
  die "hub did not become healthy; see $STATE_DIR/hub.err.log"
}

install_mac() {
  require_macos
  check_node
  check_zstd
  command -v swift >/dev/null 2>&1 || die "swift toolchain required (xcode-select --install)"
  step "build macOS client"
  # Sandboxed/CI shells cannot nest SwiftPM's own sandbox; opt out explicitly there.
  # bash 3.2 (macOS /bin/bash) errors on expanding an empty array under set -u.
  if [ "${DSH_BRIDGE_SWIFTPM_SANDBOX:-}" = "disable" ]; then
    ( cd "$ROOT/apps/macos" && run swift build -c release --disable-sandbox --cache-path "$STATE_DIR/swift-cache" ) || die "swift build failed"
  else
    ( cd "$ROOT/apps/macos" && run swift build -c release ) || die "swift build failed"
  fi
  local bin="$ROOT/apps/macos/.build/release/dsh-bridge"
  if [ "$DRY_RUN" != "1" ] && [ ! -x "$bin" ]; then die "missing release binary"; fi
  run mkdir -p "$PREFIX/bin"
  run install -m 0755 "$bin" "$PREFIX/bin/dsh-bridge"
  log "installed $PREFIX/bin/dsh-bridge"

  load_state
  [ -n "$TOKEN" ] || die "no token: pass --token, or run './install.sh hub' first"

  step "register this Mac"
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] dsh-bridge register --hub $HUB_URL --name $DEVICE_NAME"
  else
    "$PREFIX/bin/dsh-bridge" register --hub "$HUB_URL" --token "$TOKEN" --name "$DEVICE_NAME" --config "$STATE_DIR/macos.json"
  fi

  if [ "$NO_AGENT" = "1" ]; then
    log "start the host manually:"
    log "  $PREFIX/bin/dsh-bridge serve"
    return 0
  fi

  step "start host agent"
  local plist="$AGENT_DIR/com.dsh-bridge.host.plist"
  run mkdir -p "$AGENT_DIR"
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] write $plist"
  else
    cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dsh-bridge.host</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PREFIX/bin/dsh-bridge</string>
    <string>serve</string>
    <string>--config</string>
    <string>$STATE_DIR/macos.json</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PREFIX/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$STATE_DIR/host.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/host.err.log</string>
</dict>
</plist>
EOF
  fi
  run launchctl bootout "gui/$(id -u)/com.dsh-bridge.host" || true
  run launchctl bootstrap "gui/$(id -u)" "$plist"
  run launchctl enable "gui/$(id -u)/com.dsh-bridge.host"
}

show_status() {
  step "launch agents"
  launchctl list 2>/dev/null | grep -E 'dsh-bridge' || log "no agents loaded"
  step "hub health"
  curl -fsS "http://127.0.0.1:$PORT/healthz" || log "hub not reachable on port $PORT"
  echo
  step "config"
  if [ -x "$PREFIX/bin/dsh-bridge" ]; then
    "$PREFIX/bin/dsh-bridge" config || true
  else
    log "dsh-bridge not installed at $PREFIX/bin"
  fi
}

uninstall() {
  step "stopping agents"
  run launchctl bootout "gui/$(id -u)/com.dsh-bridge.host" || true
  run launchctl bootout "gui/$(id -u)/com.dsh-bridge.hub" || true
  run rm -f "$AGENT_DIR/com.dsh-bridge.host.plist" "$AGENT_DIR/com.dsh-bridge.hub.plist"
  log "kept $STATE_DIR (config, tokens, data). Remove it manually to wipe state."
}

confirm() {
  [ "$ASSUME_YES" = "1" ] && return 0
  printf '%s [y/N] ' "$1"
  read -r answer
  case "$answer" in y|Y|yes|YES) return 0 ;; *) exit 1 ;; esac
}

case "$COMMAND" in
  hub) install_hub ;;
  mac) install_mac ;;
  all)
    install_hub
    TOKEN="$(sed -n 's/^BRIDGE_TOKEN=//p' "$STATE_DIR/hub.env" 2>/dev/null || true)"
    if [ -z "$TOKEN" ] && [ "$DRY_RUN" = "1" ]; then TOKEN="dry-run-token"; fi
    install_mac
    ;;
  status) show_status ;;
  uninstall) confirm "Stop and remove dsh-bridge LaunchAgents?"; uninstall ;;
  help|-h|--help) usage ;;
  *) usage; exit 2 ;;
esac

if [ "$COMMAND" != "status" ]; then
  echo
  echo "Done."
  echo "  hub:   $HUB_URL"
  echo "  token:   $(sed -n 's/^BRIDGE_TOKEN=//p' "$STATE_DIR/hub.env" 2>/dev/null || printf '%s' "$TOKEN")"
  echo "  config:  $STATE_DIR/macos.json"
  echo "  verify:  $PREFIX/bin/dsh-bridge doctor && $PREFIX/bin/dsh-bridge list"
fi
