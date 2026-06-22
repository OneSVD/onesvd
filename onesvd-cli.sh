#!/usr/bin/env bash
#
# onesvd-cli.sh — the `onesvd` command. Manages the OneSVD node (watcher + hub +
# frontend) through user systemd services, plus the watched-directory config.
#
# Installed as a symlink at ~/.local/bin/onesvd by install.sh. The source tree +
# built binaries live next to this script (~/.local/share/onesvd by default).
# Config lives at ~/.config/onesvd/config.yml.
#
#   onesvd help

set -euo pipefail

# ── locate the source tree (this script sits at its root) ─────────────────────
# readlink -f resolves the ~/.local/bin/onesvd symlink back to the real file.
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
ONESVD_HOME="$(cd "$(dirname "$SELF")" && pwd)"
WATCHER_DIR="$ONESVD_HOME/worker"
HUB_DIR="$ONESVD_HOME/server"
FRONTEND_DIR="$ONESVD_HOME/client"

# ── config (flat key: value YAML, Solana-style) ───────────────────────────────
CONFIG_DIR="${ONESVD_CONFIG_DIR:-$HOME/.config/onesvd}"
CONFIG_FILE="$CONFIG_DIR/config.yml"
VALID_KEYS="watch_dir hub_port ingest_port frontend_port frontend_mode"

# defaults used only when writing a fresh config
DEF_WATCH_DIR="${ONESVD_DEFAULT_WATCH_DIR:-$PWD}"
DEF_HUB_PORT="4000"
DEF_INGEST_PORT="4001"
DEF_FRONTEND_PORT="7777"
DEF_FRONTEND_MODE="prod"

# ── systemd (user scope) ──────────────────────────────────────────────────────
UNIT_DIR="$HOME/.config/systemd/user"
SERVICES=(onesvd-hub onesvd-watcher onesvd-frontend)
SCTL=(systemctl --user)
JCTL=(journalctl --user)

