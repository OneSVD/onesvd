#!/usr/bin/env bash
#
# install.sh — one-time installer for OneSVD (user-scoped, no root for the run
# lifecycle). It installs toolchains, fetches + builds the node, links the
# `onesvd` command onto your PATH, and hands off to `onesvd up`.
#
# Remote one-liner:
#   curl -fsSL https://sh.onesvd.com | bash
#
# Or from a checkout at the repo root:
#   ./install.sh
#
# Layout it creates (XDG, all under your home):
#   ~/.local/share/onesvd/       the source checkout + built binaries
#   ~/.local/bin/onesvd          symlink to onesvd-cli.sh (the CLI you use)
#   ~/.config/onesvd/config.yml  watched directory + ports
#
# After install, you drive everything through `onesvd` — run `onesvd help`.
# systemd (user services) is the execution layer underneath.

set -euo pipefail

# Remember where the user invoked us, BEFORE any cd. Used as the default watched
# directory, so `curl ... | bash` run from a project watches that project.
INVOKE_CWD="$PWD"

# ── paths (XDG, user-scoped) ──────────────────────────────────────────────────
ONESVD_HOME="${ONESVD_HOME:-$HOME/.local/share/onesvd}"   # source + builds
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"                    # the `onesvd` command
CONFIG_DIR="${CONFIG_DIR:-$HOME/.config/onesvd}"          # config.yml

# set to 1 by ensure_path when the current shell needs `onesvd` added to PATH
NEEDS_PATH_ACTIVATION=0

# ── repo / branch ─────────────────────────────────────────────────────────────
ONESVD_REPO="${ONESVD_REPO:-https://github.com/OneSVD/onesvd.git}"
ONESVD_BRANCH="${ONESVD_BRANCH:-main}"

GO_MIN="1.22"
NODE_MIN="18"

# ── logging ───────────────────────────────────────────────────────────────────
c_blue=$'\033[34m'; c_green=$'\033[32m'; c_red=$'\033[31m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
info() { echo "${c_blue}::${c_off} $*"; }
ok()   { echo "${c_green}ok${c_off} $*"; }
warn() { echo "${c_red}!!${c_off} $*" >&2; }
die()  { warn "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ── 1. toolchains (Go, Node, git) ─────────────────────────────────────────────
install_toolchains() {
  info "checking toolchains"
  if ! have apt-get; then
    warn "this installer targets Ubuntu/Debian (apt). Install Go >= $GO_MIN, Node >= $NODE_MIN, and git manually, then re-run."
    return 0
  fi
  local need=()
  have git  || need+=(git)
  have curl || need+=(curl)
  if [ "${#need[@]}" -gt 0 ]; then
    info "installing: ${need[*]} (sudo)"
    sudo apt-get update -y && sudo apt-get install -y "${need[@]}"
  fi
  if ! have go; then
    info "installing Go (sudo)"
    sudo apt-get install -y golang-go || die "could not install Go via apt; install Go >= $GO_MIN manually"
  fi
  have go && info "Go $(go version | awk '{print $3}' | sed 's/go//') detected"
  if ! have node; then
    info "installing Node.js LTS (sudo, via NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - || die "NodeSource setup failed; install Node >= $NODE_MIN manually"
    sudo apt-get install -y nodejs
  fi
  have node && info "Node $(node -v) detected"
  ok "toolchains ready"
}

# ── 2. fetch source into ONESVD_HOME ──────────────────────────────────────────
# If we're already running from inside a real checkout (worker/server/client
# sit next to this script), operate in place. Otherwise clone into ONESVD_HOME.
fetch_source() {
  local self="${BASH_SOURCE[0]:-}"
  if [ -n "$self" ] && [ -f "$self" ]; then
    local self_dir; self_dir="$(cd "$(dirname "$self")" && pwd)"
    if [ -d "$self_dir/worker" ] && [ -d "$self_dir/server" ] && [ -d "$self_dir/client" ]; then
      ONESVD_HOME="$self_dir"
      info "using existing checkout at $ONESVD_HOME"
      return 0
    fi
  fi
  have git || die "git is required to fetch the source"
  export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o StrictHostKeyChecking=accept-new}"
  if [ -d "$ONESVD_HOME/.git" ]; then
    info "updating source in $ONESVD_HOME"
    git -C "$ONESVD_HOME" fetch --depth 1 origin "$ONESVD_BRANCH"
    git -C "$ONESVD_HOME" checkout "$ONESVD_BRANCH"
    git -C "$ONESVD_HOME" reset --hard "origin/$ONESVD_BRANCH"
  else
    info "cloning $ONESVD_REPO -> $ONESVD_HOME"
    mkdir -p "$(dirname "$ONESVD_HOME")"
    git clone --depth 1 --branch "$ONESVD_BRANCH" "$ONESVD_REPO" "$ONESVD_HOME"
  fi
  ok "source ready in $ONESVD_HOME"
}

