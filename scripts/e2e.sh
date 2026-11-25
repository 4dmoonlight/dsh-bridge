#!/usr/bin/env bash
# End-to-end proof: relay server + macOS host/client over real HTTP.
# Usage: bash scripts/e2e.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
TOKEN="e2e-$(date +%s)-$RANDOM"
RELAY_PID=""
SERVE_PID=""

cleanup() {
  [ -n "$SERVE_PID" ] && kill "$SERVE_PID" 2>/dev/null || true
  [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "== node $(node --version)"

echo "== start relay on 127.0.0.1:$PORT"
RELAY_DATA_DIR="$TMP/relay" RELAY_TOKEN="$TOKEN" RELAY_PORT="$PORT" \
  node "$ROOT/apps/server/src/index.js" >"$TMP/relay.log" 2>&1 &
RELAY_PID=$!

for _ in $(seq 1 100); do
  if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null || { cat "$TMP/relay.log"; echo "relay did not start"; exit 1; }

echo "== build macOS binary"
(cd "$ROOT/apps/macos" && swift build --disable-sandbox --scratch-path .build --cache-path "$TMP/swift-cache" >/dev/null)
BIN="$(cd "$ROOT/apps/macos" && swift build --disable-sandbox --scratch-path .build --cache-path "$TMP/swift-cache" --show-bin-path)/relay-sync"
[ -x "$BIN" ] || { echo "missing binary at $BIN"; exit 1; }

CONFIG="$TMP/macos.json"
echo "== register"
"$BIN" register --relay "http://127.0.0.1:$PORT" --token "$TOKEN" --name "e2e-mac" --config "$CONFIG"

echo "== push local DSH sessions"
"$BIN" push --limit 2 --config "$CONFIG"

echo "== list from the relay"
"$BIN" list --limit 10 --json --config "$CONFIG" >"$TMP/list.json"
python3 - "$TMP/list.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
sessions = data.get("sessions") or []
assert sessions, "relay returned no sessions"
print("relay has", len(sessions), "session(s); first:", sessions[0]["id"], "-", sessions[0]["title"][:50])
PY
SID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sessions"][0]["id"])' "$TMP/list.json")"
DEVICE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["deviceId"])' "$CONFIG")"

echo "== show one session"
# 不能直接 | head:set -o pipefail 下 head 提前关闭管道会让 show 收到 SIGPIPE(exit 141),
# 会话内容变长后就会随机失败。先落盘再截取。
"$BIN" show "$SID" --config "$CONFIG" >"$TMP/show.txt" 2>&1
head -4 "$TMP/show.txt"

echo "== live relay: host serves while client asks for the session"
"$BIN" serve --config "$CONFIG" --push-every 9999 --poll-wait 20 >"$TMP/serve.log" 2>&1 &
SERVE_PID=$!

LIVE=""
for _ in $(seq 1 60); do
  BODY="$(curl -s -X POST "http://127.0.0.1:$PORT/v1/relay/sessions/$SID/fetch" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"deviceId\":\"$DEVICE\"}" || true)"
  if echo "$BODY" | grep -q '"source":"live"'; then LIVE="$BODY"; break; fi
  sleep 0.5
done
[ -n "$LIVE" ] || { echo "live relay did not answer"; cat "$TMP/serve.log"; exit 1; }
echo "$LIVE" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["source"]=="live"; print("live relay ok:", d["session"]["title"])'

echo "== offline fallback after stopping the host"
kill "$SERVE_PID" 2>/dev/null || true
SERVE_PID=""
sleep 0.5
curl -s -X POST "http://127.0.0.1:$PORT/v1/relay/sessions/$SID/fetch" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"deviceId\":\"$DEVICE\",\"fallback\":\"stored\"}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["source"]=="stored"; print("stored fallback ok:", d["session"]["id"])'

echo
echo "E2E OK"
