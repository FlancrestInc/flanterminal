#!/bin/sh
set -eu

compose=${COMPOSE_FILE:-docker-compose.yml}
project=${COMPOSE_PROJECT_NAME:-flanterminal_verify}
: "${HOST_PORT:=3101}"
export HOST_PORT
fixture=.phase1-container-fixture
secret=PHASE1_SECRET_NOT_IN_LOGS
hold_pid=
hold_log=
hold_stop=/tmp/.flanterminal-verify-hold-stop

case $# in
  0) check=all ;;
  2)
    [ "$1" = --check ] && [ "$2" = hardening ] || {
      printf 'usage: %s [--check hardening]\n' "$0" >&2
      exit 2
    }
    check=hardening
    ;;
  *)
    printf 'usage: %s [--check hardening]\n' "$0" >&2
    exit 2
    ;;
esac

cleanup() {
  if [ -n "$hold_pid" ]; then
    kill "$hold_pid" >/dev/null 2>&1 || true
    wait "$hold_pid" >/dev/null 2>&1 || true
  fi
  [ -z "$hold_log" ] || rm -f "$hold_log"
  docker compose -p "$project" -f "$compose" exec -T app rm -f "$hold_stop" \
    >/dev/null 2>&1 || true
  docker compose -p "$project" -f "$compose" down >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

fail() {
  printf 'container verification failed: %s\n' "$1" >&2
  exit 1
}

ws_probe() {
  command=$1
  expected=$2
  docker compose -p "$project" -f "$compose" exec -T app \
    node --input-type=module - "$command" "$expected" <<'NODE'
import WebSocket from 'ws';

const command = process.argv[2];
const expected = process.argv[3];
const origin = process.env.APP_PUBLIC_URL;
const base = process.env.APP_BASE_PATH === '/' ? '' : process.env.APP_BASE_PATH;
const socket = new WebSocket(
  `ws://127.0.0.1:${process.env.APP_PORT}${base}/ws/sessions/phase-1-main`,
  { headers: { Origin: origin } },
);
let output = '';
const timeout = setTimeout(() => {
  socket.terminate();
  process.exitCode = 1;
}, 10_000);
socket.on('open', () => {
  socket.send(JSON.stringify({
    v: 1,
    type: 'resize',
    sessionId: 'phase-1-main',
    cols: 80,
    rows: 24,
  }));
});
socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type === 'ready') {
    socket.send(JSON.stringify({
      v: 1,
      type: 'input',
      sessionId: 'phase-1-main',
      data: `${command}\r`,
    }));
  } else if (message.type === 'output') {
    output += message.data;
    if (output.includes(expected)) socket.close(1000, 'verified');
  }
});
socket.on('close', () => {
  clearTimeout(timeout);
  if (!output.includes(expected)) process.exitCode = 1;
});
socket.on('error', () => {
  clearTimeout(timeout);
  process.exitCode = 1;
});
NODE
}

ws_hold_open() {
  docker compose -p "$project" -f "$compose" exec -T app \
    node --input-type=module - "$hold_stop" <<'NODE'
import { existsSync } from 'node:fs';
import WebSocket from 'ws';

const stopFile = process.argv[2];
const origin = process.env.APP_PUBLIC_URL;
const base = process.env.APP_BASE_PATH === '/' ? '' : process.env.APP_BASE_PATH;
const socket = new WebSocket(
  `ws://127.0.0.1:${process.env.APP_PORT}${base}/ws/sessions/phase-1-main`,
  { headers: { Origin: origin } },
);
const timeout = setTimeout(() => process.exit(1), 30_000);
const stopCheck = setInterval(() => {
  if (existsSync(stopFile)) socket.close(1000, 'verified');
}, 100);
socket.on('open', () => {
  socket.send(JSON.stringify({
    v: 1,
    type: 'resize',
    sessionId: 'phase-1-main',
    cols: 80,
    rows: 24,
  }));
});
socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type === 'ready') {
    process.stdout.write('BRIDGE_READY\n');
  }
});
socket.on('error', () => process.exit(1));
process.on('SIGTERM', () => socket.close(1000, 'verified'));
socket.on('close', () => {
  clearInterval(stopCheck);
  clearTimeout(timeout);
  process.exit(0);
});
NODE
}

