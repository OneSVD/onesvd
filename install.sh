#!/usr/bin/env bash
#
# install.sh — provision and run OneSVD (watcher + hub + frontend) on Ubuntu
#              via systemd, so the three services auto-restart and start on boot.
#
# LOCALHOST profile: plain HTTP, no nginx, no TLS, no auth token. Builds from
# source (no prebuilt binaries to host or trust). Generates systemd units and
# manages them with systemctl.
#
# Remote one-liner (clones the repo, then runs a full install):
#   curl -fsSL https://raw.githubusercontent.com/OneSVD/onesvd/main/install.sh | bash
#
# Or from a checkout at the repo root:
#   ./install.sh up
#
# By default it installs USER services (systemctl --user) — no root needed for
# the run lifecycle — and enables "linger" so they start at boot without a login.
# Pass ONESVD_SYSTEM=1 to install system-wide units in /etc/systemd/system
# (needs sudo; runs as the invoking user).
#
# Repo layout this expects (script sits at repo root):
#   onesvd/install.sh
#   onesvd/worker   → Go watcher  (main.go)
#   onesvd/server   → Node hub    (server.js)
#   onesvd/client   → Next.js app (frontend)
#
# Usage:
#   ./install.sh setup      install toolchains + dependencies (run once; may need sudo)
#   ./install.sh build      compile the Go watcher, install hub + frontend deps
#   ./install.sh install    write systemd units, enable + start them
#   ./install.sh uninstall  stop, disable, and remove the units
#   ./install.sh start|stop|restart|status   control the running services
#   ./install.sh logs       follow the journald logs for all three
#   ./install.sh up         setup + build + install (the one-shot path)
#   ./install.sh clone      just fetch the source into $ONESVD_INSTALL_DIR
#
# Configuration (env vars, all optional — localhost defaults):
#   ONESVD_ROOT          watched data dir            (default <repo>/onesvd-root)
#   ONESVD_HUB_PORT      hub WS+HTTP port            (default 4000)
#   ONESVD_INGEST_PORT   hub<-watcher loopback port  (default 4001)
#   ONESVD_FRONTEND_PORT Next.js port                (default 7777)
#   ONESVD_FRONTEND_MODE dev | prod                  (default prod)
#   ONESVD_SYSTEM        1 = system-wide units (sudo); default 0 = user units
#   ONESVD_REPO/_BRANCH  source repo + branch for the curl|bash bootstrap
#   ONESVD_INSTALL_DIR   where the bootstrap clones to (default ~/onesvd)
#   ONESVD_FOLLOW_LOGS   1 = tail logs after install (default 1; auto-off if non-tty)
#   WATCHER_DIR/HUB_DIR/FRONTEND_DIR  override component locations directly
#
# NOTE: production differs — add nginx + TLS, set ONESVD_TLS_KEY/CERT and
# ONESVD_PUBLIC_HOST for the hub, run the frontend in prod mode, and you'd
# likely use system-wide units with a dedicated service account.

set -euo pipefail

