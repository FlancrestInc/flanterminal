#!/bin/sh
set -eu

compose=${COMPOSE_FILE:-docker-compose.yml}
project=${COMPOSE_PROJECT_NAME:-flanterminal_verify}
: "${HOST_PORT:=3101}"
: "${SESSION_MAX_COUNT:=20}"
export HOST_PORT SESSION_MAX_COUNT
secret=PHASE2_SECRET_NOT_IN_LOGS
hold_pid=
hold_log=
hold_stop=/tmp/.flanterminal-verify-stop

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

dc() {
  docker compose -p "$project" -f "$compose" "$@"
}

cleanup() {
  if [ -n "$hold_pid" ]; then
    kill "$hold_pid" >/dev/null 2>&1 || true
    wait "$hold_pid" >/dev/null 2>&1 || true
  fi
  [ -z "$hold_log" ] || rm -f "$hold_log"
  dc exec -T app rm -f "$hold_stop" >/dev/null 2>&1 || true
  dc down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

fail() {
  printf 'container verification failed: %s\n' "$1" >&2
  exit 1
}

api() {
  method=$1
  path=$2
  body=${3-}
  dc exec -T app node --input-type=module - "$method" "$path" "$body" <<'NODE'
const [method, path, body] = process.argv.slice(2);
const base = process.env.APP_BASE_PATH === '/' ? '' : process.env.APP_BASE_PATH;
const response = await fetch(`http://127.0.0.1:${process.env.APP_PORT}${base}${path}`, {
  method,
  headers: method === 'GET' || method === 'DELETE' ? {} : {
    Origin: process.env.APP_PUBLIC_URL,
    'Content-Type': 'application/json',
  },
  ...(body === '' ? {} : { body }),
});
const text = await response.text();
process.stdout.write(JSON.stringify({ status: response.status, body: text === '' ? null : JSON.parse(text) }));
NODE
}

tab_ids() {
  api GET /api/tabs | node -e \
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const t of JSON.parse(s).body.tabs)console.log(t.id)})"
}

tmux_name() {
  printf 'webterm-tab-%s' "$(printf '%s' "$1" | tr -d '-')"
}

ws_probe() {
  session_id=$1
  command=$2
  expected=$3
  dc exec -T app node --input-type=module - "$session_id" "$command" "$expected" <<'NODE'
import WebSocket from 'ws';

const [sessionId, command, expected] = process.argv.slice(2);
const base = process.env.APP_BASE_PATH === '/' ? '' : process.env.APP_BASE_PATH;
const socket = new WebSocket(
  `ws://127.0.0.1:${process.env.APP_PORT}${base}/ws/sessions/${sessionId}`,
  { headers: { Origin: process.env.APP_PUBLIC_URL } },
);
let output = '';
const timeout = setTimeout(() => socket.terminate(), 10_000);
socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type === 'ready') {
    socket.send(JSON.stringify({ v: 1, type: 'input', sessionId, data: `${command}\r` }));
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

hold_all_tabs() {
  dc exec -T app node --input-type=module - "$hold_stop" <<'NODE'
import { existsSync } from 'node:fs';
import WebSocket from 'ws';

const stopFile = process.argv[2];
const base = process.env.APP_BASE_PATH === '/' ? '' : process.env.APP_BASE_PATH;
const apiBase = `http://127.0.0.1:${process.env.APP_PORT}${base}`;
const collection = await fetch(`${apiBase}/api/tabs`).then((response) => response.json());
const sockets = collection.tabs.map((tab) => new WebSocket(
  `ws://127.0.0.1:${process.env.APP_PORT}${base}/ws/sessions/${tab.id}`,
  { headers: { Origin: process.env.APP_PUBLIC_URL } },
));
let ready = 0;
const timeout = setTimeout(() => process.exit(1), 30_000);
for (const [index, socket] of sockets.entries()) {
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'ready') {
      ready += 1;
      if (ready === sockets.length) process.stdout.write(`ALL_READY_${ready}\n`);
    }
  });
  socket.on('error', () => process.exit(1));
}
const stopCheck = setInterval(() => {
  if (existsSync(stopFile)) for (const socket of sockets) socket.close(1000, 'verified');
}, 100);
const finish = () => {
  if (sockets.some((socket) => socket.readyState !== WebSocket.CLOSED)) return;
  clearInterval(stopCheck);
  clearTimeout(timeout);
};
for (const socket of sockets) socket.on('close', finish);
NODE
}

count_bridges='count=0; for process in /proc/[0-9]*/cmdline; do command=$(tr "\000" " " < "$process" 2>/dev/null || true); case "$command" in "/usr/bin/tmux attach-session "*) count=$((count + 1));; esac; done; printf "%s" "$count"'

wait_for_bridge_count() {
  expected=$1
  message=$2
  attempt=0
  while [ "$(dc exec -T app sh -c "$count_bridges")" != "$expected" ]; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 100 ] || fail "$message"
    sleep 0.1
  done
}