# ── logging ───────────────────────────────────────────────────────────────────
c_blue=$'\033[34m'; c_green=$'\033[32m'; c_red=$'\033[31m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
info() { echo "${c_blue}::${c_off} $*"; }
ok()   { echo "${c_green}ok${c_off} $*"; }
warn() { echo "${c_red}!!${c_off} $*" >&2; }
die()  { warn "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
require_systemd() { have systemctl || die "systemd not found; OneSVD manages services via 'systemctl --user'."; }

# ── config helpers ────────────────────────────────────────────────────────────
ensure_config() {
  [ -f "$CONFIG_FILE" ] && return 0
  mkdir -p "$CONFIG_DIR"
  local wd; wd="$(cd "$DEF_WATCH_DIR" 2>/dev/null && pwd || echo "$DEF_WATCH_DIR")"
  cat > "$CONFIG_FILE" <<EOF
# OneSVD configuration — edit with 'onesvd config set <key> <value>'
watch_dir: $wd
hub_port: $DEF_HUB_PORT
ingest_port: $DEF_INGEST_PORT
frontend_port: $DEF_FRONTEND_PORT
frontend_mode: $DEF_FRONTEND_MODE
EOF
  ok "wrote config $CONFIG_FILE"
  info "watching: $wd  ${c_dim}(change with: onesvd dir <path>)${c_off}"
}

cfg_get() {
  [ -f "$CONFIG_FILE" ] || return 0
  sed -n "s/^$1:[[:space:]]*//p" "$CONFIG_FILE" | head -n1
}

cfg_set() {
  ensure_config
  local key="$1" val="$2"
  if grep -qE "^${key}:" "$CONFIG_FILE"; then
    sed -i "s|^${key}:.*|${key}: ${val}|" "$CONFIG_FILE"   # | delim: paths have /
  else
    echo "${key}: ${val}" >> "$CONFIG_FILE"
  fi
}

is_valid_key() {
  local k="$1" v
  for v in $VALID_KEYS; do [ "$k" = "$v" ] && return 0; done
  return 1
}

# read a config value with a fallback default
cval() {
  local v; v="$(cfg_get "$1")"
  [ -n "$v" ] && echo "$v" || echo "$2"
}

# ── port + readiness helpers ──────────────────────────────────────────────────
port_busy() {
  if have ss; then ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
  elif have lsof; then lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else return 1; fi
}
check_ports() {
  local clash=0 p
  for p in "$(cval hub_port 4000)" "$(cval ingest_port 4001)" "$(cval frontend_port 7777)"; do
    if port_busy "$p"; then warn "port $p is already in use"; clash=1; fi
  done
  [ "$clash" -eq 0 ] || die "free the port(s) above or change them with 'onesvd config set', then retry"
}
lan_ip() {
  local ip=""
  if have ip; then ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"; fi
  if [ -z "$ip" ] && have hostname; then ip="$(hostname -I 2>/dev/null | awk '{print $1}')"; fi
  echo "$ip"
}
wait_for_port() {
  local port="$1" tries="${2:-40}" i=0
  while [ "$i" -lt "$tries" ]; do
    if have ss && ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN; then return 0; fi
    if ! have ss && have curl && curl -sf -o /dev/null "http://127.0.0.1:$port" 2>/dev/null; then return 0; fi
    sleep 0.5; i=$((i+1))
  done
  return 1
}
ready_banner() {
  local ip fp hp wd; ip="$(lan_ip)"; fp="$(cval frontend_port 7777)"; hp="$(cval hub_port 4000)"; wd="$(cval watch_dir "$PWD")"
  echo
  echo "  ${c_green}▲ OneSVD${c_off}  WebUI ready"
  echo
  echo "  - Local:    ${c_green}http://localhost:$fp${c_off}"
  [ -n "$ip" ] && echo "  - Network:  ${c_green}http://$ip:$fp${c_off}"
  echo
  echo "  ${c_dim}hub      ws://localhost:$hp${c_off}"
  echo "  ${c_dim}watching $wd${c_off}"
  echo "  ${c_dim}logs     onesvd logs     status  onesvd status${c_off}"
  echo
}

# ── build ─────────────────────────────────────────────────────────────────────
# A content fingerprint of the source we're about to build: sha256 over every
# file in client + server + worker (excluding generated artifacts), then a
# sha256 of that list. Deterministic — same source, same hash.
compute_build_hash() {
  { find "$FRONTEND_DIR" "$HUB_DIR" "$WATCHER_DIR" -type f \
      -not -path '*/node_modules/*' -not -path '*/.next/*' -not -path '*/.git/*' \
      -not -name 'onesvd-watcher' \
      -print0 2>/dev/null | LC_ALL=C sort -z | xargs -0 sha256sum 2>/dev/null; } \
    | sha256sum | awk '{print $1}'
}

cmd_build() {
  have go   || die "Go not found — re-run install.sh to set up toolchains"
  have node || die "Node not found — re-run install.sh to set up toolchains"
  [ -f "$WATCHER_DIR/main.go" ] || die "no main.go in $WATCHER_DIR"
  [ -f "$HUB_DIR/server.js" ]   || die "no server.js in $HUB_DIR"
  [ -d "$FRONTEND_DIR" ]        || die "no client in $FRONTEND_DIR"
  local mode; mode="$(cval frontend_mode prod)"

  # fingerprint the source and inject it so the client can show which build is
  # running. Exported here so 'next build' inlines NEXT_PUBLIC_ONESVD_BUILD_HASH;
  # also saved to .build-hash so write_units can pass it to dev-mode runtime.
  local build_hash; build_hash="$(compute_build_hash)"
  echo "$build_hash" > "$ONESVD_HOME/.build-hash"
  export NEXT_PUBLIC_ONESVD_BUILD_HASH="$build_hash"
  info "build fingerprint ${build_hash:0:12}  ${c_dim}(sha256 of client+server+worker)${c_off}"

  info "building Go watcher"
  ( cd "$WATCHER_DIR"
    [ -f go.mod ] || go mod init onesvd-watcher
    go get github.com/fsnotify/fsnotify@v1.7.0
    go build -o onesvd-watcher .
  )
  ok "watcher built"

  info "installing hub dependencies"
  ( cd "$HUB_DIR"
    [ -f package.json ] || npm init -y >/dev/null 2>&1
    npm install ws busboy
    npm install archiver 2>/dev/null || true
  )
  ok "hub deps installed"

  info "installing frontend dependencies"
  ( cd "$FRONTEND_DIR"; npm install )
  if [ "$mode" = "prod" ]; then
    info "building frontend (production)"
    ( cd "$FRONTEND_DIR"; npm run build )
  fi
  ok "frontend ready ($mode)"
}

# ── systemd unit generation ───────────────────────────────────────────────────
write_units() {
  ensure_config
  local watch_dir hub_port ingest_port frontend_port frontend_mode node npx fe_exec build_hash
  watch_dir="$(cval watch_dir "$PWD")"
  hub_port="$(cval hub_port 4000)"
  ingest_port="$(cval ingest_port 4001)"
  frontend_port="$(cval frontend_port 7777)"
  frontend_mode="$(cval frontend_mode prod)"
  build_hash=""; [ -f "$ONESVD_HOME/.build-hash" ] && build_hash="$(cat "$ONESVD_HOME/.build-hash")"
  node="$(command -v node)"; npx="$(command -v npx)"
  [ -n "$node" ] || die "node not found on PATH"

  mkdir -p "$UNIT_DIR" "$watch_dir"
  info "writing units to $UNIT_DIR"

  # render into a temp dir first so we can tell whether anything actually
  # changed — that decides whether cmd_up needs to restart at all.
  local tmp; tmp="$(mktemp -d)"

  cat > "$tmp/onesvd-hub.service" <<EOF
[Unit]
Description=OneSVD hub (WebSocket + HTTP)
After=network.target

[Service]
Type=simple
WorkingDirectory=$HUB_DIR
Environment=ONESVD_ROOT=$watch_dir
Environment=ONESVD_HUB_PORT=$hub_port
Environment=ONESVD_INGEST_PORT=$ingest_port
Environment=NEXT_PUBLIC_ONESVD_HUB_PORT=$hub_port
ExecStart=$node $HUB_DIR/server.js
Restart=on-failure
RestartSec=2
TimeoutStopSec=10

[Install]
WantedBy=default.target
EOF

  cat > "$tmp/onesvd-watcher.service" <<EOF
[Unit]
Description=OneSVD filesystem watcher
After=onesvd-hub.service
Wants=onesvd-hub.service

[Service]
Type=simple
WorkingDirectory=$WATCHER_DIR
Environment=ONESVD_ROOT=$watch_dir
Environment=ONESVD_HUB_PORT=$hub_port
Environment=ONESVD_INGEST_PORT=$ingest_port
ExecStart=$WATCHER_DIR/onesvd-watcher
Restart=on-failure
RestartSec=2
TimeoutStopSec=10

[Install]
WantedBy=default.target
EOF

  if [ "$frontend_mode" = "prod" ]; then
    fe_exec="$npx next start -p $frontend_port"
  else
    fe_exec="$npx next dev -p $frontend_port"
  fi
  cat > "$tmp/onesvd-frontend.service" <<EOF
[Unit]
Description=OneSVD frontend (Next.js, $frontend_mode)
After=onesvd-hub.service
Wants=onesvd-hub.service

[Service]
Type=simple
WorkingDirectory=$FRONTEND_DIR
Environment=NEXT_PUBLIC_ONESVD_HUB_PORT=$hub_port
Environment=NEXT_PUBLIC_ONESVD_BUILD_HASH=$build_hash
ExecStart=$fe_exec
Restart=on-failure
RestartSec=2
TimeoutStopSec=10

[Install]
WantedBy=default.target
EOF

  # install the rendered units, noting whether any content actually changed
  UNITS_CHANGED=0
  local s
  for s in "${SERVICES[@]}"; do
    if ! cmp -s "$tmp/$s.service" "$UNIT_DIR/$s.service" 2>/dev/null; then
      UNITS_CHANGED=1
    fi
    cp "$tmp/$s.service" "$UNIT_DIR/$s.service"
  done
  rm -rf "$tmp"

  ok "units written (watching $watch_dir)"
}

# build only what's missing, given the current config
build_if_needed() {
  DID_BUILD=0
  local mode; mode="$(cval frontend_mode prod)"
  local need=0
  [ -x "$WATCHER_DIR/onesvd-watcher" ] || need=1
  [ -d "$HUB_DIR/node_modules" ]       || need=1
  [ -d "$FRONTEND_DIR/node_modules" ]  || need=1
  [ "$mode" = "prod" ] && [ ! -d "$FRONTEND_DIR/.next" ] && need=1

  # also rebuild when the source fingerprint differs from what we last built —
  # this is what catches a `git pull` that changed files but left artifacts in
  # place. The fingerprint doubles as the build's change-detector.
  local cur prev=""; cur="$(compute_build_hash)"
  [ -f "$ONESVD_HOME/.build-hash" ] && prev="$(cat "$ONESVD_HOME/.build-hash")"
  if [ "$need" -eq 0 ] && [ "$cur" != "$prev" ]; then
    need=1
    info "source changed since last build (${cur:0:12}) — rebuilding"
  fi

  if [ "$need" -eq 1 ]; then
    DID_BUILD=1
    info "building (first run, missing artifacts, or source changed)"
    cmd_build
  else
    info "build up to date (${cur:0:12})"
  fi
}

# ── lifecycle ─────────────────────────────────────────────────────────────────
# Enable systemd "linger" so the services keep running with no active login and
# start at boot — essential for a headless/always-on box. This is the one step
# that needs root, so we explain *why* up front instead of surprising the user
# with a password prompt. Skipped automatically if linger is already on, if
# loginctl is missing, or if ONESVD_NO_LINGER=1 (for unattended installs).
enable_linger() {
  have loginctl || return 0
  local user; user="$(id -un)"

  # already lingering? nothing to do, no password needed.
  if loginctl show-user "$user" 2>/dev/null | grep -q '^Linger=yes'; then
    info "linger already enabled (services run without an active login)"
    return 0
  fi

  if [ "${ONESVD_NO_LINGER:-0}" = "1" ]; then
    warn "skipping linger (ONESVD_NO_LINGER=1) — services start on next login, not at boot"
    info "enable it later with:  sudo loginctl enable-linger $user"
    return 0
  fi

  echo
  info "sudo password needed once to enable systemd persistence"
  if sudo loginctl enable-linger "$user"; then
    ok "linger enabled — OneSVD will run headless and start at boot"
  else
    warn "linger not enabled — services start on next login instead of at boot"
    info "you can enable it later with:  sudo loginctl enable-linger $user"
  fi
}

# On first run (no config yet), confirm the directory to watch. Defaults to where
# the installer was launched. Reads from /dev/tty so it still works under
# `curl ... | bash` (where stdin is the piped script, not the keyboard). If
# there's no terminal to ask, it silently keeps the default.
choose_watch_dir() {
  local target; target="$(cd "$DEF_WATCH_DIR" 2>/dev/null && pwd || echo "$DEF_WATCH_DIR")"
  DEF_WATCH_DIR="$target"

  [ -e /dev/tty ] || return 0   # no terminal → keep default, don't block

  local ans=""
  echo
  printf "  Watch this directory for changes?\n    %s\n  [Y/n] " "$target"
  if ! read -r ans < /dev/tty 2>/dev/null; then echo; return 0; fi

  case "$ans" in
    [nN]*)
      local custom=""
      printf "  Enter the directory to watch: "
      read -r custom < /dev/tty 2>/dev/null || custom=""
      custom="${custom/#\~/$HOME}"
      [ -n "$custom" ] && DEF_WATCH_DIR="$(cd "$custom" 2>/dev/null && pwd || echo "$custom")"
      ;;
  esac
  ok "watching: $DEF_WATCH_DIR"
}

