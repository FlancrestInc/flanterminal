#!/bin/sh
set -eu

e2e_compose=docker-compose.e2e.yml
project=${E2E_PROJECT_NAME:-flanterminal_e2e_$$}

cleanup() {
  docker compose -p "$project" -f "$e2e_compose" down -v --remove-orphans \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

run_variant() {
  name=$1
  app_base=$2
  workspace_path=$3
  printf 'running E2E variant: %s\n' "$name"
  E2E_APP_BASE_PATH=$app_base E2E_WORKSPACE_PATH=$workspace_path \
    docker compose -p "$project" -f "$e2e_compose" up --no-build --force-recreate \
      --abort-on-container-exit --exit-code-from e2e
}

docker compose -p "$project" -f "$e2e_compose" build
run_variant root / /
run_variant base-path /terminal /terminal/
