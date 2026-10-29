#!/usr/bin/env bash
# Prepare an exact public SDK candidate, preserving normal package metadata.
set -euo pipefail
revision=59343c200f9ea4aaaea07321a52baed3328ee4d4
root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/inkbox-sdk-${revision}"
if [[ ! -d "$root/source/.git" ]]; then
  mkdir -p "$root"
  git init -q "$root/source" >&2
  git -C "$root/source" remote add origin https://github.com/inkbox-ai/inkbox.git
  git -C "$root/source" fetch --depth 1 origin "$revision" >&2
  git -C "$root/source" checkout --detach FETCH_HEAD >&2
fi
[[ "$(git -C "$root/source" rev-parse HEAD)" == "$revision" ]]
archive="$root/inkbox-sdk-0.7.24.tgz"
if [[ ! -f "$archive" ]]; then
  (cd "$root/source/sdk/typescript" && npm ci --ignore-scripts >&2 && npm run build >&2 && npm pack --pack-destination "$root" >&2)
fi
[[ -f "$archive" ]]
# npm's lock resolution must see the candidate before the first npm ci.
cp package.json "$root/plugin-package-${GITHUB_JOB:-local}.json"
saved="$root/plugin-package-${GITHUB_JOB:-local}.json"
trap 'cp "$saved" package.json' EXIT
npm install --package-lock-only --ignore-scripts --no-audit --no-fund "$archive" >&2
cp "$saved" package.json
node --input-type=module -e 'import fs from "node:fs"; const lock=JSON.parse(fs.readFileSync("package-lock.json")); const pkg=JSON.parse(fs.readFileSync("package.json")); lock.packages[""].dependencies=pkg.dependencies; fs.writeFileSync("package-lock.json",JSON.stringify(lock,null,2)+"\n");'
if [[ -n "${GITHUB_ENV:-}" ]]; then printf 'INKBOX_SDK_PATH=%s\n' "$archive" >> "$GITHUB_ENV"; fi
printf '%s\n' "$archive"
