#!/bin/sh
set -eu

compose=${COMPOSE_FILE:-docker-compose.yml}
project=${COMPOSE_PROJECT_NAME:-flanterminal_verify}
: "${HOST_PORT:=3101}"
: "${SESSION_MAX_COUNT:=20}"
export HOST_PORT SESSION_MAX_COUNT
terminal_secret=PHASE3_TERMINAL_DATA_NOT_IN_LOGS
enrollment_password=$(openssl rand -hex 24)
replacement_password=$(openssl rand -hex 24)
auth_cookie=
auth_csrf=
hold_pid=
hold_log=
hold_stop=/tmp/.flanterminal-verify-stop
local_config=
none_config=
cloudflare_config=
example_config=
e2e_config=
negative_containers=
negative_volumes=
pre_recreate_logs=

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
  status=$?
  trap - EXIT INT TERM
  if [ -n "$hold_pid" ]; then
    kill "$hold_pid" >/dev/null 2>&1 || true
    wait "$hold_pid" >/dev/null 2>&1 || true
  fi
  [ -z "$hold_log" ] || rm -f "$hold_log"
  [ -z "$local_config" ] || rm -f "$local_config"
  [ -z "$none_config" ] || rm -f "$none_config"
  [ -z "$cloudflare_config" ] || rm -f "$cloudflare_config"
  [ -z "$example_config" ] || rm -f "$example_config"
  [ -z "$e2e_config" ] || rm -f "$e2e_config"
  for negative_container in $negative_containers; do
    docker rm -f "$negative_container" >/dev/null 2>&1 || true
  done
  for negative_volume in $negative_volumes; do
    docker volume rm -f "$negative_volume" >/dev/null 2>&1 || true
  done
  dc exec -T app rm -f "$hold_stop" >/dev/null 2>&1 || true
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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

script_line() {
  statement=$1
  awk -v statement="$statement" '$0 == statement { print NR; exit }' scripts/verify-container.sh
}

