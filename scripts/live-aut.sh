#!/usr/bin/env bash
# Boot the agent-under-test for the live suite: pack the plugin, stage a real
# opencode project, start `opencode serve` plus the gateway sidecar (tunnel +
# webhooks + voice wiring), and wait until the gateway is actually up.
#
# Env in:
#   MODE                    mock | real (model brain; default mock)
#   AUT_INKBOX_API_KEY      agent-scoped key of the AUT identity   (required)
#   AUT_INKBOX_SIGNING_KEY  the AUT identity's webhook signing key (required)
#   INKBOX_BASE_URL         Inkbox API origin (default https://inkbox.ai)
#   OPENAI_API_KEY          required when MODE=real
#   LIVE_WORKDIR            where to stage (default: mktemp)
#   INKBOX_WEBHOOK_SECRET_GITHUB  optional; enables external-event turns
#
# Out (appended to $GITHUB_ENV when present, else printed):
#   AUT_WORKDIR, AUT_GATEWAY_LOG, AUT_SERVE_LOG, AUT_GATEWAY_PID, AUT_SERVE_PID
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${MODE:-mock}"
BASE_URL="${INKBOX_BASE_URL:-https://inkbox.ai}"
WORKDIR="${LIVE_WORKDIR:-$(mktemp -d)}"
SERVE_PORT="${OPENCODE_PORT:-4096}"

: "${AUT_INKBOX_API_KEY:?AUT_INKBOX_API_KEY is required}"
: "${AUT_INKBOX_SIGNING_KEY:?AUT_INKBOX_SIGNING_KEY is required}"
[ "$MODE" = "real" ] && : "${OPENAI_API_KEY:?OPENAI_API_KEY is required for MODE=real}"

echo "==> building and packing the plugin"
cd "$ROOT"
npm run -s build
TARBALL="$ROOT/$(npm pack --silent | tail -1)"

echo "==> resolving the AUT identity handle"
HANDLE="$(INKBOX_BASE_URL="$BASE_URL" node --input-type=module -e "
import { Inkbox } from '@inkbox/sdk';
const c = new Inkbox({ apiKey: process.env.AUT_INKBOX_API_KEY, baseUrl: process.env.INKBOX_BASE_URL });
const boxes = await c.mailboxes.list();
if (!boxes.length) { console.error('AUT identity has no mailbox'); process.exit(1); }
console.log(boxes[0].emailAddress.split('@')[0]);
")"
echo "AUT handle: $HANDLE"

echo "==> staging project in $WORKDIR"
cd "$WORKDIR"
git init -q . 2>/dev/null || true
npm init -y >/dev/null 2>&1 || true
npm install --silent "$TARBALL"
mkdir -p .opencode/plugins .opencode/agent
cp "$ROOT/agents/inkbox-channel.md" .opencode/agent/

# Outbound approval auto: gateway turns must send without an interactive TUI.
cat > .opencode/plugins/inkbox.ts <<'EOF'
import InkboxPlugin from "@inkbox/opencode-plugin";

export default async (input: any) => {
  return InkboxPlugin(input, { outbound: { approval: "auto" } });
};
EOF

if [ "$MODE" = "mock" ]; then
  # A local OpenAI-compatible provider: the deterministic mock on :8088.
  cat > opencode.json <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "mock": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Mock",
      "options": { "baseURL": "http://127.0.0.1:8088/v1" },
      "models": { "mock-model": { "name": "mock-model" } }
    }
  }
}
EOF
  GATEWAY_MODEL="mock/mock-model"
else
  cat > opencode.json <<'EOF'
{ "$schema": "https://opencode.ai/config.json" }
EOF
  GATEWAY_MODEL="openai/gpt-4o"
fi

SERVE_LOG="$WORKDIR/serve.log"
GATEWAY_LOG="$WORKDIR/gateway.log"

echo "==> starting opencode serve on :$SERVE_PORT"
(cd "$WORKDIR" && nohup opencode serve --port "$SERVE_PORT" > "$SERVE_LOG" 2>&1 &
 echo $! > "$WORKDIR/serve.pid")
for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$SERVE_PORT/config" >/dev/null 2>&1 && break
  sleep 2
done
curl -sf "http://127.0.0.1:$SERVE_PORT/config" >/dev/null || {
  echo "::error::opencode serve did not come up"; cat "$SERVE_LOG"; exit 1; }

echo "==> starting the gateway sidecar ($MODE model: $GATEWAY_MODEL)"
(cd "$WORKDIR" && \
  INKBOX_API_KEY="$AUT_INKBOX_API_KEY" \
  INKBOX_IDENTITY="$HANDLE" \
  INKBOX_SIGNING_KEY="$AUT_INKBOX_SIGNING_KEY" \
  INKBOX_BASE_URL="$BASE_URL" \
  INKBOX_ALLOW_ALL_USERS=true \
  INKBOX_GATEWAY_PORT="${INKBOX_GATEWAY_PORT:-8767}" \
  INKBOX_EXTERNAL_EVENTS_ENABLED="${INKBOX_WEBHOOK_SECRET_GITHUB:+true}" \
  INKBOX_GATEWAY_AGENT=inkbox-channel \
  INKBOX_GATEWAY_MODEL="$GATEWAY_MODEL" \
  OPENCODE_SERVER_URL="http://127.0.0.1:$SERVE_PORT" \
  nohup node "$ROOT/bin/inkbox-opencode.js" run > "$GATEWAY_LOG" 2>&1 &
  echo $! > "$WORKDIR/gateway.pid")

echo "==> waiting for the gateway (tunnel + subscriptions)"
for _ in $(seq 1 36); do
  if grep -q "Gateway is running" "$GATEWAY_LOG" 2>/dev/null; then
    echo "Gateway ready: $(grep -oE 'https://[^" ]+' "$GATEWAY_LOG" | head -1)"
    break
  fi
  if ! kill -0 "$(cat "$WORKDIR/gateway.pid")" 2>/dev/null; then
    echo "::error::gateway exited early"; cat "$GATEWAY_LOG"; exit 1
  fi
  sleep 5
done
grep -q "Gateway is running" "$GATEWAY_LOG" || {
  echo "::error::gateway did not become ready"; cat "$GATEWAY_LOG"; exit 1; }

OUT="${GITHUB_ENV:-/dev/stdout}"
{
  echo "AUT_WORKDIR=$WORKDIR"
  echo "AUT_GATEWAY_LOG=$GATEWAY_LOG"
  echo "AUT_SERVE_LOG=$SERVE_LOG"
  echo "AUT_GATEWAY_PID=$(cat "$WORKDIR/gateway.pid")"
  echo "AUT_SERVE_PID=$(cat "$WORKDIR/serve.pid")"
} >> "$OUT"
echo "==> AUT is live"