# ── locate self / detect bootstrap (curl | bash) mode ─────────────────────────
# When piped from curl, BASH_SOURCE isn't a real file in the repo, so we can't
# build from a local checkout. In that case we run the "bootstrap" path: clone
# the repo, then hand off to the copy of this script inside the checkout.
SELF="${BASH_SOURCE[0]:-}"
if [ -n "$SELF" ] && [ -f "$SELF" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
else
  SCRIPT_DIR=""   # piped / no real file → bootstrap mode
fi
[ -n "$SCRIPT_DIR" ] && cd "$SCRIPT_DIR"

# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  REPO / LAYOUT CONFIG — edit these to match your repository                ║
# ╚══════════════════════════════════════════════════════════════════════════╝
# Where to clone from when run via curl|bash, and which branch.
# HTTPS default so anyone can clone the public repo anonymously. Override with
# the git@github.com:OneSVD/onesvd.git form to use SSH (e.g. for authenticated pushes).
ONESVD_REPO="${ONESVD_REPO:-https://github.com/OneSVD/onesvd.git}"
ONESVD_BRANCH="${ONESVD_BRANCH:-main}"
ONESVD_INSTALL_DIR="${ONESVD_INSTALL_DIR:-$HOME/onesvd}"

# The three apps live at the repo root, in these folders:
#   <repo>/worker   → Go watcher  (main.go)
#   <repo>/server   → Node hub    (server.js)
#   <repo>/client   → Next.js app (frontend)
WATCHER_SUBDIR="${WATCHER_SUBDIR:-worker}"
HUB_SUBDIR="${HUB_SUBDIR:-server}"
FRONTEND_SUBDIR="${FRONTEND_SUBDIR:-client}"
# Name of THIS script as it exists at the repo root (used by the curl|bash
# bootstrap to find and hand off to the checked-out copy).
SCRIPT_NAME="${SCRIPT_NAME:-install.sh}"
# ──────────────────────────────────────────────────────────────────────────────

# ── runtime config with defaults (ports/modes safe in any mode) ───────────────
export ONESVD_HUB_PORT="${ONESVD_HUB_PORT:-4000}"
export ONESVD_INGEST_PORT="${ONESVD_INGEST_PORT:-4001}"
ONESVD_FRONTEND_PORT="${ONESVD_FRONTEND_PORT:-7777}"
ONESVD_FRONTEND_MODE="${ONESVD_FRONTEND_MODE:-prod}"
ONESVD_SYSTEM="${ONESVD_SYSTEM:-0}"

# Component paths are derived from where THIS script lives — but only in a real
# checkout. In bootstrap mode (SCRIPT_DIR empty) we leave them unset so the
# re-exec'd in-repo script computes them from its own location, rather than
# inheriting bogus paths from the piped invocation.
#
# The script is expected to sit at the repo root, alongside worker/, server/,
# and client/. WATCHER_DIR/HUB_DIR/FRONTEND_DIR can be overridden directly to
# point elsewhere.
if [ -n "$SCRIPT_DIR" ]; then
  export ONESVD_ROOT="${ONESVD_ROOT:-$SCRIPT_DIR/onesvd-root}"
  WATCHER_DIR="${WATCHER_DIR:-$SCRIPT_DIR/$WATCHER_SUBDIR}"
  HUB_DIR="${HUB_DIR:-$SCRIPT_DIR/$HUB_SUBDIR}"
  FRONTEND_DIR="${FRONTEND_DIR:-$SCRIPT_DIR/$FRONTEND_SUBDIR}"
fi

# the frontend derives the hub URL from window.location at runtime; the hub port
# is passed at build time so it knows which port to reach.
export NEXT_PUBLIC_ONESVD_HUB_PORT="$ONESVD_HUB_PORT"

GO_MIN="1.22"
NODE_MIN="18"

# ── pretty logging ────────────────────────────────────────────────────────────
c_blue=$'\033[34m'; c_green=$'\033[32m'; c_red=$'\033[31m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
info()  { echo "${c_blue}::${c_off} $*"; }
ok()    { echo "${c_green}ok${c_off} $*"; }
warn()  { echo "${c_red}!!${c_off} $*" >&2; }
die()   { warn "$*"; exit 1; }
have()  { command -v "$1" >/dev/null 2>&1; }

# ── systemd scope: user units (default) vs system units ───────────────────────
SERVICES=(onesvd-hub onesvd-watcher onesvd-frontend)

if [ "$ONESVD_SYSTEM" = "1" ]; then
  UNIT_DIR="/etc/systemd/system"
  SCTL=(sudo systemctl)
  JCTL=(sudo journalctl)
  RUN_AS_USER="$(id -un)"   # system units run as the invoking user (not root)
else
  UNIT_DIR="$HOME/.config/systemd/user"
  SCTL=(systemctl --user)
  JCTL=(journalctl --user)
  RUN_AS_USER=""
fi

require_systemd() {
  have systemctl || die "systemd not found. This installer manages services via systemctl."
}

# ── remote bootstrap: clone the repo, then run its own install.sh ─────────────
# Used when the script is piped from curl (no local checkout). Idempotent: if the
# install dir already has a checkout it pulls latest instead of re-cloning.
cmd_clone() {
  have git || { info "installing git (sudo)"; sudo apt-get update -y && sudo apt-get install -y git; }
  # accept GitHub's host key on first contact so an SSH clone doesn't hang on the
  # "authenticity of host" prompt (key is recorded to known_hosts, not skipped).
  # Harmless for the default HTTPS clone; only matters if ONESVD_REPO is an SSH URL.
  export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o StrictHostKeyChecking=accept-new}"
  if [ -d "$ONESVD_INSTALL_DIR/.git" ]; then
    info "updating existing checkout in $ONESVD_INSTALL_DIR"
    git -C "$ONESVD_INSTALL_DIR" fetch --depth 1 origin "$ONESVD_BRANCH"
    git -C "$ONESVD_INSTALL_DIR" checkout "$ONESVD_BRANCH"
    git -C "$ONESVD_INSTALL_DIR" reset --hard "origin/$ONESVD_BRANCH"
  else
    info "cloning $ONESVD_REPO -> $ONESVD_INSTALL_DIR"
    git clone --depth 1 --branch "$ONESVD_BRANCH" "$ONESVD_REPO" "$ONESVD_INSTALL_DIR"
  fi
  ok "source ready in $ONESVD_INSTALL_DIR"
}

