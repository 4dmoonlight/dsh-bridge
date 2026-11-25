#!/usr/bin/env bash
# Deploy the dsh-relay-sync relay onto a Linux server (systemd).
#
#   sudo bash scripts/deploy-server.sh --domain relay.example.com
#   sudo bash scripts/deploy-server.sh --port 8787 --no-caddy
#   sudo bash scripts/deploy-server.sh --print-only      # show the plan, change nothing
#
# The script is idempotent: re-running updates the code and restarts the service.
# The instance token is generated once and kept in /etc/dsh-relay-sync/env (0600).
set -euo pipefail

PORT="${RELAY_PORT:-8787}"
DOMAIN=""
REPO_URL="${RELAY_REPO_URL:-https://github.com/4dmoonlight/dsh-relay-sync.git}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
INSTALL_DIR="${RELAY_INSTALL_DIR:-/opt/dsh-relay-sync}"
DATA_DIR="${RELAY_DATA_DIR:-/var/lib/dsh-relay-sync}"
ENV_DIR="/etc/dsh-relay-sync"
ENV_FILE="$ENV_DIR/env"
SERVICE="dsh-relay-sync"
SERVICE_USER="relay"
CADDY=1
PRINT_ONLY=0

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --github-token) GITHUB_TOKEN="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --no-caddy) CADDY=0; shift ;;
    --print-only) PRINT_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
run()  { if [ "$PRINT_ONLY" = "1" ]; then printf '  [print] %s\n' "$*"; else "$@"; fi; }

if [ "$PRINT_ONLY" = "1" ]; then
  step "plan"
  log "install dir:  $INSTALL_DIR"
  log "data dir:     $DATA_DIR"
  log "env file:     $ENV_FILE"
  log "service:      $SERVICE (systemd, user $SERVICE_USER, port $PORT)"
  log "repo:         $REPO_URL"
  log "caddy:        $([ "$CADDY" = 1 ] && echo "configure for $DOMAIN" || echo off)"
  log "steps: verify node>=22.5 → clone/pull → token → systemd unit → start → health check"
  exit 0
fi

[ "$(id -u)" = "0" ] || die "run as root (sudo)"
[ "$(uname -s)" = "Linux" ] || die "this script targets Linux; on macOS use install.sh"
command -v systemctl >/dev/null 2>&1 || die "systemd is required"

step "node"
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  minor="$(node -p 'process.versions.node.split(".")[1]')"
  if [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 5 ]; }; then
    log "node $(node -v) ok"
    need_node=0
  else
    log "node $(node -v) is too old; installing a local Node 22 runtime"
  fi
else
  log "node not found; installing a local Node 22 runtime"
fi

if [ "$need_node" = "1" ]; then
  command -v curl >/dev/null 2>&1 || die "curl is required to install Node"
  case "$(uname -m)" in
    x86_64|amd64) node_arch="linux-x64" ;;
    aarch64|arm64) node_arch="linux-arm64" ;;
    *) die "unsupported architecture $(uname -m)" ;;
  esac
  base="https://nodejs.org/dist/latest-v22.x"
  file="$(curl -fsSL "$base/" | grep -o "node-v22\.[0-9.]*-$node_arch\.tar\.xz" | head -1)"
  [ -n "$file" ] || die "could not resolve a Node 22 tarball from $base"
  curl -fsSL -o "/tmp/$file" "$base/$file"
  mkdir -p /opt/node22
  tar -xJf "/tmp/$file" -C /opt/node22 --strip-components=1
  ln -sf /opt/node22/bin/node /usr/local/bin/node
  ln -sf /opt/node22/bin/npm /usr/local/bin/npm
  rm -f "/tmp/$file"
  log "installed $(/usr/local/bin/node -v) to /opt/node22"
fi
NODE_BIN="$(command -v node)"

step "service account and directories"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  run useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  log "created system user $SERVICE_USER"
fi
run mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$ENV_DIR"
run chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

step "code"
clone_url="$REPO_URL"
if [ -n "$GITHUB_TOKEN" ]; then
  case "$REPO_URL" in
    https://github.com/*)
      repo_path="${REPO_URL#https://}"
      clone_url="https://x-access-token:$GITHUB_TOKEN@$repo_path"
      ;;
  esac