cmd_up() {
  require_systemd
  [ -f "$CONFIG_FILE" ] || choose_watch_dir   # first run: confirm the watched dir
  ensure_config
  build_if_needed
  [ -x "$WATCHER_DIR/onesvd-watcher" ] || die "watcher not built — run: onesvd build"

  write_units
  "${SCTL[@]}" daemon-reload
  enable_linger
  "${SCTL[@]}" enable "${SERVICES[@]}" >/dev/null 2>&1 || true   # start at boot

  # No explicit stop: start if nothing's running, restart only when the build or
  # the unit files actually changed, otherwise leave the services running as-is.
  if ! running; then
    info "starting services"
    "${SCTL[@]}" start "${SERVICES[@]}"
  elif [ "${DID_BUILD:-0}" = "1" ] || [ "${UNITS_CHANGED:-0}" = "1" ]; then
    info "applying changes — restarting services"
    "${SCTL[@]}" restart "${SERVICES[@]}"
  else
    info "no changes — services left running"
  fi

  local fp; fp="$(cval frontend_port 7777)"
  info "waiting for the WebUI on :$fp"
  if wait_for_port "$fp"; then ready_banner; else
    warn "WebUI didn't answer on :$fp yet — it may still be compiling."
    echo "   check:  onesvd logs"
  fi
}

