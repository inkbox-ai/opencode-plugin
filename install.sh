#!/usr/bin/env bash
# Inkbox for opencode — one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/inkbox-ai/opencode-plugin/main/install.sh | bash
#
# Clones (or updates) the plugin into ~/.inkbox-opencode/app, builds it,
# installs it into your global opencode config (~/.config/opencode) with a
# plugin wrapper, puts an `inkbox-opencode` launcher on your PATH, and runs
# the interactive setup wizard. From a local checkout, run ./install.sh — it
# uses the checkout in place. Re-running is safe: it updates and reinstalls.
# Flags: --no-setup (install only), --start (start the background gateway).
set -euo pipefail

RUN_SETUP=1
DO_START=0
for arg in "$@"; do
  case "$arg" in
    --no-setup) RUN_SETUP=0 ;;
    --start) DO_START=1 ;;
    *) printf 'unknown flag: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

REPO_SLUG="${INKBOX_OPENCODE_REPO:-inkbox-ai/opencode-plugin}"
REPO_BRANCH="${INKBOX_OPENCODE_BRANCH:-main}"
APP_DIR="${INKBOX_OPENCODE_APP_DIR:-$HOME/.inkbox-opencode/app}"
BIN_DIR="${INKBOX_OPENCODE_BIN_DIR:-$HOME/.local/bin}"
OPENCODE_CONFIG_DIR="${INKBOX_OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. prerequisites -------------------------------------------------------
command -v git >/dev/null 2>&1 || die "git is required."
command -v npm >/dev/null 2>&1 || die "npm is required (comes with Node)."
command -v node >/dev/null 2>&1 || die "Node.js 20+ is required."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' ||
  die "Node.js 20+ is required (found $(node --version))."
command -v opencode >/dev/null 2>&1 ||
  warn "the opencode CLI is not on PATH — install it (npm install -g opencode-ai); the gateway launches \`opencode serve\` and the plugin loads into opencode sessions."

# --- 2. source: local checkout, or clone/update the app dir -----------------
SOURCE_DIR=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd || true)"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ] &&
   grep -q '"name": "@inkbox/opencode-plugin"' "$SCRIPT_DIR/package.json" 2>/dev/null; then
  SOURCE_DIR="$SCRIPT_DIR"   # running from inside a checkout (not curl | bash)
  say "Using the local checkout at $SOURCE_DIR"
else
  if [ -d "$APP_DIR/.git" ]; then
    say "Updating $APP_DIR"
    git -C "$APP_DIR" fetch --quiet origin "$REPO_BRANCH"
    git -C "$APP_DIR" checkout --quiet "$REPO_BRANCH"
    git -C "$APP_DIR" reset --quiet --hard "origin/$REPO_BRANCH"
  else
    say "Cloning https://github.com/$REPO_SLUG into $APP_DIR"
    mkdir -p "$(dirname "$APP_DIR")"
    git clone --quiet --branch "$REPO_BRANCH" "https://github.com/$REPO_SLUG.git" "$APP_DIR"
  fi
  SOURCE_DIR="$APP_DIR"
fi

# --- 3. build + pack ---------------------------------------------------------
say "Installing dependencies and building"
(cd "$SOURCE_DIR" && npm install --silent --no-audit --no-fund && npm run -s build)
TARBALL="$SOURCE_DIR/$(cd "$SOURCE_DIR" && npm pack --silent | tail -1)"
[ -f "$TARBALL" ] || die "npm pack did not produce a tarball."

# --- 4. wire the plugin into the global opencode config ----------------------
say "Installing the plugin into $OPENCODE_CONFIG_DIR"
mkdir -p "$OPENCODE_CONFIG_DIR/plugins"
(cd "$OPENCODE_CONFIG_DIR" &&
  { [ -f package.json ] || npm init -y >/dev/null 2>&1; } &&
  npm install --silent --no-audit --no-fund --save "$TARBALL")

# The packaged channel agent, so gateway sessions find it from any project.
mkdir -p "$OPENCODE_CONFIG_DIR/agent"
if [ ! -f "$OPENCODE_CONFIG_DIR/agent/inkbox-channel.md" ]; then
  cp "$SOURCE_DIR/agents/inkbox-channel.md" "$OPENCODE_CONFIG_DIR/agent/"
  say "Installed the inkbox-channel agent definition"
fi

WRAPPER="$OPENCODE_CONFIG_DIR/plugins/inkbox.ts"
if [ -f "$WRAPPER" ]; then
  say "Keeping your existing plugin wrapper at $WRAPPER"
else
  cat > "$WRAPPER" <<'EOF'
// Inkbox plugin wrapper — written by install.sh; edit freely (never overwritten).
// Credentials resolve from env vars or ~/.inkbox/config; options: see README.
import InkboxPlugin from "@inkbox/opencode-plugin";

export default async (input: any) => InkboxPlugin(input, {});
EOF
  say "Wrote plugin wrapper $WRAPPER"
fi

# --- 5. launcher on PATH ------------------------------------------------------
mkdir -p "$BIN_DIR"
chmod +x "$SOURCE_DIR/bin/inkbox-opencode.js"
ln -sf "$SOURCE_DIR/bin/inkbox-opencode.js" "$BIN_DIR/inkbox-opencode"
say "Launcher: $BIN_DIR/inkbox-opencode"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH — add:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# --- 6. setup wizard ------------------------------------------------------------
LAUNCHER="$BIN_DIR/inkbox-opencode"
if [ "$RUN_SETUP" = "1" ]; then
  # Read prompts from the terminal even when this script is piped to bash.
  if [ -e /dev/tty ]; then
    say "Running the setup wizard"
    "$LAUNCHER" setup < /dev/tty ||
      warn "setup did not finish; rerun anytime: inkbox-opencode setup"
  else
    warn "No terminal available (piped). Finish setup yourself: inkbox-opencode setup"
  fi
else
  warn "Skipping setup (--no-setup). Run it later: inkbox-opencode setup"
fi

# --- done -----------------------------------------------------------------------
cat <<EOF

inkbox-opencode is installed.
  check:   inkbox-opencode doctor
  daemon:  inkbox-opencode start | status | stop
  boot:    inkbox-opencode autostart install
  Restart opencode — the Inkbox tools load in every session.

Docs: https://github.com/$REPO_SLUG#readme
EOF

if [ "$DO_START" = "1" ]; then
  say "Starting the background gateway"
  "$LAUNCHER" start || warn "Could not start; run 'inkbox-opencode doctor' then 'inkbox-opencode start'."
fi