fi
# Re-runs run as root over a checkout owned by $SERVICE_USER, which git refuses
# ("dubious ownership"). Scope the exception to this one directory.
if ! run git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$INSTALL_DIR"; then
  run git config --global --add safe.directory "$INSTALL_DIR"
fi
if [ -d "$INSTALL_DIR/.git" ]; then
  run git -C "$INSTALL_DIR" remote set-url origin "$clone_url"
  run git -C "$INSTALL_DIR" fetch --depth 1 origin main
  run git -C "$INSTALL_DIR" reset --hard origin/main
  log "updated existing checkout"
else
  run git clone --depth 1 "$clone_url" "$INSTALL_DIR"
  log "cloned repository"
fi
if [ -n "$GITHUB_TOKEN" ]; then
  run git -C "$INSTALL_DIR" remote set-url origin "$REPO_URL"
  log "token removed from the git remote"
fi
run chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

step "instance token"
# Rewrite the file whole: appending on every re-run left duplicate keys
# (last one wins in systemd, so a changed --port silently did nothing).
prev_token=""
if [ -f "$ENV_FILE" ]; then
  prev_token="$(sed -n 's/^RELAY_TOKEN=//p' "$ENV_FILE" | head -1)"
fi
if [ -n "$prev_token" ]; then
  token="$prev_token"
  log "reusing token in $ENV_FILE"
elif [ -n "${RELAY_TOKEN:-}" ]; then
  token="$RELAY_TOKEN"
  log "wrote token from RELAY_TOKEN"
else
  token="$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
  log "generated a new token in $ENV_FILE"
fi
umask 077
{
  printf 'RELAY_TOKEN=%s\n' "$token"
  printf 'RELAY_PORT=%s\n' "$PORT"
  printf 'RELAY_HOST=127.0.0.1\n'
  printf 'RELAY_DATA_DIR=%s\n' "$DATA_DIR"
} >"$ENV_FILE"
unset token prev_token
chmod 0640 "$ENV_FILE"
chown root:"$SERVICE_USER" "$ENV_FILE"
TOKEN="$(sed -n 's/^RELAY_TOKEN=//p' "$ENV_FILE")"

step "systemd unit"
cat >"/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=dsh-relay-sync relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $INSTALL_DIR/apps/server/src/index.js
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
run systemctl daemon-reload
run systemctl enable "$SERVICE" >/dev/null
run systemctl restart "$SERVICE"

step "health check"
ok=0
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 0.25
done
if [ "$ok" = "1" ]; then
  log "local healthz ok on 127.0.0.1:$PORT"
else
  journalctl -u "$SERVICE" -n 30 --no-pager || true
  die "relay did not become healthy"
fi

if [ "$CADDY" = "1" ] && [ -n "$DOMAIN" ]; then
  step "caddy"
  if command -v caddy >/dev/null 2>&1; then
    caddy_file="/etc/caddy/conf.d/$SERVICE.caddy"
    mkdir -p "$(dirname "$caddy_file")"
    cat >"$caddy_file" <<EOF
$DOMAIN {
  reverse_proxy 127.0.0.1:$PORT
}
EOF
    if grep -q 'conf.d' /etc/caddy/Caddyfile 2>/dev/null; then
      log "site added to $caddy_file"
    else
      log "wrote $caddy_file; add 'import conf.d/*.caddy' to /etc/caddy/Caddyfile"
    fi
    run systemctl reload caddy || log "reload caddy failed; check caddy config"
  else
    log "caddy not installed; put a TLS proxy in front of 127.0.0.1:$PORT yourself"
  fi
fi

step "done"
public="http://127.0.0.1:$PORT"
[ -n "$DOMAIN" ] && public="https://$DOMAIN"
cat <<EOF

  relay URL:  $public
  token:      $TOKEN
  env file:   $ENV_FILE (0600)
  data:       $DATA_DIR (relay-store.json, plaintext sessions)
  service:    systemctl status $SERVICE

  Next, on the Mac:

    git clone $REPO_URL && cd dsh-relay-sync
    ./install.sh mac --relay $public --token $TOKEN --yes

  Treat the token as a password. It can read every stored session.
EOF