# rewrite units + restart after a config change, when services are running
reapply() {
  if [ "$(cval frontend_mode prod)" = "prod" ] && [ ! -d "$FRONTEND_DIR/.next" ]; then
    info "building frontend (prod)"; ( cd "$FRONTEND_DIR"; npm run build )
  fi
  write_units
  "${SCTL[@]}" daemon-reload
  "${SCTL[@]}" restart "${SERVICES[@]}"
  ok "restarted"
}

running() { "${SCTL[@]}" is-active --quiet onesvd-hub 2>/dev/null; }

cmd_start()   { require_systemd; "${SCTL[@]}" start   "${SERVICES[@]}"; ok "started"; }
cmd_stop()    { require_systemd; "${SCTL[@]}" stop    "${SERVICES[@]}"; ok "stopped"; }
cmd_restart() { require_systemd; "${SCTL[@]}" restart "${SERVICES[@]}"; ok "restarted"; }

cmd_status() {
  require_systemd
  local s
  for s in "${SERVICES[@]}"; do
    if "${SCTL[@]}" is-active --quiet "$s"; then
      echo "  ${c_green}●${c_off} $s  ${c_dim}($("${SCTL[@]}" is-enabled "$s" 2>/dev/null))${c_off}"
    else
      echo "  ${c_dim}○ $s  (inactive)${c_off}"
    fi
  done
  echo "  ${c_dim}watching $(cval watch_dir "$PWD")${c_off}"
}