# clone (if needed) then re-exec the checked-out script with the requested action.
# Passes through all ONESVD_* env so a piped one-liner can still configure ports.
bootstrap() {
  local action="${1:-up}"
  cmd_clone
  local inner="$ONESVD_INSTALL_DIR/$SCRIPT_NAME"
  [ -f "$inner" ] || die "expected $inner in the repo but it's missing (set SCRIPT_NAME)"
  chmod +x "$inner" 2>/dev/null || true
  info "handing off to $inner $action"
  exec "$inner" "$action"
}

# ── port preflight ────────────────────────────────────────────────────────────
port_busy() {
  if have ss; then ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
  elif have lsof; then lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else return 1
  fi
}
check_ports() {
  local clash=0
  for p in "$ONESVD_HUB_PORT" "$ONESVD_INGEST_PORT" "$ONESVD_FRONTEND_PORT"; do
    if port_busy "$p"; then warn "port $p is already in use"; clash=1; fi
  done
  [ "$clash" -eq 0 ] || die "free the port(s) above or set ONESVD_*_PORT, then retry"
}

# best-effort primary LAN IPv4 of this host (for the "Network" URL line)
lan_ip() {
  local ip=""
  if have ip; then
    # the source address the kernel would use to reach a public host
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
  fi
  if [ -z "$ip" ] && have hostname; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  echo "$ip"
}

# wait until $1 accepts TCP connections (frontend can take a few seconds to boot,
# especially next dev). Returns 0 once ready, 1 after ~timeout seconds.
wait_for_port() {
  local port="$1"; local tries="${2:-40}"  # ~20s at 0.5s steps
  local i=0
  while [ "$i" -lt "$tries" ]; do
    if have ss && ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN; then return 0; fi
    if ! have ss && have curl && curl -sf -o /dev/null "http://127.0.0.1:$port" 2>/dev/null; then return 0; fi
    sleep 0.5; i=$((i+1))
  done
  return 1
}

# Next.js-style readiness banner with Local + Network URLs
ready_banner() {
  local ip; ip="$(lan_ip)"
  echo
  echo "  ${c_green}▲ OneSVD${c_off}  WebUI ready"
  echo
  echo "  - Local:    ${c_green}http://localhost:$ONESVD_FRONTEND_PORT${c_off}"
  if [ -n "$ip" ]; then
    echo "  - Network:  ${c_green}http://$ip:$ONESVD_FRONTEND_PORT${c_off}"
  fi
  echo
  echo "  ${c_dim}hub   ws://localhost:$ONESVD_HUB_PORT${c_off}"
  echo "  ${c_dim}data  $ONESVD_ROOT${c_off}"
  echo "  ${c_dim}logs  $0 logs    status  $0 status${c_off}"
  echo
}

