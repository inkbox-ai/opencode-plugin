#!/usr/bin/env bash
set -uo pipefail

# Node 22 bundles npm 10, whose resolver crashes walking vitest's peer set
# ("Cannot read properties of null (reading 'edgesOut')") on any `npm install <pkg>`.
if [ "$(npm --version | cut -d. -f1)" -lt 11 ]; then
  npm install -g npm@11.13.0
fi

attempts=4
last_status=1
for attempt in $(seq 1 "$attempts"); do
  if node "$(dirname "${BASH_SOURCE[0]}")/sdk-package.mjs" "$@"; then
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