verify_script_lifecycle() {
  lifecycle_errors=
  exit_trap=$(script_line 'trap cleanup EXIT')
  int_trap=$(script_line "trap 'exit 130' INT")
  term_trap=$(script_line "trap 'exit 143' TERM")
  combined_trap=$(script_line 'trap cleanup EXIT INT TERM')
  [ -n "$exit_trap" ] && [ -n "$int_trap" ] && [ -n "$term_trap" ] && [ -z "$combined_trap" ] ||
    lifecycle_errors='dedicated EXIT/INT/TERM traps are unavailable; '
  unset_traps=$(script_line '  trap - EXIT INT TERM')
  preserve_status=$(script_line '  exit "$status"')
  [ -n "$unset_traps" ] && [ -n "$preserve_status" ] && [ "$unset_traps" -lt "$preserve_status" ] ||
    lifecycle_errors="${lifecycle_errors}cleanup traps or exit status are not bounded; "

  stop_line=$(script_line 'dc stop app >/dev/null')
  logs_line=$(script_line 'pre_recreate_logs=$(dc logs app 2>&1)')
  remove_line=$(script_line 'dc rm -f app >/dev/null')
  combined_logs_line=$(awk 'index($0, "container_logs=$(") == 1 && index($0, "$pre_recreate_logs") { print NR; exit }' scripts/verify-container.sh)
  if [ -z "$stop_line" ] || [ -z "$logs_line" ] || [ -z "$remove_line" ] ||
    [ -z "$combined_logs_line" ] || [ "$stop_line" -ge "$logs_line" ] ||
    [ "$remove_line" -ne "$((logs_line + 1))" ] || [ "$remove_line" -ge "$combined_logs_line" ]; then
    lifecycle_errors="${lifecycle_errors}old container logs are not captured after stop and before removal; "
  fi

  [ -z "$lifecycle_errors" ] || fail "verification lifecycle structure is unsafe: $lifecycle_errors"
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
  for health_file in Dockerfile docker-compose.yml docker-compose.cloudflare.yml docker-compose.e2e.yml docker-compose.cloudflare-e2e.yml; do
    reject_file_pattern "$health_file" 'APP_BASE_PATH.*\/health' "health check incorrectly uses the application base path in $health_file"
  done
  for dockerfile in Dockerfile Dockerfile.dev Dockerfile.e2e; do
    reject_file_pattern "$dockerfile" '^[[:space:]]*(ARG|ENV)[[:space:]].*(PASSWORD|SECRET)' "password or secret metadata is present in $dockerfile"
    reject_file_pattern "$dockerfile" '^[[:space:]]*COPY.*(secret|private.?key|id_(rsa|ecdsa|ed25519))' "secret material may be copied by $dockerfile"
  done
  require_file_pattern .dockerignore '^secrets(?:/|$)' 'host secret directory is not excluded from build context'
  require_file_pattern .gitignore '^secrets/$' 'host secret directory is not excluded from version control'

  require_file_pattern docker-compose.yml 'AUTH_MODE:.*local' 'default Compose does not enable local authentication'
  for local_file in docker-compose.yml docker-compose.example.yml; do
    reject_file_pattern "$local_file" 'LOCAL_AUTH_PASSWORD|LOCAL_PASSWORD_FILE|local_auth_password|^[[:space:]]*secrets:' "local Compose contains a password-file or secret reference in $local_file"
  done
  reject_file_pattern docker-compose.e2e.yml 'LOCAL_AUTH_PASSWORD|E2E_LOCAL_PASSWORD_FILE|local_auth_password|^[[:space:]]*secrets:' 'E2E Compose contains an app password-file or secret reference'
  reject_file_pattern .env.example 'LOCAL_AUTH_PASSWORD_FILE|LOCAL_AUTH_PASSWORD_FILE_HOST|local_auth_password' 'example environment contains local password-file configuration'
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
  none_config=$(mktemp)
  cloudflare_config=$(mktemp)
  example_config=$(mktemp)
  e2e_config=$(mktemp)
  docker compose -f docker-compose.yml config --format json >"$local_config"
  AUTH_MODE=none docker compose -f docker-compose.yml config --format json >"$none_config"
  docker compose -f docker-compose.cloudflare.yml config --format json >"$cloudflare_config"
  docker compose -f docker-compose.example.yml config --format json >"$example_config"
  docker compose -f docker-compose.e2e.yml config --format json >"$e2e_config"
  for resolved_config in "$local_config" "$none_config" "$cloudflare_config"; do
    rg -qi 'local_auth_password|LOCAL_AUTH_PASSWORD|"secrets"' "$resolved_config" &&
      fail 'resolved Compose configuration contains a local secret dependency'
  done
  node - "$local_config" "$none_config" "$cloudflare_config" "$example_config" "$e2e_config" <<'NODE'
const fs = require('node:fs');
const [localPath, nonePath, cloudflarePath, examplePath, e2ePath] = process.argv.slice(2);
const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
const none = JSON.parse(fs.readFileSync(nonePath, 'utf8'));
const cloudflare = JSON.parse(fs.readFileSync(cloudflarePath, 'utf8'));
const example = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
const e2e = JSON.parse(fs.readFileSync(e2ePath, 'utf8'));
const hardeningKeys = [
  'build', 'cap_drop', 'healthcheck', 'mem_limit', 'pids_limit', 'ports',
  'read_only', 'restart', 'security_opt', 'tmpfs', 'volumes',
];
for (const key of hardeningKeys) {
  if (JSON.stringify(local.services.app[key]) !== JSON.stringify(cloudflare.services.app[key])) {
    throw new Error(`Compose hardening differs for ${key}`);
  }
}
for (const key of hardeningKeys.filter((key) => key !== 'volumes')) {
  if (JSON.stringify(local.services.app[key]) !== JSON.stringify(example.services.app[key])) {
    throw new Error(`Example Compose weakens inherited hardening for ${key}`);
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
  if (service.secrets !== undefined) throw new Error('Compose mounts a secret');
}
for (const service of [example.services.app, e2e.services.app]) {
  const mounts = service.volumes.map(({ target }) => target).sort();
  if (JSON.stringify(mounts) !== JSON.stringify(expectedMounts)) {
    throw new Error(`Unexpected local app volumes: ${mounts.join(', ')}`);
  }
  if (service.secrets !== undefined) throw new Error('Local app mounts a secret');
  if (service.read_only !== true) throw new Error('Local app root filesystem is writable');
  if (JSON.stringify(service.cap_drop) !== JSON.stringify(['ALL'])) {
    throw new Error('Local app does not drop all capabilities');
  }
  if (!service.security_opt?.includes('no-new-privileges:true')) {
    throw new Error('Local app permits privilege escalation');
  }
  if (service.pids_limit !== 256) throw new Error('Local app process limit is weakened');
  if (service.mem_limit !== '536870912') throw new Error('Local app memory limit is weakened');
  if (service.healthcheck?.disable === true || !Array.isArray(service.healthcheck?.test) || !service.healthcheck.test.join(' ').includes('/health')) {
    throw new Error('Local app healthcheck is unavailable');
  }
  const tmpfs = new Map(service.tmpfs.map((entry) => {
    const [target, ...options] = entry.split(':');
    return [target, options.join(':').split(',')];
  }));
  for (const [target, required] of [
    ['/tmp', ['rw', 'noexec', 'nosuid', 'nodev', 'size=16m', 'mode=1777']],
    ['/run', ['rw', 'noexec', 'nosuid', 'nodev', 'size=1m', 'mode=0755', 'uid=1000', 'gid=1000']],
  ]) {
    if (!required.every((option) => tmpfs.get(target)?.includes(option))) {
      throw new Error(`Local app ${target} tmpfs is weakened`);
    }
  }
  if (service.cap_add !== undefined || service.privileged === true) {
    throw new Error('Local app adds privileges');
  }
  if (Object.keys(service.environment ?? {}).some((key) => /password|secret/i.test(key))) {
    throw new Error('Local app receives password or secret environment');
  }
}
if (!Object.hasOwn(e2e.services.e2e.environment, 'E2E_LOCAL_PASSWORD')) {
  throw new Error('E2E password compatibility is unavailable to Playwright');
}
if (local.services.app.environment.AUTH_MODE !== 'local') throw new Error('Local auth is not enabled');
if (none.services.app.environment.AUTH_MODE !== 'none') throw new Error('AUTH_MODE does not override the local default');
if (cloudflare.services.app.environment.AUTH_MODE !== 'cloudflare-access') throw new Error('Cloudflare auth is not enabled');
if (cloudflare.services.app.environment.TRUST_PROXY !== 'false') throw new Error('Cloudflare generic trust is enabled');
if (local.services.app.ports[0].host_ip !== '127.0.0.1' || cloudflare.services.app.ports[0].host_ip !== '127.0.0.1') {
  throw new Error('Compose default publish address is not loopback');
}
NODE
}

verify_failed_local_record() {
  case_name=$1
  negative_container="${project}_negative_${case_name}"
  negative_data="${project}_negative_data_${case_name}"
  negative_home="${project}_negative_home_${case_name}"
  negative_containers="$negative_containers $negative_container"
  negative_volumes="$negative_volumes $negative_data $negative_home"

  case "$case_name" in
    malformed) record='{' ;;
    invalid) record='{"version":2,"marker":"UNSAFE_AUTH_RECORD_MARKER"}' ;;
    *) fail 'unknown invalid local credential case' ;;
  esac
  printf '%s' "$record" | docker run -i --rm \
    --mount "type=volume,src=$negative_data,dst=/app/data" \
    --entrypoint sh "$image" -c 'umask 077; cat > /app/data/auth.json'
  unset record

  docker run -d --name "$negative_container" \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777 \
    --tmpfs /run:rw,noexec,nosuid,nodev,size=1m,mode=0755,uid=1000,gid=1000 \
    --mount "type=volume,src=$negative_data,dst=/app/data" \
    --mount "type=volume,src=$negative_home,dst=/home/webterm" \
    -e AUTH_MODE=local \
    "$image" >/dev/null
  attempt=0
  while [ "$(docker inspect -f '{{.State.Running}}' "$negative_container")" = true ]; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 100 ] || fail "$case_name local credential record did not exit"
    sleep 0.1
  done
  [ "$(docker inspect -f '{{.State.ExitCode}}' "$negative_container")" -ne 0 ] ||
    fail "$case_name local credential record exited successfully"
  container_logs=$(docker logs "$negative_container" 2>&1)
  printf '%s' "$container_logs" | rg -q 'server_started' &&
    fail "$case_name local credential record listened before failing"
  printf '%s' "$container_logs" | rg -F -q -- 'UNSAFE_AUTH_RECORD_MARKER' &&
    fail "$case_name local credential record contents appeared in logs"
  docker rm "$negative_container" >/dev/null
  negative_containers=$(printf '%s' "$negative_containers" | sed "s/ $negative_container//")
  docker volume rm "$negative_data" "$negative_home" >/dev/null
  negative_volumes=$(printf '%s' "$negative_volumes" | sed "s/ $negative_data//; s/ $negative_home//")
}

