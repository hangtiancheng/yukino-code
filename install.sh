#!/usr/bin/env bash


set -euo pipefail

PACKAGE="@yukino.js/yukino"
NODE_REQUIREMENT="22.19+ (23.x requires 23.5+)"

info() { printf '\033[36m[info]\033[0m  %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m  %s\n' "$*"; }
err() { printf '\033[31m[err]\033[0m  %s\n' "$*" >&2; }
ok() { printf '\033[32m[ok]\033[0m  %s\n' "$*"; }

ACTION="install"
VERSION=""
TAG=""
for arg in "$@"; do
	case "$arg" in
	--uninstall) ACTION="uninstall" ;;
	--version=*) VERSION="${arg#--version=}" ;;
	--alpha) TAG="alpha" ;;
	--beta) TAG="beta" ;;
	--rc) TAG="rc" ;;
	--canary) TAG="canary" ;;
	--nightly) TAG="nightly" ;;
	--dev) TAG="dev" ;;
	--tag=*) TAG="${arg#--tag=}" ;;
	--help | -h)
		cat <<EOF
Usage: install.sh [OPTIONS]

  (default)    Install the latest stable yukino from npm
  --uninstall  Uninstall yukino
  --version=   Install a specific version (e.g. --version=0.1.0)
  --alpha      Install from the 'alpha' dist-tag
  --beta       Install from the 'beta' dist-tag
  --rc         Install from the 'rc' dist-tag
  --canary     Install from the 'canary' dist-tag
  --nightly    Install from the 'nightly' dist-tag
  --dev        Install from the 'dev' dist-tag
  --tag=NAME   Install from a custom npm dist-tag

Examples:
  curl -fsSL <url> | bash                           # latest stable
  curl -fsSL <url> | bash -s -- --canary            # canary build
  curl -fsSL <url> | bash -s -- --version=0.1.0     # specific version

Requires Node.js $NODE_REQUIREMENT and npm.
EOF
		exit 0
		;;
	*)
		err "Unknown option: $arg"
		exit 1
		;;
	esac
done

if [ "$ACTION" = "uninstall" ]; then
	info "Uninstalling $PACKAGE..."
	npm uninstall -g "$PACKAGE"
	ok "yukino uninstalled"
	exit 0
fi

CONFIG_DIR="$HOME/.yukino"
CONFIG_FILE="$CONFIG_DIR/config.yaml"
if [ -f "$CONFIG_FILE" ]; then
	info "Config already exists at $CONFIG_FILE."
else
	mkdir -p "$CONFIG_DIR"
	cat >"$CONFIG_FILE" <<'EOF'
permission_mode: default
providers: []
default_provider: 0
enable_memory: false
enable_coordinator_mode: false
code_mode:
  mode: off
  inline_budget: 12000
mcp_servers: []
hooks: []
sandbox:
  enabled: false
  auto_allow: false
  network_enabled: true
EOF
	ok "Wrote default config to $CONFIG_FILE"
fi

if ! command -v node >/dev/null 2>&1; then
	err "Node.js not found. Install Node.js $NODE_REQUIREMENT first:"
	err "  https://nodejs.org/  or  brew install node@24"
	exit 1
fi
NODE_VERSION="$(node -p 'process.versions.node')"
if ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 19) || typeof require("node:module").registerHooks !== "function") process.exit(1)'; then
	err "Node.js $NODE_VERSION detected, need $NODE_REQUIREMENT. Please upgrade."
	exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
	err "npm not found. It ships with Node.js — reinstall Node.js from https://nodejs.org/"
	exit 1
fi

if [ -n "$VERSION" ]; then
	VERSION="${VERSION#v}"
	PKG_VERSION="$PACKAGE@$VERSION"
elif [ -n "$TAG" ]; then
	PKG_VERSION="$PACKAGE@$TAG"
else
	PKG_VERSION="$PACKAGE@latest"
fi

info "Installing $PKG_VERSION globally..."
npm install -g "$PKG_VERSION" --registry=https://registry.npmjs.org/

NPM_BIN="$(npm config get prefix 2>/dev/null)/bin"
if command -v yukino >/dev/null 2>&1; then
	ok "Yukino installed successfully"
	YUKINO_VERSION="$(npm ls -g "$PACKAGE" --depth=0 2>/dev/null | grep -o "$PACKAGE@[^ ]*" | head -n1 || true)"
	[ -n "$YUKINO_VERSION" ] && info "Installed: $YUKINO_VERSION"
else
	warn "Installation completed but 'yukino' is not on your PATH."
	warn "Add npm's global bin to your shell profile (~/.bashrc / ~/.zshrc):"
	warn "  export PATH=\"$NPM_BIN:\$PATH\""
fi

ok 'Download Claude Code VSCode plugin and enjoy yukino!!!'
