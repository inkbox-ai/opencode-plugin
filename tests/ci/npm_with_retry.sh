#!/usr/bin/env bash
set -uo pipefail

# Node 22 bundles npm 10, whose resolver crashes walking vitest's peer set
# ("Cannot read properties of null (reading 'edgesOut')") on any `npm install <pkg>`.
if [ "$(npm --version | cut -d. -f1)" -lt 11 ]; then
  npm install -g npm@11.13.0
fi

command=(npm "$@")
if [ "${1:-}" = "ci" ]; then
  command=(pnpm install --frozen-lockfile)
elif [ "${1:-}" = "install" ] && [[ " $* " != *" -g "* ]]; then
  shift
  packages=()
  for arg in "$@"; do
    case "$arg" in --no-save|--package-lock=false) continue ;; esac
    packages+=("$arg")
  done
  # Explicit compatibility jobs replace the source override in their disposable checkout.
  node --input-type=module - "${packages[@]}" <<'JS'
import {readFileSync, writeFileSync} from 'node:fs';
const sdk = process.argv.slice(2).find(arg => arg.startsWith('@inkbox/sdk@'));
if (sdk) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  pkg.pnpm.overrides['@inkbox/sdk'] = sdk.slice('@inkbox/sdk@'.length);
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
}
JS
  command=(pnpm add --ignore-scripts "${packages[@]}")
fi

attempts=4
last_status=1
for attempt in $(seq 1 "$attempts"); do
  if "${command[@]}"; then
    exit 0
  else
    last_status=$?
  fi
  if [ "$attempt" -lt "$attempts" ]; then
    echo "::warning::npm setup attempt $attempt failed; retrying"
    sleep $((attempt * 3))
  fi
done

echo "::error::npm setup failed after $attempts attempts"
exit "$last_status"