setup_response() {
  password=$1
  printf '%s' "$password" | dc exec -T app node --input-type=module -e '
let password = "";
for await (const chunk of process.stdin) password += chunk;
const base = process.env.APP_BASE_PATH === "/" ? "" : process.env.APP_BASE_PATH;
const api = `http://127.0.0.1:${process.env.APP_PORT}${base}/api/auth`;
const session = await fetch(`${api}/session`);
const bootstrap = await session.json();
const expected = {
  authenticated: false,
  mode: "local",
  setupRequired: true,
  username: process.env.LOCAL_AUTH_USERNAME,
};
if (session.status !== 200 || JSON.stringify(bootstrap) !== JSON.stringify(expected)) process.exit(2);
const response = await fetch(`${api}/setup`, {
  method: "POST",
  headers: { Origin: process.env.APP_PUBLIC_URL, "Content-Type": "application/json" },
  body: JSON.stringify({ password }),
});
const text = await response.text();
const setCookie = response.headers.get("set-cookie");
process.stdout.write(JSON.stringify({
  status: response.status,
  cookie: setCookie?.split(";", 1)[0] ?? null,
  body: text === "" ? null : JSON.parse(text),
}));
'
}

login_response() {
  password=$1
  printf '%s' "$password" | dc exec -T app node --input-type=module -e '
let password = "";
for await (const chunk of process.stdin) password += chunk;
const base = process.env.APP_BASE_PATH === "/" ? "" : process.env.APP_BASE_PATH;
const response = await fetch(`http://127.0.0.1:${process.env.APP_PORT}${base}/api/auth/login`, {
  method: "POST",
  headers: { Origin: process.env.APP_PUBLIC_URL, "Content-Type": "application/json" },
  body: JSON.stringify({ username: process.env.LOCAL_AUTH_USERNAME, password }),
});
const text = await response.text();
const setCookie = response.headers.get("set-cookie");
process.stdout.write(JSON.stringify({
  status: response.status,
  cookie: setCookie?.split(";", 1)[0] ?? null,
  body: text === "" ? null : JSON.parse(text),
}));
'
}

