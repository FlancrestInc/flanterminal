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
bootstrap_secret=
empty_secret=
invalid_secret=
local_config=
cloudflare_config=
negative_containers=
negative_volumes=

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
  [ -z "$bootstrap_secret" ] || rm -f "$bootstrap_secret"
  [ -z "$empty_secret" ] || rm -f "$empty_secret"
  [ -z "$invalid_secret" ] || rm -f "$invalid_secret"
  [ -z "$local_config" ] || rm -f "$local_config"
  [ -z "$cloudflare_config" ] || rm -f "$cloudflare_config"
  for negative_container in $negative_containers; do
    docker rm -f "$negative_container" >/dev/null 2>&1 || true
  done
  for negative_volume in $negative_volumes; do
    docker volume rm -f "$negative_volume" >/dev/null 2>&1 || true
  done
  dc exec -T app rm -f "$hold_stop" >/dev/null 2>&1 || true
  dc down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

fail() {
  printf 'container verification failed: %s\n' "$1" >&2
  exit 1
}

require_file_pattern() {
  file=$1
  pattern=$2
  message=$3
  rg -q -- "$pattern" "$file" || fail "$message"
}

reject_file_pattern() {
  file=$1
  pattern=$2
  message=$3
  rg -qi -- "$pattern" "$file" && fail "$message"
  return 0
}

verify_static_hardening() {
  [ -f docker-compose.cloudflare.yml ] || fail 'Cloudflare Compose file is unavailable'
  require_file_pattern Dockerfile '^FROM node:[^ ]+-bookworm-slim AS dependencies$' 'production build is not based on Debian slim'
  require_file_pattern Dockerfile '^FROM node:[^ ]+-bookworm-slim AS runtime$' 'production runtime is not based on Debian slim'
  require_file_pattern Dockerfile 'npm prune --omit=dev' 'production dependencies are not pruned'
  require_file_pattern Dockerfile 'USER webterm' 'production runtime is not non-root'
  require_file_pattern Dockerfile 'bcrypt' 'bcrypt native runtime verification is unavailable'
  require_file_pattern Dockerfile 'jose' 'jose runtime verification is unavailable'
  require_file_pattern Dockerfile 'JetBrainsMonoNerdFont-Regular' 'bundled font verification is unavailable'
  require_file_pattern Dockerfile 'terminal-bell' 'bundled bell verification is unavailable'
  require_file_pattern Dockerfile 'HEALTHCHECK' 'image health check is unavailable'
  for dockerfile in Dockerfile Dockerfile.dev Dockerfile.e2e; do
    reject_file_pattern "$dockerfile" '^[[:space:]]*(ARG|ENV)[[:space:]].*(PASSWORD|SECRET)' "password or secret metadata is present in $dockerfile"
    reject_file_pattern "$dockerfile" '^[[:space:]]*COPY.*(secret|private.?key|id_(rsa|ecdsa|ed25519))' "secret material may be copied by $dockerfile"
  done
  require_file_pattern .dockerignore '^secrets(?:/|$)' 'host secret directory is not excluded from build context'
  require_file_pattern .gitignore '^secrets/$' 'host secret directory is not excluded from version control'

  require_file_pattern docker-compose.yml 'AUTH_MODE:.*local' 'default Compose does not enable local authentication'
  require_file_pattern docker-compose.yml 'LOCAL_AUTH_PASSWORD_FILE:.*\/run\/secrets\/local_auth_password' 'default Compose does not mount the local password at the fixed runtime path'
  require_file_pattern docker-compose.yml '^secrets:' 'default Compose has no top-level secret declaration'
  require_file_pattern docker-compose.yml 'source: local_auth_password' 'default Compose has no local password secret source'
  require_file_pattern docker-compose.yml 'HOST_BIND_ADDRESS:-127\.0\.0\.1' 'default host bind address is not loopback'
  reject_file_pattern docker-compose.yml 'node_modules' 'default Compose persists node_modules'
  reject_file_pattern docker-compose.yml 'docker\.sock|privileged:[[:space:]]*true' 'default Compose grants Docker or privileged access'

  reject_file_pattern docker-compose.cloudflare.yml 'LOCAL_AUTH_PASSWORD|local_auth_password|^[[:space:]]*secrets:' 'Cloudflare Compose depends on a local password secret'
  require_file_pattern docker-compose.cloudflare.yml 'AUTH_MODE:.*cloudflare-access' 'Cloudflare Compose does not enable Cloudflare Access'
  require_file_pattern docker-compose.cloudflare.yml 'CLOUDFLARE_TEAM_DOMAIN' 'Cloudflare team domain is unavailable'
  require_file_pattern docker-compose.cloudflare.yml 'CLOUDFLARE_ACCESS_AUD' 'Cloudflare Access audience is unavailable'
  require_file_pattern docker-compose.cloudflare.yml 'TRUST_PROXY:' 'Cloudflare trusted proxy configuration is unavailable'
  require_file_pattern docker-compose.cloudflare.yml 'HOST_BIND_ADDRESS:-127\.0\.0\.1' 'Cloudflare host bind address does not default to loopback'
  reject_file_pattern docker-compose.cloudflare.yml 'TRUSTED_AUTH_HEADER' 'Cloudflare Compose enables generic trusted-header behavior'
  reject_file_pattern docker-compose.cloudflare.yml 'node_modules' 'Cloudflare Compose persists node_modules'
  reject_file_pattern docker-compose.cloudflare.yml 'docker\.sock|privileged:[[:space:]]*true' 'Cloudflare Compose grants Docker or privileged access'
}