printf 'checking: hardening\n'
[ -f Dockerfile ] || fail 'hardening checks fail: Dockerfile is unavailable'
rg -q "JetBrainsMonoNerdFont-Regular.ttf" apps/client/src/theme.css \
  || fail 'bundled font unavailable'

docker compose -p "$project" -f "$compose" config --quiet
docker compose -p "$project" -f "$compose" up -d --build --wait
container=$(docker compose -p "$project" -f "$compose" ps -q app)
[ -n "$container" ] || fail 'app container is unavailable'
[ "$(docker inspect -f '{{.Config.User}}' "$container")" = webterm ] || fail 'server user is not webterm'
[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$container")" = true ] || fail 'root filesystem is writable'
[ "$(docker inspect -f '{{.HostConfig.Privileged}}' "$container")" = false ] || fail 'container is privileged'
[ "$(docker inspect -f '{{.HostConfig.PidsLimit}}' "$container")" = 128 ] || fail 'pids limit is not 128'
[ "$(docker inspect -f '{{.HostConfig.Memory}}' "$container")" = 268435456 ] || fail 'memory limit is not 256MiB'
[ "$(docker inspect -f '{{json .HostConfig.CapAdd}}' "$container")" = null ] || fail 'capabilities were added'
[ "$(docker inspect -f '{{json .HostConfig.CapDrop}}' "$container")" = '["ALL"]' ] || fail 'capabilities were not dropped'
docker inspect -f '{{json .HostConfig.SecurityOpt}}' "$container" | rg -q 'no-new-privileges' \
  || fail 'no-new-privileges is unavailable'
docker inspect -f '{{range .Mounts}}{{println .Destination}}{{end}}' "$container" | rg -q '^/var/run/docker.sock$' && fail 'Docker socket mounted'
docker compose -p "$project" -f "$compose" exec -T app sh -c '! test -w /app && test -w "$HOME"'
printf 'hardening checks passed\n'
[ "$check" = all ] || exit 0

printf 'checking: runtime\n'
health=$(docker compose -p "$project" -f "$compose" exec -T app node -e \
  "fetch('http://127.0.0.1:' + process.env.APP_PORT + '/health').then(r=>r.json()).then(v=>process.stdout.write(JSON.stringify(v)))")
ready=$(docker compose -p "$project" -f "$compose" exec -T app node -e \
  "fetch('http://127.0.0.1:' + process.env.APP_PORT + '/ready').then(r=>r.json()).then(v=>process.stdout.write(JSON.stringify(v)))")
printf '%s' "$health" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);if(v.status!=='ok')process.exit(1)})"
printf '%s' "$ready" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);if(v.status!=='ready'||v.ready!==true)process.exit(1)})"

docker compose -p "$project" -f "$compose" exec -T app sh -c \
  'command -v tmux >/dev/null && command -v ssh >/dev/null && [ "$(id -u)" -ne 0 ] && [ "$(id -un)" = webterm ]'

count_bridges='count=0; for process in /proc/[0-9]*/cmdline; do command=$(tr "\000" " " < "$process" 2>/dev/null || true); case "$command" in *"tmux attach-session"*) count=$((count + 1));; esac; done; printf "%s" "$count"'
baseline=$(docker compose -p "$project" -f "$compose" exec -T app sh -c "$count_bridges")
docker compose -p "$project" -f "$compose" exec -T app rm -f "$hold_stop"
hold_log=$(mktemp)
ws_hold_open >"$hold_log" 2>/dev/null &
hold_pid=$!
attempt=0
while ! rg -q '^BRIDGE_READY$' "$hold_log"; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 100 ] || fail 'hold-open WebSocket did not become ready'
  kill -0 "$hold_pid" 2>/dev/null || fail 'hold-open WebSocket exited early'
  sleep 0.1
