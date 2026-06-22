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
cmd_build() {
  have go   || die "Go not found — re-run install.sh to set up toolchains"
  have node || die "Node not found — re-run install.sh to set up toolchains"
  [ -f "$WATCHER_DIR/main.go" ] || die "no main.go in $WATCHER_DIR"
  [ -f "$HUB_DIR/server.js" ]   || die "no server.js in $HUB_DIR"
  [ -d "$FRONTEND_DIR" ]        || die "no client in $FRONTEND_DIR"
  local mode; mode="$(cval frontend_mode prod)"

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
  local watch_dir hub_port ingest_port frontend_port frontend_mode node npx fe_exec
  watch_dir="$(cval watch_dir "$PWD")"
  hub_port="$(cval hub_port 4000)"
  ingest_port="$(cval ingest_port 4001)"
  frontend_port="$(cval frontend_port 7777)"
  frontend_mode="$(cval frontend_mode prod)"
  node="$(command -v node)"; npx="$(command -v npx)"
  [ -n "$node" ] || die "node not found on PATH"

  mkdir -p "$UNIT_DIR" "$watch_dir"
  info "writing units to $UNIT_DIR"

  cat > "$UNIT_DIR/onesvd-hub.service" <<EOF
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

[Install]
WantedBy=default.target
EOF

  cat > "$UNIT_DIR/onesvd-watcher.service" <<EOF
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

[Install]
WantedBy=default.target
EOF

  if [ "$frontend_mode" = "prod" ]; then
    fe_exec="$npx next start -p $frontend_port"
  else
    fe_exec="$npx next dev -p $frontend_port"
  fi
  cat > "$UNIT_DIR/onesvd-frontend.service" <<EOF
[Unit]
Description=OneSVD frontend (Next.js, $frontend_mode)
After=onesvd-hub.service
Wants=onesvd-hub.service

[Service]
Type=simple
WorkingDirectory=$FRONTEND_DIR
Environment=NEXT_PUBLIC_ONESVD_HUB_PORT=$hub_port
ExecStart=$fe_exec
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF

  ok "units written (watching $watch_dir)"
}

# build only what's missing, given the current config
build_if_needed() {
  local mode; mode="$(cval frontend_mode prod)"
  local need=0
  [ -x "$WATCHER_DIR/onesvd-watcher" ] || need=1
  [ -d "$HUB_DIR/node_modules" ]       || need=1
  [ -d "$FRONTEND_DIR/node_modules" ]  || need=1
  [ "$mode" = "prod" ] && [ ! -d "$FRONTEND_DIR/.next" ] && need=1
  if [ "$need" -eq 1 ]; then
    info "building (first run or missing artifacts)"
    cmd_build
  fi
}

# ── lifecycle ─────────────────────────────────────────────────────────────────
cmd_up() {
  require_systemd
  ensure_config
  build_if_needed
  [ -x "$WATCHER_DIR/onesvd-watcher" ] || die "watcher not built — run: onesvd build"

  # reclaim our own ports if a previous run is up
  if "${SCTL[@]}" list-unit-files "onesvd-*.service" >/dev/null 2>&1; then
    info "stopping any existing OneSVD services"
    "${SCTL[@]}" stop "${SERVICES[@]}" 2>/dev/null || true
    for _ in 1 2 3 4 5 6; do
      port_busy "$(cval hub_port 4000)" || port_busy "$(cval frontend_port 7777)" || break
      sleep 0.5
    done
  fi

  check_ports
  write_units
  "${SCTL[@]}" daemon-reload

  if have loginctl; then
    info "enabling linger so services start at boot"
    sudo loginctl enable-linger "$(id -un)" 2>/dev/null || warn "could not enable linger (services start on next login instead)"
  fi

  info "enabling + starting services"
  "${SCTL[@]}" enable --now "${SERVICES[@]}"

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