verify_compose_models() {
  local_config=$(mktemp)
  cloudflare_config=$(mktemp)
  docker compose -f docker-compose.yml config --format json >"$local_config"
  LOCAL_AUTH_PASSWORD_FILE_HOST=/definitely/missing \
    docker compose -f docker-compose.cloudflare.yml config --format json >"$cloudflare_config"
  rg -qi 'local_auth_password|LOCAL_AUTH_PASSWORD|"secrets"' "$cloudflare_config" &&
    fail 'Cloudflare resolved configuration contains a local secret dependency'
  node - "$local_config" "$cloudflare_config" <<'NODE'
const fs = require('node:fs');
const [localPath, cloudflarePath] = process.argv.slice(2);
const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
const cloudflare = JSON.parse(fs.readFileSync(cloudflarePath, 'utf8'));
const hardeningKeys = [
  'build', 'cap_drop', 'healthcheck', 'mem_limit', 'pids_limit', 'ports',
  'read_only', 'restart', 'security_opt', 'tmpfs', 'volumes',
];
for (const key of hardeningKeys) {
  if (JSON.stringify(local.services.app[key]) !== JSON.stringify(cloudflare.services.app[key])) {
    throw new Error(`Compose hardening differs for ${key}`);
  }
}
const expectedMounts = ['/app/data', '/home/webterm'];
for (const service of [local.services.app, cloudflare.services.app]) {
  const mounts = service.volumes.map(({ target }) => target).sort();
  if (JSON.stringify(mounts) !== JSON.stringify(expectedMounts)) {
    throw new Error(`Unexpected writable volumes: ${mounts.join(', ')}`);
  }
  if (service.cap_add !== undefined || service.privileged === true) {
    throw new Error('Compose adds privileges');
  }
}
if (local.services.app.environment.AUTH_MODE !== 'local') throw new Error('Local auth is not enabled');
if (cloudflare.services.app.environment.AUTH_MODE !== 'cloudflare-access') throw new Error('Cloudflare auth is not enabled');
if (cloudflare.services.app.environment.TRUST_PROXY !== 'false') throw new Error('Cloudflare generic trust is enabled');
if (local.services.app.ports[0].host_ip !== '127.0.0.1' || cloudflare.services.app.ports[0].host_ip !== '127.0.0.1') {
  throw new Error('Compose default publish address is not loopback');
}
NODE
}