json_value() {
  path=$1
  node -e '
let input="";
process.stdin.on("data", chunk => input += chunk).on("end", () => {
  let value = JSON.parse(input);
  for (const key of process.argv[1].split(".")) value = value?.[key];
  if (typeof value === "object") process.stdout.write(JSON.stringify(value));
  else if (value !== undefined && value !== null) process.stdout.write(String(value));
});
' "$path"
}

auth_login() {
  response=$(login_response "$1")
  [ "$(printf '%s' "$response" | json_value status)" = 200 ] ||
    fail 'local authentication failed'
  auth_cookie=$(printf '%s' "$response" | json_value cookie)
  auth_csrf=$(printf '%s' "$response" | json_value body.csrfToken)
  [ -n "$auth_cookie" ] && [ -n "$auth_csrf" ] ||
    fail 'local authentication returned no cookie or CSRF token'
}

auth_setup() {
  response=$(setup_response "$1")
  [ "$(printf '%s' "$response" | json_value status)" = 200 ] ||
    fail 'local first-run enrollment failed'
  [ "$(printf '%s' "$response" | json_value body.authenticated)" = true ] ||
    fail 'local first-run enrollment did not authenticate'
  [ "$(printf '%s' "$response" | json_value body.identityLabel)" = "$(dc exec -T app printenv LOCAL_AUTH_USERNAME)" ] ||
    fail 'local first-run enrollment returned the wrong identity'
  auth_cookie=$(printf '%s' "$response" | json_value cookie)
  auth_csrf=$(printf '%s' "$response" | json_value body.csrfToken)
  [ -n "$auth_cookie" ] && [ -n "$auth_csrf" ] ||
    fail 'local first-run enrollment returned no cookie or CSRF token'
}