cmd_logs() {
  require_systemd
  info "following journald logs (ctrl-c to stop)"
  "${JCTL[@]}" -f -n 30 -u onesvd-hub -u onesvd-watcher -u onesvd-frontend
}

cmd_uninstall() {
  require_systemd
  info "stopping + disabling services"
  "${SCTL[@]}" disable --now "${SERVICES[@]}" 2>/dev/null || true
  local s; for s in "${SERVICES[@]}"; do rm -f "$UNIT_DIR/$s.service"; done
  "${SCTL[@]}" daemon-reload
  ok "services removed (config at $CONFIG_FILE and your data left intact)"
}

# ── watched directory ─────────────────────────────────────────────────────────
cmd_dir() {
  ensure_config
  if [ "$#" -eq 0 ]; then
    cval watch_dir "$PWD"
    return 0
  fi
  local new; new="$(cd "$1" 2>/dev/null && pwd || echo "$1")"
  cfg_set watch_dir "$new"
  ok "watch_dir set to $new"
  if running; then
    info "applying — rewriting units and restarting"
    reapply
  else
    info "saved — run 'onesvd up' to start watching it"
  fi
}

# ── config get/set ────────────────────────────────────────────────────────────
cmd_config() {
  ensure_config
  local sub="${1:-show}"
  case "$sub" in
    show)
      cat "$CONFIG_FILE"
      ;;
    get)
      local key="${2:-}"
      [ -n "$key" ] || die "usage: onesvd config get <key>"
      is_valid_key "$key" || die "unknown key '$key' (valid: $VALID_KEYS)"
      cval "$key" ""
      ;;
    set)
      local key="${2:-}" val="${3:-}"
      [ -n "$key" ] && [ -n "$val" ] || die "usage: onesvd config set <key> <value>"
      is_valid_key "$key" || die "unknown key '$key' (valid: $VALID_KEYS)"
      [ "$key" = "watch_dir" ] && val="$(cd "$val" 2>/dev/null && pwd || echo "$val")"
      cfg_set "$key" "$val"
      ok "$key = $val"
      if running; then
        info "applying — rewriting units and restarting"
        reapply
      else
        info "saved — run 'onesvd up' to apply"
      fi
      ;;
    *)
      die "usage: onesvd config [show | get <key> | set <key> <value>]"
      ;;
  esac
}

cmd_version() {
  local v="dev"
  if have git && [ -d "$ONESVD_HOME/.git" ]; then
    v="$(git -C "$ONESVD_HOME" describe --tags --always 2>/dev/null || git -C "$ONESVD_HOME" rev-parse --short HEAD 2>/dev/null || echo dev)"
  fi
  echo "onesvd $v"
}

cmd_help() {
  cat <<EOF
onesvd — manage your OneSVD node

usage: onesvd <command> [args]

  up                       build if needed, then install + start the services
  start | stop | restart   control the running services
  status                   show service status + watched directory
  logs                     follow logs for all three services
  build                    (re)build the watcher, hub, and frontend
  dir [PATH]               show the watched directory, or set it (restarts if running)
  config                   print the current config
  config get <key>         print one config value
  config set <key> <val>   change a config value (restarts if running)
  uninstall                stop + remove services (config + data kept)
  version                  print version
  help                     show this help

config keys : $VALID_KEYS
config file : $CONFIG_FILE
source      : $ONESVD_HOME
EOF
}

# ── dispatch ──────────────────────────────────────────────────────────────────
ACTION="${1:-help}"; shift 2>/dev/null || true
case "$ACTION" in
  up)                 cmd_up ;;
  start)              cmd_start ;;
  stop)               cmd_stop ;;
  restart)            cmd_restart ;;
  status)             cmd_status ;;
  logs)               cmd_logs ;;
  build)              cmd_build ;;
  dir)                cmd_dir "$@" ;;
  config)             cmd_config "$@" ;;
  uninstall)          cmd_uninstall ;;
  version|-v|--version) cmd_version ;;
  help|-h|--help)     cmd_help ;;
  *) warn "unknown command: $ACTION"; echo; cmd_help; exit 1 ;;
esac