verify_failed_local_bootstrap() {
  case_name=$1
  secret_file=${2-}
  secret_value=${3-}
  negative_container="${project}_negative_${case_name}"
  negative_data="${project}_negative_data_${case_name}"
  negative_home="${project}_negative_home_${case_name}"
  negative_containers="$negative_containers $negative_container"
  negative_volumes="$negative_volumes $negative_data $negative_home"
  secret_mount=
  if [ -n "$secret_file" ]; then
    secret_mount="--mount type=bind,src=$secret_file,dst=/run/secrets/local_auth_password,readonly"
  fi
  # shellcheck disable=SC2086
  docker run -d --name "$negative_container" \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777 \
    --tmpfs /run:rw,noexec,nosuid,nodev,size=1m,mode=0755,uid=1000,gid=1000 \
    --mount "type=volume,src=$negative_data,dst=/app/data" \
    --mount "type=volume,src=$negative_home,dst=/home/webterm" \
    $secret_mount \
    -e AUTH_MODE=local \
    -e LOCAL_AUTH_PASSWORD_FILE=/run/secrets/local_auth_password \
    "$image" >/dev/null
  attempt=0
  while [ "$(docker inspect -f '{{.State.Running}}' "$negative_container")" = true ]; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 100 ] || fail "$case_name local bootstrap did not exit"
    sleep 0.1
  done
  [ "$(docker inspect -f '{{.State.ExitCode}}' "$negative_container")" -ne 0 ] ||
    fail "$case_name local bootstrap exited successfully"
  container_logs=$(docker logs "$negative_container" 2>&1)
  printf '%s' "$container_logs" | rg -q 'server_started' &&
    fail "$case_name local bootstrap listened before failing"
  if [ -n "$secret_value" ]; then
    printf '%s' "$container_logs" | rg -F -q -- "$secret_value" &&
      fail "$case_name local bootstrap exposed the password in logs"
  fi
  docker rm "$negative_container" >/dev/null
  negative_containers=$(printf '%s' "$negative_containers" | sed "s/ $negative_container//")
  docker volume rm "$negative_data" "$negative_home" >/dev/null
  negative_volumes=$(printf '%s' "$negative_volumes" | sed "s/ $negative_data//; s/ $negative_home//")
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
verify_static_hardening
bootstrap_secret=$(mktemp)
printf '%s\n' 'phase3-container-test-only' >"$bootstrap_secret"
chmod 0600 "$bootstrap_secret"
export LOCAL_AUTH_PASSWORD_FILE_HOST=$bootstrap_secret
verify_compose_models
dc down -v --remove-orphans >/dev/null 2>&1 || true
dc config --quiet
dc up -d --build --wait
container=$(dc ps -q app)
[ -n "$container" ] || fail 'app container is unavailable'
image=$(docker inspect -f '{{.Image}}' "$container")
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
printf '%s\n' "$mounts" | rg -q '^/run/secrets/local_auth_password$' || fail 'local password secret is unavailable'
unexpected_mounts=$(printf '%s\n' "$mounts" | rg -v '^(/app/data|/home/webterm|/run/secrets/local_auth_password)$' || true)
[ -z "$unexpected_mounts" ] || fail 'unexpected persistent or secret mounts are present'
dc exec -T app sh -c '
  ! test -w /app &&
  ! test -w /app/apps/server/dist/index.js &&
  ! test -w /app/apps/client/dist/index.html &&
  test -w /app/data && test -w "$HOME" &&
  [ "$(stat -c %u /app/data)" = "$(id -u)" ] &&
  [ "$(stat -c %a /app/data)" = 700 ] &&
  [ "$(stat -c %u "$HOME")" = "$(id -u)" ] &&
  [ "$(stat -c %a "$HOME/.ssh")" = 700 ] &&
  [ "$(stat -c %a "$HOME/.bash_history")" = 600 ] &&
  [ "$(stat -c %a /app/data/auth.json)" = 600 ] &&
  [ "$(stat -c %a /app/data/settings.json)" = 600 ] &&
  [ -r /run/secrets/local_auth_password ] &&
  [ "$(stat -c %a /run/secrets/local_auth_password)" = 600 ] &&
  node --input-type=module -e "await import(\"bcrypt\"); await import(\"jose\")" &&
  test -n "$(find /app/apps/client/dist/assets -name "JetBrainsMonoNerdFont-Regular-*.ttf" -print -quit)" &&
  test -n "$(find /app/apps/client/dist/assets -name "terminal-bell-*.wav" -print -quit)"
'

image_environment=$(docker image inspect -f '{{json .Config.Env}}' "$image")
printf '%s' "$image_environment" | rg -qi 'PASSWORD|SECRET|phase3-container-test-only|\$2[aby]\$' && fail 'secret metadata is present in image configuration'
image_history=$(docker image history --no-trunc --format '{{.CreatedBy}}' "$image")
printf '%s' "$image_history" | rg -qi 'PASSWORD|SECRET|phase3-container-test-only|\$2[aby]\$|PRIVATE KEY' && fail 'secret material is present in image history'
docker run --rm --entrypoint sh "$image" -c '
  ! find /app /home/webterm -xdev -type f \( -name "id_rsa" -o -name "id_ecdsa" -o -name "id_ed25519" -o -name "*.pem" -o -name "*.key" \) -print -quit | grep -q . &&
  ! grep -R -a -E "phase3-container-test-only|^-----BEGIN (OPENSSH |RSA |EC )?PRIVATE KEY-----" /app /home/webterm 2>/dev/null
' || fail 'secret or private-key material is present in final image filesystem'

exposure_marker=PHASE3_HTTP_PRIVATE_MARKER
dc exec -T app sh -c "printf '%s' '$exposure_marker' > /app/data/http-private; printf '%s' '$exposure_marker' > \"\$HOME/.ssh/id_ed25519\""
dc exec -T app node --input-type=module - "$exposure_marker" <<'NODE'
const marker = process.argv[2];
const base = `http://127.0.0.1:${process.env.APP_PORT}`;
for (const path of ['/app/data/http-private', '/data/http-private', '/home/webterm/.ssh/id_ed25519', '/.ssh/id_ed25519']) {
  const response = await fetch(base + path);
  if ((await response.text()).includes(marker)) process.exit(1);
}
NODE

empty_secret=$(mktemp)
invalid_secret=$(mktemp)
chmod 0600 "$empty_secret" "$invalid_secret"
printf '%s\n' short >"$invalid_secret"
verify_failed_local_bootstrap missing
verify_failed_local_bootstrap empty "$empty_secret"
verify_failed_local_bootstrap invalid "$invalid_secret" short
rm -f "$empty_secret" "$invalid_secret"
empty_secret=
invalid_secret=
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
