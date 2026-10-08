#!/usr/bin/env bash
# End-to-end install smoke test: pack the plugin, install the tarball into a
# throwaway opencode project, and load it through opencode's real plugin
# loader (Bun runtime, real dependency resolution). Verifies what unit tests
# cannot: the default-export shape, package resolution, and that the tool map
# registers under the actual host.
#
# Requires the `opencode` CLI on PATH. Exits non-zero on any failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${SMOKE_PORT:-14096}"
MODEL_PORT="${SMOKE_MODEL_PORT:-14098}"
WORKDIR="$(mktemp -d)"
SMOKE_STATE_DIR="$(mktemp -d)"
# Minimum/latest hosts must never share or migrate the operator's native database.
export XDG_DATA_HOME="$SMOKE_STATE_DIR/xdg-data"
export XDG_CONFIG_HOME="$SMOKE_STATE_DIR/xdg-config"
export XDG_CACHE_HOME="$SMOKE_STATE_DIR/xdg-cache"
export XDG_STATE_HOME="$SMOKE_STATE_DIR/xdg-state"
MARKER="$WORKDIR/loaded.json"
cleanup() {
  kill "${MOCK_PID:-}" "${SERVE_PID:-}" 2>/dev/null || true
  wait "${MOCK_PID:-}" "${SERVE_PID:-}" 2>/dev/null || true
  rm -rf "$WORKDIR" "$SMOKE_STATE_DIR"
}
trap cleanup EXIT

command -v opencode >/dev/null || { echo "SKIP: opencode CLI not installed"; exit 0; }

echo "==> building and packing"
cd "$ROOT"
npm run -s build
TARBALL="$ROOT/$(npm pack --silent | tail -1)"

echo "==> creating throwaway project in $WORKDIR"
cd "$WORKDIR"
git init -q .
printf 'node_modules/\nnative-*-state/\nslack-upload.json\n' > .gitignore
git -c user.name='Synthetic fixture' -c user.email='fixture@example.test' commit -q --allow-empty -m 'Synthetic native host fixture'
npm init -y >/dev/null
if [ -n "${INKBOX_SDK_PATH:-}" ]; then
  npm install --silent "$INKBOX_SDK_PATH" "$TARBALL"
else
  npm install --silent "$TARBALL"
fi

mkdir -p .opencode/plugins
# The wrapper loads the packaged plugin exactly as opencode would, then drops
# a marker recording the registered tool names so this script can assert on it.
cat > .opencode/plugins/smoke.ts <<EOF
import InkboxPlugin from "@inkbox/opencode-plugin";
import { writeFileSync } from "node:fs";

export default async (input: any) => {
  const hooks = await InkboxPlugin(input, { gateway: { enabled: false, slackEnabled: true, imessageThreadedReplies: true }, tools: { enable: ["inkbox_credentials_get_secret"] } });
  writeFileSync("$MARKER", JSON.stringify({ tools: Object.keys(hooks.tool ?? {}) }));
  // Synthetic host contract: real native tool context + real plugin upload helper,
  // with an in-memory provider boundary. Never touches a real identity or Slack workspace.
  const { uploadSlackFile } = await import("$WORKDIR/node_modules/@inkbox/opencode-plugin/dist/slack-upload.js");
  const { createStateStore } = await import("$WORKDIR/node_modules/@inkbox/opencode-plugin/dist/gateway/state.js");
  hooks.tool.inkbox_slack_upload_file.execute = async (args: any, ctx: any) => {
    const result = await uploadSlackFile({
      opencode: input.client, store: createStateStore("$WORKDIR/native-slack-state"), enabled: () => true, approve: async () => {},
      runtime: { getIdentity: async () => ({ id: "synthetic-identity" }), getClient: async () => ({ slack: {
        listConnections: async () => ({ connections: [{ id: "connection", identityId: "synthetic-identity", status: "connected", workspaceId: "TWORKSPACE" }] }),
        uploadFile: async (_connection: string, request: any) => {
          await new Promise((resolve) => setTimeout(resolve, 800));
          writeFileSync("$WORKDIR/slack-upload.json", JSON.stringify(request));
          return { id: "upload-operation", status: "succeeded", fileId: "FUPLOAD", connectionId: "connection", conversationId: "CROOM" };
        }
      } }) } as any
    }, args, ctx);
    return JSON.stringify(result);
  };
  return hooks;
};
EOF

cat > opencode.json <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": { "mock": {
    "npm": "@ai-sdk/openai-compatible", "name": "Synthetic transport fixture",
    "options": { "baseURL": "http://127.0.0.1:$MODEL_PORT/v1" },
    "models": { "mock-model": { "name": "mock-model" } }
  } }
}
EOF

node "$ROOT/tests/live/mock-openai.mjs" "$MODEL_PORT" >"$WORKDIR/model.log" 2>&1 &
MOCK_PID=$!

echo "==> starting opencode serve on port $PORT"
opencode serve --port "$PORT" >"$WORKDIR/serve.log" 2>&1 &
SERVE_PID=$!
sleep 2
# Plugin loading is lazy — the first project-scoped API request triggers it.
curl -s -m 30 "http://127.0.0.1:$PORT/session?directory=$WORKDIR" >/dev/null || true

for _ in $(seq 1 60); do
  [ -f "$MARKER" ] && break
  kill -0 "$SERVE_PID" 2>/dev/null || { echo "FAIL: opencode serve exited early"; cat "$WORKDIR/serve.log"; exit 1; }
  sleep 1
done

[ -f "$MARKER" ] || { echo "FAIL: plugin never loaded (no marker after 60s)"; cat "$WORKDIR/serve.log"; exit 1; }

TOOLS=$(node -e "const m=require('$MARKER'); console.log(m.tools.length); if(!m.tools.includes('inkbox_send_email')||!m.tools.includes('inkbox_doctor')||m.tools.filter(t=>t.startsWith('inkbox_slack_')).length!==8||!m.tools.includes('inkbox_get_imessage_thread')||!m.tools.includes('inkbox_credentials_get_secret')) process.exit(1);")
echo "==> plugin loaded with $TOOLS tools registered"

if grep -i "inkbox" "$WORKDIR/serve.log" | grep -iq "error"; then
  echo "FAIL: serve log mentions an inkbox error"
  grep -i "inkbox" "$WORKDIR/serve.log"
  exit 1
fi

echo "==> checking durable messaging against the real native host"
node "$ROOT/scripts/native-host-contract.mjs" "$WORKDIR" "$PORT"
node "$ROOT/scripts/native-permission-contract.mjs" "$WORKDIR" "$PORT"
node "$ROOT/scripts/native-permission-handoff-contract.mjs" "$WORKDIR" "$PORT"
node "$ROOT/scripts/native-slack-contract.mjs" "$WORKDIR" "$PORT" "$MODEL_PORT"
echo "PASS: loader smoke and native messaging contract"