# ── 3. link the CLI onto PATH ──────────────────────────────────────────────────
link_cli() {
  [ -f "$ONESVD_HOME/onesvd-cli.sh" ] || die "onesvd-cli.sh not found in $ONESVD_HOME"
  mkdir -p "$BIN_DIR"
  chmod +x "$ONESVD_HOME/onesvd-cli.sh" 2>/dev/null || true
  ln -sf "$ONESVD_HOME/onesvd-cli.sh" "$BIN_DIR/onesvd"
  ok "linked onesvd -> $BIN_DIR/onesvd"
  ensure_path
}

# add BIN_DIR to PATH via the shell rc if it isn't already there, and write a
# small env file so the user can activate `onesvd` in the CURRENT shell with one
# copy-pasteable line (a script can't export into its parent shell directly).
ensure_path() {
  # always (re)write the env file — `source` it to get onesvd on PATH right now
  local env_file="$ONESVD_HOME/env"
  cat > "$env_file" <<EOF
# OneSVD — source this to put 'onesvd' on your PATH in the current shell:
#   source $env_file
export PATH="$BIN_DIR:\$PATH"
EOF

  # already on PATH? then there's nothing for the user to do
  case ":$PATH:" in
    *":$BIN_DIR:"*) return 0 ;;
  esac

  # persist for future shells via the shell rc
  local rc
  case "${SHELL##*/}" in
    zsh)  rc="$HOME/.zshrc" ;;
    bash) rc="$HOME/.bashrc" ;;
    *)    rc="$HOME/.profile" ;;
  esac
  if ! { [ -f "$rc" ] && grep -qF "$BIN_DIR" "$rc"; }; then
    {
      echo ""
      echo "# added by OneSVD installer"
      echo "export PATH=\"$BIN_DIR:\$PATH\""
    } >> "$rc"
    info "added $BIN_DIR to PATH in $rc (active in new terminals)"
  fi

  # flag that the current shell still needs activating, and how
  NEEDS_PATH_ACTIVATION=1
}

# Remove any previous config so `onesvd up` re-asks which directory to watch on
# every install. The installer stays idempotent — re-running just reconfigures
# from scratch (the watched dir is reconfirmed, units are rewritten).
reset_config() {
  if [ -f "$CONFIG_DIR/config.yml" ]; then
    info "clearing previous config for a fresh setup ($CONFIG_DIR/config.yml)"
    rm -f "$CONFIG_DIR/config.yml"
  fi
}

# ── run ────────────────────────────────────────────────────────────────────────
install_toolchains
fetch_source
link_cli
reset_config

info "handing off to: onesvd up"
echo
# pass the original invocation dir as the default watched directory for the
# first-run config write inside the CLI.
ONESVD_DEFAULT_WATCH_DIR="$INVOKE_CWD" "$ONESVD_HOME/onesvd-cli.sh" up

# Final step: a script can't change its parent shell's PATH, so if `onesvd`
# isn't reachable in THIS terminal yet, give the user one line to paste.
if [ "$NEEDS_PATH_ACTIVATION" = "1" ]; then
  echo
  echo "  ${c_green}One more step${c_off} — run this to use ${c_green}onesvd${c_off} in this terminal:"
  echo
  echo "      ${c_dim}source $ONESVD_HOME/env${c_off}"
  echo
  echo "  ${c_dim}(new terminals already have it; this is only for the one you're in.)${c_off}"
  echo
else
  echo
  ok "onesvd is on your PATH — try: onesvd status"
fi