auth_logout() {
  response=$(api POST /api/auth/logout '{}')
  [ "$(printf '%s' "$response" | json_value status)" = 204 ] ||
    fail 'local logout failed'
}

session_response() {
  cookie=$1
  printf '%s' "$cookie" | dc exec -T app node --input-type=module -e '
let cookie = "";
for await (const chunk of process.stdin) cookie += chunk;
const base = process.env.APP_BASE_PATH === "/" ? "" : process.env.APP_BASE_PATH;
const response = await fetch(`http://127.0.0.1:${process.env.APP_PORT}${base}/api/auth/session`, {
  headers: { Cookie: cookie },
});
const text = await response.text();
process.stdout.write(JSON.stringify({ status: response.status, body: text === "" ? null : JSON.parse(text) }));
'
}

change_password() {
  current=$1
  replacement=$2
  printf '%s\n%s' "$current" "$replacement" | \
    dc exec -T \
      -e VERIFY_AUTH_COOKIE="$auth_cookie" \
      -e VERIFY_CSRF_TOKEN="$auth_csrf" \
      app node --input-type=module -e '
let input = "";
for await (const chunk of process.stdin) input += chunk;
const newline = input.indexOf("\n");
const currentPassword = input.slice(0, newline);
const newPassword = input.slice(newline + 1);
const base = process.env.APP_BASE_PATH === "/" ? "" : process.env.APP_BASE_PATH;
const response = await fetch(`http://127.0.0.1:${process.env.APP_PORT}${base}/api/auth/password`, {
  method: "PUT",
  headers: {
    Cookie: process.env.VERIFY_AUTH_COOKIE,
    Origin: process.env.APP_PUBLIC_URL,
    "X-CSRF-Token": process.env.VERIFY_CSRF_TOKEN,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ currentPassword, newPassword }),
});
process.stdout.write(String(response.status));
'
}

