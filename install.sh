#!/usr/bin/env bash
# dsh-relay-sync — one-click install for macOS.
#
#   ./install.sh all        # relay + macOS host on this machine
#   ./install.sh relay      # relay only (LaunchAgent, port 8787)
#   ./install.sh mac        # macOS host only (build, install CLI, LaunchAgent)
#   ./install.sh status     # show agent status, health, config
#   ./install.sh uninstall  # stop and remove the LaunchAgents
#
# Flags: --token T --relay URL --name NAME --port N --prefix DIR --yes --no-agent --dry-run
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMAND="${1:-all}"
if [ $# -gt 0 ]; then shift; fi

PREFIX="$HOME/.local"
PORT="8787"
RELAY_URL=""
TOKEN=""
DEVICE_NAME="$(scutil --get ComputerName 2>/dev/null || hostname)"
ASSUME_YES=0
NO_AGENT=0
DRY_RUN=0
STATE_DIR="$HOME/.dsh-relay-sync"
RELAY_DATA="$STATE_DIR/relay-data"
AGENT_DIR="$HOME/Library/LaunchAgents"

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    --relay) RELAY_URL="$2"; shift 2 ;;
    --name) DEVICE_NAME="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; RELAY_DATA="$2/relay-data"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --no-agent) NO_AGENT=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -n "$RELAY_URL" ] || RELAY_URL="http://127.0.0.1:$PORT"

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
  if [ -f "$STATE_DIR/relay.env" ]; then
    # shellcheck disable=SC1091
    . "$STATE_DIR/relay.env"
    [ -n "$TOKEN" ] || TOKEN="$RELAY_TOKEN"
  fi
}

new_token() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'
}

write_relay_env() {
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] write $STATE_DIR/relay.env (token, port, data dir)"
    return 0
  fi
  mkdir -p "$STATE_DIR" "$RELAY_DATA"
  chmod 700 "$STATE_DIR"
  cat >"$STATE_DIR/relay.env" <<EOF
RELAY_TOKEN=$TOKEN
RELAY_PORT=$PORT
RELAY_DATA_DIR=$RELAY_DATA
RELAY_URL=$RELAY_URL
EOF
  chmod 600 "$STATE_DIR/relay.env"
  log "wrote $STATE_DIR/relay.env"
}

install_relay() {
  require_macos
  check_node
  load_state
  [ -n "$TOKEN" ] || TOKEN="$(new_token)"
  step "relay server"
  write_relay_env

  if [ "$NO_AGENT" = "1" ]; then
    log "no launch agent requested; start manually:"
    log "  RELAY_TOKEN=$TOKEN RELAY_PORT=$PORT node $ROOT/server/src/index.js"
    return 0
  fi

  local plist="$AGENT_DIR/com.dsh-relay-sync.relay.plist"
  run mkdir -p "$AGENT_DIR"
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] write $plist"
  else
    cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dsh-relay-sync.relay</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$ROOT/server/src/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RELAY_TOKEN</key><string>$TOKEN</string>
    <key>RELAY_PORT</key><string>$PORT</string>
    <key>RELAY_DATA_DIR</key><string>$RELAY_DATA</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$STATE_DIR/relay.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/relay.err.log</string>
</dict>
</plist>
EOF
  fi
  run launchctl bootout "gui/$(id -u)/com.dsh-relay-sync.relay" || true
  run launchctl bootstrap "gui/$(id -u)" "$plist"
  run launchctl enable "gui/$(id -u)/com.dsh-relay-sync.relay"
  health_wait
}

health_wait() {
  if [ "$DRY_RUN" = "1" ]; then return 0; fi
  for _ in $(seq 1 50); do
    if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
      log "relay healthy at http://127.0.0.1:$PORT"
      return 0
    fi
    sleep 0.2
  done
  die "relay did not become healthy; see $STATE_DIR/relay.err.log"
}