# ── setup: install toolchains ─────────────────────────────────────────────────
cmd_setup() {
  info "checking toolchains"
  if ! have apt-get; then
    warn "this installer targets Ubuntu/Debian (apt). Install Go >= $GO_MIN, Node >= $NODE_MIN, git manually, then: $0 build"
    return 0
  fi
  local need_apt=()
  have git  || need_apt+=(git)
  have curl || need_apt+=(curl)
  if [ "${#need_apt[@]}" -gt 0 ]; then
    info "installing: ${need_apt[*]} (sudo)"
    sudo apt-get update -y
    sudo apt-get install -y "${need_apt[@]}"
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

# ── build ─────────────────────────────────────────────────────────────────────
cmd_build() {
  have go   || die "Go not found — run: $0 setup"
  have node || die "Node not found — run: $0 setup"
  [ -f "$WATCHER_DIR/main.go" ] || die "no main.go in $WATCHER_DIR (set WATCHER_DIR)"
  [ -f "$HUB_DIR/server.js" ]   || die "no server.js in $HUB_DIR (set HUB_DIR)"
  [ -d "$FRONTEND_DIR" ]        || die "no frontend in $FRONTEND_DIR (set FRONTEND_DIR)"

  info "building Go watcher"
  ( cd "$WATCHER_DIR"
    [ -f go.mod ] || go mod init onesvd-watcher
    go get github.com/fsnotify/fsnotify@v1.7.0
    go build -o onesvd-watcher .
  )
  ok "watcher built -> $WATCHER_DIR/onesvd-watcher"

  info "installing hub dependencies"
  ( cd "$HUB_DIR"
    [ -f package.json ] || npm init -y >/dev/null 2>&1
    npm install ws busboy
    npm install archiver 2>/dev/null || true
  )
  ok "hub deps installed"

  info "installing frontend dependencies"
  ( cd "$FRONTEND_DIR"; npm install )
  if [ "$ONESVD_FRONTEND_MODE" = "prod" ]; then
    info "building frontend (production)"
    ( cd "$FRONTEND_DIR"; npm run build )
  fi
  ok "frontend ready ($ONESVD_FRONTEND_MODE mode)"
}

# ── unit generation ───────────────────────────────────────────────────────────
node_bin() { command -v node; }
npx_bin()  { command -v npx; }

# emit one [Service] User= line only for system units
user_line() { [ -n "$RUN_AS_USER" ] && echo "User=$RUN_AS_USER"; }

# the shared environment every unit needs
env_lines() {
  cat <<EOF
Environment=ONESVD_ROOT=$ONESVD_ROOT
Environment=ONESVD_HUB_PORT=$ONESVD_HUB_PORT
Environment=ONESVD_INGEST_PORT=$ONESVD_INGEST_PORT
Environment=NEXT_PUBLIC_ONESVD_HUB_PORT=$ONESVD_HUB_PORT
EOF
}

write_units() {
  mkdir -p "$UNIT_DIR" "$ONESVD_ROOT"
  local NODE; NODE="$(node_bin)"; local NPX; NPX="$(npx_bin)"
  [ -n "$NODE" ] || die "node not found on PATH"

  info "writing units to $UNIT_DIR"

  # hub — start first; others depend on it being up
  cat > "$UNIT_DIR/onesvd-hub.service" <<EOF
[Unit]
Description=OneSVD hub (WebSocket + HTTP)
After=network.target

[Service]
Type=simple
$(user_line)
WorkingDirectory=$HUB_DIR
$(env_lines)
ExecStart=$NODE $HUB_DIR/server.js
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF

  # watcher — wants the hub up first so its first publish lands
  cat > "$UNIT_DIR/onesvd-watcher.service" <<EOF
[Unit]
Description=OneSVD filesystem watcher
After=onesvd-hub.service
Wants=onesvd-hub.service

[Service]
Type=simple
$(user_line)
WorkingDirectory=$WATCHER_DIR
$(env_lines)
ExecStart=$WATCHER_DIR/onesvd-watcher
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF

  # frontend — Next.js dev or prod
  local FE_EXEC
  if [ "$ONESVD_FRONTEND_MODE" = "prod" ]; then
    FE_EXEC="$NPX next start -p $ONESVD_FRONTEND_PORT"
  else
    FE_EXEC="$NPX next dev -p $ONESVD_FRONTEND_PORT"
  fi
  cat > "$UNIT_DIR/onesvd-frontend.service" <<EOF
[Unit]
Description=OneSVD frontend (Next.js, $ONESVD_FRONTEND_MODE)
After=onesvd-hub.service
Wants=onesvd-hub.service

[Service]
Type=simple
$(user_line)
WorkingDirectory=$FRONTEND_DIR
$(env_lines)
ExecStart=$FE_EXEC
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF

  ok "units written"
}

# ── install: write units, reload, enable + start ──────────────────────────────
cmd_install() {
  require_systemd
  [ -x "$WATCHER_DIR/onesvd-watcher" ] || die "watcher not built — run: $0 build"
  # prod mode runs `next start`, which needs a prior production build. If the
  # build output is missing (e.g. deps installed but never built), build now.
  if [ "$ONESVD_FRONTEND_MODE" = "prod" ] && [ ! -d "$FRONTEND_DIR/.next" ]; then
    info "no production build found — building frontend"
    ( cd "$FRONTEND_DIR"; npm run build )
  fi
  # idempotency: stop any of OUR previously-installed services first, so a
  # re-run reclaims its own 4000/4001/7777 instead of colliding with itself.
  # (units get rewritten below; a missing unit here is a harmless no-op.)
  if "${SCTL[@]}" list-unit-files "onesvd-*.service" >/dev/null 2>&1; then
    info "stopping any existing OneSVD services"
    "${SCTL[@]}" stop "${SERVICES[@]}" 2>/dev/null || true
    # give the kernel a moment to release the listening sockets before we check
    for _ in 1 2 3 4 5 6; do
      if ! port_busy "$ONESVD_HUB_PORT" && ! port_busy "$ONESVD_FRONTEND_PORT"; then break; fi
      sleep 0.5
    done
  fi

  check_ports
  write_units

  "${SCTL[@]}" daemon-reload

  # user units: enable linger so they run at boot without an active login
  if [ "$ONESVD_SYSTEM" != "1" ]; then
    if have loginctl; then
      info "enabling linger so services start at boot"
      sudo loginctl enable-linger "$(id -un)" 2>/dev/null || warn "could not enable linger (services will start on next login instead)"
    fi
  fi

  info "enabling + starting services"
  "${SCTL[@]}" enable --now "${SERVICES[@]}"

  info "waiting for the WebUI to come up on :$ONESVD_FRONTEND_PORT"
  if wait_for_port "$ONESVD_FRONTEND_PORT"; then
    ready_banner
  else
    warn "WebUI didn't answer on :$ONESVD_FRONTEND_PORT yet — it may still be compiling."
    echo "   check:  $0 logs"
    echo "   then:   http://localhost:$ONESVD_FRONTEND_PORT"
  fi

  # finish by following the live logs, unless disabled or running non-interactively
  # (e.g. piped/CI), where blocking on a tail -f would hang the caller.
  if [ "${ONESVD_FOLLOW_LOGS:-1}" = "1" ] && [ -t 1 ]; then
    echo "  ${c_dim}(following logs — ctrl-c to detach; services keep running)${c_off}"
    echo
    cmd_logs
  fi
}

cmd_uninstall() {
  require_systemd
  info "stopping + disabling services"
  "${SCTL[@]}" disable --now "${SERVICES[@]}" 2>/dev/null || true
  for s in "${SERVICES[@]}"; do rm -f "$UNIT_DIR/$s.service"; done
  "${SCTL[@]}" daemon-reload
  ok "units removed (data in $ONESVD_ROOT left intact)"
}

cmd_start()   { require_systemd; "${SCTL[@]}" start   "${SERVICES[@]}"; ok "started"; }
cmd_stop()    { require_systemd; "${SCTL[@]}" stop    "${SERVICES[@]}"; ok "stopped"; }
cmd_restart() { require_systemd; "${SCTL[@]}" restart "${SERVICES[@]}"; ok "restarted"; }

cmd_status() {
  require_systemd
  for s in "${SERVICES[@]}"; do
    if "${SCTL[@]}" is-active --quiet "$s"; then
      echo "  ${c_green}●${c_off} $s  ${c_dim}($("${SCTL[@]}" is-enabled "$s" 2>/dev/null))${c_off}"
    else
      echo "  ${c_dim}○ $s  (inactive)${c_off}"
    fi
  done
}

cmd_logs() {
  require_systemd
  info "following journald logs (ctrl-c to stop)"
  "${JCTL[@]}" -f -n 30 -u onesvd-hub -u onesvd-watcher -u onesvd-frontend
}

# ── dispatch ──────────────────────────────────────────────────────────────────
ACTION="${1:-up}"

# Bootstrap mode: piped from curl with no local checkout. Clone, then re-exec the
# in-repo script with the requested action (defaulting to a full `up`).
if [ -z "$SCRIPT_DIR" ]; then
  case "$ACTION" in
    clone) cmd_clone ;;            # just fetch the source, don't run
    *)     bootstrap "$ACTION" ;;  # clone + hand off (up/install/build/...)
  esac
  exit 0
fi

case "$ACTION" in
  clone)     cmd_clone ;;
  setup)     cmd_setup ;;
  build)     cmd_build ;;
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  up)        cmd_setup; cmd_build; cmd_install ;;
  *)
    echo "OneSVD launcher (systemd)"
    echo "usage: $0 {clone|setup|build|install|uninstall|start|stop|restart|status|logs|up}"
    echo "  up    = setup + build + install (first-run one-shot)"
    echo "  clone = fetch source into \$ONESVD_INSTALL_DIR (${ONESVD_INSTALL_DIR})"
    echo "  set ONESVD_SYSTEM=1 for system-wide units (sudo); default is user units"
    exit 1
    ;;
esac