api() {
  method=$1
  path=$2
  body=${3-}
  dc exec -T \
    -e VERIFY_AUTH_COOKIE="$auth_cookie" \
    -e VERIFY_CSRF_TOKEN="$auth_csrf" \
    app node --input-type=module - "$method" "$path" "$body" <<'NODE'
const [method, path, body] = process.argv.slice(2);
const base = process.env.APP_BASE_PATH === '/' ? '' : process.env.APP_BASE_PATH;
const response = await fetch(`http://127.0.0.1:${process.env.APP_PORT}${base}${path}`, {
  method,
  headers: {
    Cookie: process.env.VERIFY_AUTH_COOKIE,
    ...(method === 'GET' ? {} : {
      Origin: process.env.APP_PUBLIC_URL,
      'X-CSRF-Token': process.env.VERIFY_CSRF_TOKEN,
      'Content-Type': 'application/json',
    }),
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
  dc exec -T -e VERIFY_AUTH_COOKIE="$auth_cookie" app node --input-type=module - "$session_id" "$command" "$expected" <<'NODE'
import WebSocket from 'ws';

const [sessionId, command, expected] = process.argv.slice(2);
const base = process.env.APP_BASE_PATH === '/' ? '' : process.env.APP_BASE_PATH;
const socket = new WebSocket(
  `ws://127.0.0.1:${process.env.APP_PORT}${base}/ws/sessions/${sessionId}`,
  { headers: { Origin: process.env.APP_PUBLIC_URL, Cookie: process.env.VERIFY_AUTH_COOKIE } },
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
  dc exec -T -e VERIFY_AUTH_COOKIE="$auth_cookie" app node --input-type=module - "$hold_stop" <<'NODE'
import { existsSync } from 'node:fs';
import WebSocket from 'ws';

const stopFile = process.argv[2];
const base = process.env.APP_BASE_PATH === '/' ? '' : process.env.APP_BASE_PATH;
const apiBase = `http://127.0.0.1:${process.env.APP_PORT}${base}`;
const collection = await fetch(`${apiBase}/api/tabs`, {
  headers: { Cookie: process.env.VERIFY_AUTH_COOKIE },
}).then((response) => response.json());
const sockets = collection.tabs.map((tab) => new WebSocket(
  `ws://127.0.0.1:${process.env.APP_PORT}${base}/ws/sessions/${tab.id}`,
  { headers: { Origin: process.env.APP_PUBLIC_URL, Cookie: process.env.VERIFY_AUTH_COOKIE } },
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
verify_script_lifecycle
verify_static_hardening
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
printf '%s\n' "$mounts" | rg -q '^/run/secrets(?:/|$)' && fail 'runtime secrets mount is present'
unexpected_mounts=$(printf '%s\n' "$mounts" | rg -v '^(/app/data|/home/webterm)$' || true)
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
  [ ! -e /app/data/auth.json ] &&
  [ "$(stat -c %a /app/data/settings.json)" = 600 ] &&
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
dc exec -T app sh -c "printf '%s' '$exposure_marker' > /app/data/http-private; printf '%s' '$exposure_marker' > \"\$HOME/.ssh/id_ed25519\"; chmod 600 \"\$HOME/.ssh/id_ed25519\""
dc exec -T app node --input-type=module - "$exposure_marker" <<'NODE'
const marker = process.argv[2];
const base = `http://127.0.0.1:${process.env.APP_PORT}`;
for (const path of ['/app/data/http-private', '/data/http-private', '/home/webterm/.ssh/id_ed25519', '/.ssh/id_ed25519']) {
  const response = await fetch(base + path);
  if ((await response.text()).includes(marker)) process.exit(1);
}
NODE

verify_failed_local_record malformed
verify_failed_local_record invalid
printf 'hardening checks passed\n'
[ "$check" = all ] || exit 0

printf 'checking: runtime\n'
health=$(dc exec -T app node -e "fetch('http://127.0.0.1:' + process.env.APP_PORT + '/health').then(r=>r.json()).then(v=>process.stdout.write(JSON.stringify(v)))")
ready=$(dc exec -T app node -e "fetch('http://127.0.0.1:' + process.env.APP_PORT + '/ready').then(r=>r.json()).then(v=>process.stdout.write(JSON.stringify(v)))")
printf '%s' "$health" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);if(v.status!=='ok')process.exit(1)})"
printf '%s' "$ready" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);if(v.status!=='ready'||v.ready!==true)process.exit(1)})"
dc exec -T app sh -c 'command -v tmux >/dev/null && command -v ssh >/dev/null && [ "$(id -u)" -ne 0 ] && [ "$(id -un)" = webterm ]'

auth_setup "$enrollment_password"
enrollment_cookie=$auth_cookie
dc exec -T app sh -c '[ "$(stat -c %a /app/data/auth.json)" = 600 ]'
auth_logout
logged_out=$(session_response "$enrollment_cookie")
[ "$(printf '%s' "$logged_out" | json_value status)" = 200 ] &&
  [ "$(printf '%s' "$logged_out" | json_value body.authenticated)" = false ] ||
  fail 'logged-out local session remained authenticated'
auth_login "$enrollment_password"
first_id=$(tab_ids | sed -n '1p')
[ -n "$first_id" ] || fail 'initial tab metadata is unavailable'
ws_probe "$first_id" "export PHASE3_MARKER=$terminal_secret; printf 'MARKER_SET\\n'" MARKER_SET
wait_for_bridge_count 0 'PTY bridge leaked after disconnect'
first_tmux=$(tmux_name "$first_id")
dc exec -T app tmux has-session -t "$first_tmux" || fail 'tmux session did not survive disconnect'
ws_probe "$first_id" "printf 'MARKER_RESTORED_%s\\n' \"\$PHASE3_MARKER\"" "MARKER_RESTORED_$terminal_secret"

created=$(api POST /api/tabs '{"displayName":"Independent"}')
[ "$(printf '%s' "$created" | json_value status)" = 201 ] || fail 'second tab was not created'
second_id=$(printf '%s' "$created" | json_value body.id)
ws_probe "$second_id" "printf 'SECOND_READY\\n'" SECOND_READY
second_tmux=$(tmux_name "$second_id")
dc exec -T app tmux has-session -t "$first_tmux" || fail 'first session was affected by second tab'
dc exec -T app tmux has-session -t "$second_tmux" || fail 'second tmux session is unavailable'
api POST "/api/tabs/$second_id/session/terminate" '{}' >/dev/null
dc exec -T app tmux has-session -t "$first_tmux" || fail 'terminating second tab affected first tab'
dc exec -T app tmux has-session -t "$second_tmux" >/dev/null 2>&1 && fail 'terminated tmux session still exists'
api POST "/api/tabs/$second_id/session/recreate" '{}' >/dev/null

settings=$(api GET /api/settings)
[ "$(printf '%s' "$settings" | json_value status)" = 200 ] || fail 'settings are unavailable'
settings_body=$(printf '%s' "$settings" | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk).on("end", () => {
  const settings = JSON.parse(input).body.settings;
  process.stdout.write(JSON.stringify({
    settings: { ...settings, theme: "ubuntu", fontSize: 15, staleSessionCleanupHours: 1 },
  }));
});
')
updated_settings=$(api PUT /api/settings "$settings_body")
[ "$(printf '%s' "$updated_settings" | json_value status)" = 200 ] || fail 'settings update failed'
[ "$(printf '%s' "$updated_settings" | json_value body.settings.theme)" = ubuntu ] || fail 'theme update was not authoritative'
[ "$(printf '%s' "$updated_settings" | json_value body.settings.staleSessionCleanupHours)" = 1 ] || fail 'cleanup setting was not authoritative'

dc exec -T -e VERIFY_MARKER="$terminal_secret" app sh -c '
  umask 077
  printf "Host verify-only\n  HostName 192.0.2.1\n  User example-user\n" > "$HOME/.ssh/config"
  printf "verify-only ssh-ed25519 %s\n" "$VERIFY_MARKER" > "$HOME/.ssh/known_hosts"
  printf "export FLANTERMINAL_VERIFY=%s\n" "$VERIFY_MARKER" > "$HOME/.verify-shell-config"
  printf "#!/bin/sh\nprintf %s\\n\n" "$VERIFY_MARKER" > "$HOME/scripts/verify-script"
  chmod 600 "$HOME/.ssh/config" "$HOME/.ssh/known_hosts" "$HOME/.verify-shell-config"
  chmod 750 "$HOME/scripts/verify-script"
'

[ "$(change_password "$enrollment_password" "$replacement_password")" = 204 ] ||
  fail 'password rotation failed'
auth_login "$replacement_password"
pre_recreate_cookie=$auth_cookie

dc stop app >/dev/null
dc run --rm --no-deps --entrypoint node app --input-type=module - "$second_id" <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';

const id = process.argv[2];
const path = `${process.env.DATA_DIR}/tabs.json`;
const document = JSON.parse(await readFile(path, 'utf8'));
const stale = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();
document.tabs = document.tabs.map((tab) =>
  tab.id === id ? { ...tab, createdAt: stale, lastActivityAt: stale } : tab,
);
await writeFile(path, JSON.stringify(document), { mode: 0o600 });
NODE
pre_recreate_logs=$(dc logs app 2>&1)
dc rm -f app >/dev/null
dc up -d --wait

lost_session=$(session_response "$pre_recreate_cookie")
[ "$(printf '%s' "$lost_session" | json_value status)" = 200 ] &&
  [ "$(printf '%s' "$lost_session" | json_value body.authenticated)" = false ] ||
  fail 'application session survived container recreation'
old_password=$(login_response "$enrollment_password")
[ "$(printf '%s' "$old_password" | json_value status)" = 401 ] ||
  fail 'enrollment password remained valid after recreation'
auth_login "$replacement_password"

[ "$(tab_ids | wc -l | tr -d ' ')" = 2 ] || fail 'tab metadata did not survive recreation'
persisted_settings=$(api GET /api/settings)
[ "$(printf '%s' "$persisted_settings" | json_value body.settings.theme)" = ubuntu ] ||
  fail 'server-side theme did not survive recreation'
[ "$(printf '%s' "$persisted_settings" | json_value body.settings.fontSize)" = 15 ] ||
  fail 'server-side font setting did not survive recreation'
[ "$(printf '%s' "$persisted_settings" | json_value body.settings.staleSessionCleanupHours)" = 1 ] ||
  fail 'server-side cleanup setting did not survive recreation'
dc exec -T -e VERIFY_MARKER="$terminal_secret" app sh -c '
  grep -F -q "$VERIFY_MARKER" "$HOME/.ssh/known_hosts" &&
  grep -F -q "$VERIFY_MARKER" "$HOME/.verify-shell-config" &&
  grep -F -q "$VERIFY_MARKER" "$HOME/scripts/verify-script" &&
  [ "$(stat -c %a "$HOME/.ssh/config")" = 600 ] &&
  [ "$(stat -c %a "$HOME/.ssh/known_hosts")" = 600 ] &&
  [ "$(stat -c %a "$HOME/scripts/verify-script")" = 750 ]
' || fail 'home or SSH fixtures did not survive recreation'
active_tmux=$(dc exec -T app tmux list-sessions -F '#{session_name}' 2>/dev/null || true)
[ -z "$active_tmux" ] || fail 'tmux processes unexpectedly survived container recreation'

dc exec -T app tmux new-session -d -s "$first_tmux"
dc exec -T app tmux new-session -d -s "$second_tmux"
cleanup_result=$(api POST /api/admin/cleanup '{}')
[ "$(printf '%s' "$cleanup_result" | json_value status)" = 200 ] || fail 'stale cleanup failed'
[ "$(printf '%s' "$cleanup_result" | json_value body.terminated)" = 1 ] || fail 'stale cleanup did not terminate exactly one session'
[ "$(printf '%s' "$cleanup_result" | json_value body.failed)" = 0 ] || fail 'stale cleanup reported a failure'
dc exec -T app tmux has-session -t "$first_tmux" || fail 'stale cleanup terminated a recent session'
dc exec -T app tmux has-session -t "$second_tmux" >/dev/null 2>&1 && fail 'stale cleanup retained the stale session'
api POST "/api/tabs/$second_id/session/recreate" '{}' >/dev/null

count=$(tab_ids | wc -l | tr -d ' ')
while [ "$count" -lt 20 ]; do
  response=$(api POST /api/tabs '{}')
  [ "$(printf '%s' "$response" | json_value status)" = 201 ] || fail 'tab creation failed before the configured limit'
  count=$((count + 1))
done
limit=$(api POST /api/tabs '{}')
[ "$(printf '%s' "$limit" | json_value status)" = 409 ] || fail '21st tab was not rejected'

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
admin=$(api GET /api/admin)
[ "$(printf '%s' "$admin" | json_value status)" = 200 ] || fail 'administration metrics are unavailable'
[ "$(printf '%s' "$admin" | json_value body.totals.tabs)" = 20 ] || fail 'administration tab total is incorrect'
[ "$(printf '%s' "$admin" | json_value body.totals.bridges)" = 20 ] || fail 'administration bridge total is incorrect'
[ "$(printf '%s' "$admin" | json_value body.totals.webSockets)" = 20 ] || fail 'administration WebSocket total is incorrect'
rss=$(printf '%s' "$admin" | json_value body.memory.rss)
[ "$rss" -gt 0 ] && [ "$rss" -lt 536870912 ] || fail 'administration memory metric is outside the container limit'
dc exec -T app touch "$hold_stop"
wait "$hold_pid"
hold_pid=
rm -f "$hold_log"
hold_log=
wait_for_bridge_count 0 'PTY bridges leaked after multi-client disconnect'

container_logs=$(printf '%s\n%s' "$pre_recreate_logs" "$(dc logs 2>&1)")
for sensitive in "$terminal_secret" "$enrollment_password" "$replacement_password"; do
  printf '%s' "$container_logs" | rg -F -q -- "$sensitive" && fail 'terminal or authentication secret leaked to logs'
done
printf '%s\n%s\n%s' "$terminal_secret" "$enrollment_password" "$replacement_password" | \
  dc exec -T app node --input-type=module -e '
import { readFile } from "node:fs/promises";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const sensitive = input.split("\n");
for (const file of ["auth.json", "settings.json", "tabs.json"]) {
  const content = await readFile(`${process.env.DATA_DIR}/${file}`, "utf8");
  if (sensitive.some((value) => value !== "" && content.includes(value))) process.exit(1);
}
' || fail 'plaintext terminal or authentication secret was persisted in application metadata'

printf 'container verification passed\n'