install_mac() {
  require_macos
  check_node
  check_zstd
  command -v swift >/dev/null 2>&1 || die "swift toolchain required (xcode-select --install)"
  step "build macOS client"
  # Sandboxed/CI shells cannot nest SwiftPM's own sandbox; opt out explicitly there.
  SWIFT_FLAGS=()
  if [ "${DSH_RELAY_SWIFTPM_SANDBOX:-}" = "disable" ]; then
    SWIFT_FLAGS+=(--disable-sandbox --cache-path "$STATE_DIR/swift-cache")
  fi
  ( cd "$ROOT/apps/macos" && run swift build -c release "${SWIFT_FLAGS[@]}" ) || die "swift build failed"
  local bin="$ROOT/apps/macos/.build/release/relay-sync"
  if [ "$DRY_RUN" != "1" ] && [ ! -x "$bin" ]; then die "missing release binary"; fi
  run mkdir -p "$PREFIX/bin"
  run install -m 0755 "$bin" "$PREFIX/bin/relay-sync"
  log "installed $PREFIX/bin/relay-sync"

  load_state
  [ -n "$TOKEN" ] || die "no token: pass --token, or run './install.sh relay' first"

  step "register this Mac"
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] relay-sync register --relay $RELAY_URL --name $DEVICE_NAME"
  else
    "$PREFIX/bin/relay-sync" register --relay "$RELAY_URL" --token "$TOKEN" --name "$DEVICE_NAME" --config "$STATE_DIR/macos.json"
  fi

  if [ "$NO_AGENT" = "1" ]; then
    log "start the host manually:"
    log "  $PREFIX/bin/relay-sync serve"
    return 0
  fi

  step "start host agent"
  local plist="$AGENT_DIR/com.dsh-relay-sync.host.plist"
  run mkdir -p "$AGENT_DIR"
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] write $plist"
  else
    cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dsh-relay-sync.host</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PREFIX/bin/relay-sync</string>
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
  run launchctl bootout "gui/$(id -u)/com.dsh-relay-sync.host" || true
  run launchctl bootstrap "gui/$(id -u)" "$plist"
  run launchctl enable "gui/$(id -u)/com.dsh-relay-sync.host"
}

show_status() {
  step "launch agents"
  launchctl list 2>/dev/null | grep -E 'dsh-relay-sync' || log "no agents loaded"
  step "relay health"
  curl -fsS "http://127.0.0.1:$PORT/healthz" || log "relay not reachable on port $PORT"
  echo
  step "config"
  if [ -x "$PREFIX/bin/relay-sync" ]; then
    "$PREFIX/bin/relay-sync" config || true
  else
    log "relay-sync not installed at $PREFIX/bin"
  fi
}

uninstall() {
  step "stopping agents"
  run launchctl bootout "gui/$(id -u)/com.dsh-relay-sync.host" || true
  run launchctl bootout "gui/$(id -u)/com.dsh-relay-sync.relay" || true
  run rm -f "$AGENT_DIR/com.dsh-relay-sync.host.plist" "$AGENT_DIR/com.dsh-relay-sync.relay.plist"
  log "kept $STATE_DIR (config, tokens, data). Remove it manually to wipe state."
}

confirm() {
  [ "$ASSUME_YES" = "1" ] && return 0
  printf '%s [y/N] ' "$1"
  read -r answer
  case "$answer" in y|Y|yes|YES) return 0 ;; *) exit 1 ;; esac
}

case "$COMMAND" in
  relay) install_relay ;;
  mac) install_mac ;;
  all)
    install_relay
    TOKEN="$(sed -n 's/^RELAY_TOKEN=//p' "$STATE_DIR/relay.env" 2>/dev/null || true)"
    if [ -z "$TOKEN" ] && [ "$DRY_RUN" = "1" ]; then TOKEN="dry-run-token"; fi
    install_mac
    ;;
  status) show_status ;;
  uninstall) confirm "Stop and remove dsh-relay-sync LaunchAgents?"; uninstall ;;
  help|-h|--help) usage ;;
  *) usage; exit 2 ;;
esac

if [ "$COMMAND" != "status" ]; then
  echo
  echo "Done."
  echo "  relay:   $RELAY_URL"
  echo "  token:   $(sed -n 's/^RELAY_TOKEN=//p' "$STATE_DIR/relay.env" 2>/dev/null || printf '%s' "$TOKEN")"
  echo "  config:  $STATE_DIR/macos.json"
  echo "  verify:  $PREFIX/bin/relay-sync doctor && $PREFIX/bin/relay-sync list"
fi
