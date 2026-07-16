#!/bin/sh
set -eu

project=${E2E_PROJECT_NAME:-flanterminal_e2e_$$}
mode=${E2E_MODE:-all}
e2e_compose=
temporary_dir=

cleanup() {
  if [ -n "$e2e_compose" ]; then
    docker compose -p "$project" -f "$e2e_compose" down -v --remove-orphans \
      >/dev/null 2>&1 || true
  fi
  [ -z "$temporary_dir" ] || rm -rf "$temporary_dir"
}
trap cleanup EXIT INT TERM

run_variant() {
  name=$1
  app_base=$2
  workspace_path=$3
  shift 3
  printf 'running E2E variant: %s\n' "$name"
  docker compose -p "$project" -f "$e2e_compose" down -v --remove-orphans \
    >/dev/null 2>&1 || true
  E2E_APP_BASE_PATH=$app_base E2E_WORKSPACE_PATH=$workspace_path \
    docker compose -p "$project" -f "$e2e_compose" up --no-build --force-recreate \
      --wait -d app
  E2E_APP_BASE_PATH=$app_base E2E_WORKSPACE_PATH=$workspace_path \
    docker compose -p "$project" -f "$e2e_compose" run --rm e2e \
      npm run test:e2e:run -- "$@"
}

case $mode in
  all | local | cloudflare) ;;
  *)
    printf 'E2E_MODE must be all, local, or cloudflare\n' >&2
    exit 2
    ;;
esac

if [ "$mode" = all ] || [ "$mode" = local ]; then
  E2E_MODE=local
  export E2E_MODE
  E2E_LOCAL_PASSWORD=$(openssl rand -hex 24)
  export E2E_LOCAL_PASSWORD
  e2e_compose=docker-compose.e2e.yml
  docker compose -p "$project" -f "$e2e_compose" build
  run_variant local-root / / "$@"
  run_variant local-base-path /terminal /terminal/ "$@"
  docker compose -p "$project" -f "$e2e_compose" down -v --remove-orphans \
    >/dev/null 2>&1 || true
fi

if [ "$mode" = all ] || [ "$mode" = cloudflare ]; then
  temporary_dir=$(mktemp -d)
  E2E_MODE=cloudflare
  export E2E_MODE
  E2E_CLOUDFLARE_CA_FILE=$temporary_dir/cloudflare-ca.crt
  E2E_CLOUDFLARE_CERT_FILE=$temporary_dir/cloudflare-server.crt
  E2E_CLOUDFLARE_KEY_FILE=$temporary_dir/cloudflare-server.key
  E2E_FIXTURE_UID=$(id -u)
  E2E_FIXTURE_GID=$(id -g)
  export E2E_CLOUDFLARE_CA_FILE E2E_CLOUDFLARE_CERT_FILE E2E_CLOUDFLARE_KEY_FILE
  export E2E_FIXTURE_UID E2E_FIXTURE_GID
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 \
    -subj /CN=FlanTerminal-E2E-CA \
    -keyout "$temporary_dir/cloudflare-ca.key" \
    -out "$E2E_CLOUDFLARE_CA_FILE" >/dev/null 2>&1
  openssl req -new -newkey rsa:2048 -sha256 -nodes \
    -subj /CN=access-test.cloudflareaccess.com \
    -addext subjectAltName=DNS:access-test.cloudflareaccess.com \
    -keyout "$E2E_CLOUDFLARE_KEY_FILE" \
    -out "$temporary_dir/cloudflare-server.csr" >/dev/null 2>&1
  openssl x509 -req -sha256 -days 1 \
    -in "$temporary_dir/cloudflare-server.csr" \
    -CA "$E2E_CLOUDFLARE_CA_FILE" \
    -CAkey "$temporary_dir/cloudflare-ca.key" \
    -CAcreateserial -copy_extensions copy \
    -out "$E2E_CLOUDFLARE_CERT_FILE" >/dev/null 2>&1
  chmod 0600 "$temporary_dir/cloudflare-ca.key" "$E2E_CLOUDFLARE_KEY_FILE"
  e2e_compose=docker-compose.cloudflare-e2e.yml
  docker compose -p "$project" -f "$e2e_compose" build
  run_variant cloudflare-root / / "$@"
  run_variant cloudflare-base-path /terminal /terminal/ "$@"
fi
