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
WORKDIR="$(mktemp -d)"
MARKER="$WORKDIR/loaded.json"
trap 'kill "${SERVE_PID:-}" 2>/dev/null || true; rm -rf "$WORKDIR"' EXIT

command -v opencode >/dev/null || { echo "SKIP: opencode CLI not installed"; exit 0; }

echo "==> building and packing"
cd "$ROOT"
npm run -s build
TARBALL="$ROOT/$(npm pack --silent | tail -1)"

echo "==> creating throwaway project in $WORKDIR"
cd "$WORKDIR"
git init -q .
npm init -y >/dev/null
npm install --silent "$TARBALL"

mkdir -p .opencode/plugins
# The wrapper loads the packaged plugin exactly as opencode would, then drops
# a marker recording the registered tool names so this script can assert on it.
cat > .opencode/plugins/smoke.ts <<EOF
import InkboxPlugin from "@inkbox/opencode-plugin";
import { writeFileSync } from "node:fs";

export default async (input: any) => {
  const hooks = await InkboxPlugin(input, {});
  writeFileSync("$MARKER", JSON.stringify({ tools: Object.keys(hooks.tool ?? {}) }));
  return hooks;
};
EOF

cat > opencode.json <<EOF
{ "\$schema": "https://opencode.ai/config.json" }
EOF

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

TOOLS=$(node -e "const m=require('$MARKER'); console.log(m.tools.length); if(!m.tools.includes('inkbox_send_email')||!m.tools.includes('inkbox_doctor')) process.exit(1);")
echo "==> plugin loaded with $TOOLS tools registered"

if grep -i "inkbox" "$WORKDIR/serve.log" | grep -iq "error"; then
  echo "FAIL: serve log mentions an inkbox error"
  grep -i "inkbox" "$WORKDIR/serve.log"
  exit 1
fi

echo "PASS: loader smoke test"