printf 'checking: hardening\n'
[ -f Dockerfile ] || fail 'Dockerfile is unavailable'
rg -q "JetBrainsMonoNerdFont-Regular.ttf" apps/client/src/theme.css || fail 'bundled font unavailable'
dc down -v --remove-orphans >/dev/null 2>&1 || true
dc config --quiet
dc up -d --build --wait
container=$(dc ps -q app)
[ -n "$container" ] || fail 'app container is unavailable'
[ "$(docker inspect -f '{{.Config.User}}' "$container")" = webterm ] || fail 'server user is not webterm'
[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$container")" = true ] || fail 'root filesystem is writable'
[ "$(docker inspect -f '{{.HostConfig.Privileged}}' "$container")" = false ] || fail 'container is privileged'
[ "$(docker inspect -f '{{.HostConfig.PidsLimit}}' "$container")" = 256 ] || fail 'pids limit is not 256'
[ "$(docker inspect -f '{{.HostConfig.Memory}}' "$container")" = 536870912 ] || fail 'memory limit is not 512MiB'
[ "$(docker inspect -f '{{json .HostConfig.CapAdd}}' "$container")" = null ] || fail 'capabilities were added'
[ "$(docker inspect -f '{{json .HostConfig.CapDrop}}' "$container")" = '["ALL"]' ] || fail 'capabilities were not dropped'
docker inspect -f '{{json .HostConfig.SecurityOpt}}' "$container" | rg -q 'no-new-privileges' || fail 'no-new-privileges is unavailable'
docker inspect -f '{{range .Mounts}}{{println .Destination}}{{end}}' "$container" | rg -q '^/var/run/docker.sock$' && fail 'Docker socket mounted'
mounts=$(docker inspect -f '{{range .Mounts}}{{println .Destination}}{{end}}' "$container")
printf '%s\n' "$mounts" | rg -q '^/app/data$' || fail 'application data volume is unavailable'
printf '%s\n' "$mounts" | rg -q '^/home/webterm$' || fail 'home volume is unavailable'
dc exec -T app sh -c '! test -w /app && test -w /app/data && test -w "$HOME" && [ "$(stat -c %u /app/data)" = "$(id -u)" ]'
printf 'hardening checks passed\n'
[ "$check" = all ] || exit 0

printf 'checking: runtime\n'
health=$(dc exec -T app node -e "fetch('http://127.0.0.1:' + process.env.APP_PORT + '/health').then(r=>r.json()).then(v=>process.stdout.write(JSON.stringify(v)))")
ready=$(dc exec -T app node -e "fetch('http://127.0.0.1:' + process.env.APP_PORT + '/ready').then(r=>r.json()).then(v=>process.stdout.write(JSON.stringify(v)))")
printf '%s' "$health" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);if(v.status!=='ok')process.exit(1)})"
printf '%s' "$ready" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);if(v.status!=='ready'||v.ready!==true)process.exit(1)})"
dc exec -T app sh -c 'command -v tmux >/dev/null && command -v ssh >/dev/null && [ "$(id -u)" -ne 0 ] && [ "$(id -un)" = webterm ]'

first_id=$(tab_ids | sed -n '1p')
[ -n "$first_id" ] || fail 'initial tab metadata is unavailable'
ws_probe "$first_id" "export PHASE2_MARKER=$secret; printf 'MARKER_SET\\n'" MARKER_SET
wait_for_bridge_count 0 'PTY bridge leaked after disconnect'
first_tmux=$(tmux_name "$first_id")
dc exec -T app tmux has-session -t "$first_tmux" || fail 'tmux session did not survive disconnect'
ws_probe "$first_id" "printf 'MARKER_RESTORED_%s\\n' \"\$PHASE2_MARKER\"" "MARKER_RESTORED_$secret"

created=$(api POST /api/tabs '{"displayName":"Independent"}')
second_id=$(printf '%s' "$created" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).body.id))")
ws_probe "$second_id" "printf 'SECOND_READY\\n'" SECOND_READY
second_tmux=$(tmux_name "$second_id")
dc exec -T app tmux has-session -t "$first_tmux" || fail 'first session was affected by second tab'
dc exec -T app tmux has-session -t "$second_tmux" || fail 'second tmux session is unavailable'
api POST "/api/tabs/$second_id/session/terminate" '{}' >/dev/null
dc exec -T app tmux has-session -t "$first_tmux" || fail 'terminating second tab affected first tab'
dc exec -T app tmux has-session -t "$second_tmux" >/dev/null 2>&1 && fail 'terminated tmux session still exists'
api POST "/api/tabs/$second_id/session/recreate" '{}' >/dev/null

count=$(tab_ids | wc -l | tr -d ' ')
while [ "$count" -lt 20 ]; do
  api POST /api/tabs '{}' >/dev/null
  count=$((count + 1))
done
limit=$(api POST /api/tabs '{}')
[ "$(printf '%s' "$limit" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(String(JSON.parse(s).status)))")" = 409 ] || fail '21st tab was not rejected'

dc exec -T app rm -f "$hold_stop"
hold_log=$(mktemp)
hold_all_tabs >"$hold_log" 2>/dev/null &
hold_pid=$!
attempt=0
while ! rg -q '^ALL_READY_20$' "$hold_log"; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 300 ] || fail '20 WebSocket bridges did not become ready'
  kill -0 "$hold_pid" 2>/dev/null || fail 'multi-bridge probe exited early'
  sleep 0.1
done
[ "$(dc exec -T app sh -c "$count_bridges")" = 20 ] || fail '20 independent PTY bridges are unavailable'
dc exec -T app touch "$hold_stop"
wait "$hold_pid"
hold_pid=
rm -f "$hold_log"
hold_log=
wait_for_bridge_count 0 'PTY bridges leaked after multi-client disconnect'

dc exec -T app sh -c "printf '%s' '$secret' > \"\$HOME/.phase2-home-fixture\""
dc up -d --wait --force-recreate
[ "$(tab_ids | wc -l | tr -d ' ')" = 20 ] || fail 'tab metadata did not survive recreation'
dc exec -T app sh -c "test \"\$(cat \"\$HOME/.phase2-home-fixture\")\" = '$secret'"
active_tmux=$(dc exec -T app tmux list-sessions -F '#{session_name}' 2>/dev/null || true)
[ -z "$active_tmux" ] || fail 'tmux processes unexpectedly survived container recreation'
dc logs | rg -q "$secret" && fail 'terminal marker leaked to logs'

printf 'container verification passed\n'