done
live_bridges=$(docker compose -p "$project" -f "$compose" exec -T app sh -c "$count_bridges")
[ "$live_bridges" -eq "$((baseline + 1))" ] || fail 'live PTY bridge process is unavailable'
bridge_pids=$(docker compose -p "$project" -f "$compose" exec -T app sh -c \
  'for process in /proc/[0-9]*/cmdline; do command=$(tr "\000" " " < "$process" 2>/dev/null || true); case "$command" in "/usr/bin/tmux attach-session "*) basename "$(dirname "$process")";; esac; done')
[ -n "$bridge_pids" ] || fail 'live PTY bridge PID is unavailable'
[ "$(printf '%s\n' "$bridge_pids" | wc -l)" -eq 1 ] || fail 'live PTY bridge PID is ambiguous'
docker compose -p "$project" -f "$compose" exec -T app sh -c \
  "test \"\$(awk '/^Uid:/ { print \$2 }' /proc/$bridge_pids/status)\" = \"\$(id -u)\"" \
  || fail 'live PTY bridge does not use the configured runtime UID'
docker compose -p "$project" -f "$compose" exec -T app touch "$hold_stop"
wait "$hold_pid"
hold_pid=
docker compose -p "$project" -f "$compose" exec -T app rm -f "$hold_stop"
rm -f "$hold_log"
hold_log=
attempt=0
while [ "$(docker compose -p "$project" -f "$compose" exec -T app sh -c "$count_bridges")" != "$baseline" ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 50 ] || fail 'PTY bridge leaked after hold-open WebSocket disconnect'
  sleep 0.1
done
ws_probe "export PHASE1_MARKER=$secret; printf 'MARKER_SET\\n'" MARKER_SET
sleep 1
after_disconnect=$(docker compose -p "$project" -f "$compose" exec -T app sh -c "$count_bridges")
[ "$after_disconnect" = "$baseline" ] || fail 'PTY bridge leaked after WebSocket disconnect'
docker compose -p "$project" -f "$compose" exec -T app tmux has-session -t webterm-phase-1-main
pane_pid=$(docker compose -p "$project" -f "$compose" exec -T app \
  tmux display-message -p -t webterm-phase-1-main '#{pane_pid}')
docker compose -p "$project" -f "$compose" exec -T app sh -c \
  "test \"\$(awk '/^Uid:/ { print \$2 }' /proc/$pane_pid/status)\" = \"\$(id -u)\"" \
  || fail 'tmux shell does not use the configured runtime UID'
[ "$(docker compose -p "$project" -f "$compose" exec -T app tmux show-options -gv history-limit)" = 20000 ] \
  || fail 'tmux global history-limit is not 20000'
[ "$(docker compose -p "$project" -f "$compose" exec -T app tmux display-message -p -t webterm-phase-1-main '#{history_limit}')" = 20000 ] \
  || fail 'initial pane history-limit is not 20000'
ws_probe "printf 'MARKER_RESTORED_%s\\n' \"\$PHASE1_MARKER\"" "MARKER_RESTORED_$secret"

docker compose -p "$project" -f "$compose" exec -T app sh -c "printf '%s' '$secret' > \"\$HOME/$fixture\""
docker compose -p "$project" -f "$compose" up -d --wait --force-recreate
docker compose -p "$project" -f "$compose" exec -T app sh -c "test \"\$(cat \"\$HOME/$fixture\")\" = '$secret'"
docker compose -p "$project" -f "$compose" exec -T app rm -f "/home/webterm/$fixture"
docker compose -p "$project" -f "$compose" logs | rg -q "$secret" && fail 'terminal marker leaked to logs'

printf 'container verification passed\n'
