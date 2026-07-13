# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS dependencies

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY package.json package-lock.json ./
COPY apps/client/package.json apps/client/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

FROM dependencies AS build
COPY tsconfig.base.json eslint.config.js vitest.config.ts ./
COPY apps apps
COPY packages packages
COPY scripts/verify-production-dist.mjs scripts/verify-production-dist.mjs
RUN npm run build -w @flanterminal/shared \
  && npm run build -w @flanterminal/client \
  && npm run build -w @flanterminal/server \
  && npm run verify:dist

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ARG PUID=1000
ARG PGID=1000
ARG APP_PORT=3000

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates libstdc++6 openssh-client tini tmux tzdata \
  && rm -rf /var/lib/apt/lists/* \
  && set -eu; \
    groupmod -n webterm node; \
    usermod -l webterm -d /home/webterm -m node; \
    existing_group="$(getent group "$PGID" | cut -d: -f1 || true)"; \
    if [ -n "$existing_group" ] && [ "$existing_group" != webterm ]; then \
      echo "Requested PGID $PGID is already used by $existing_group" >&2; exit 1; \
    fi; \
    existing_user="$(getent passwd "$PUID" | cut -d: -f1 || true)"; \
    if [ -n "$existing_user" ] && [ "$existing_user" != webterm ]; then \
      echo "Requested PUID $PUID is already used by $existing_user" >&2; exit 1; \
    fi; \
    current_gid="$(id -g webterm)"; \
    [ "$current_gid" = "$PGID" ] || groupmod -g "$PGID" webterm; \
    current_uid="$(id -u webterm)"; \
    [ "$current_uid" = "$PUID" ] || usermod -u "$PUID" -g "$PGID" webterm; \
    install -d -o webterm -g webterm -m 0755 /home/webterm; \
    install -d -o webterm -g webterm -m 0700 /home/webterm/.ssh; \
    install -d -o webterm -g webterm -m 0755 /home/webterm/scripts; \
    install -d -o webterm -g webterm -m 0700 /app/data; \
    touch /home/webterm/.bash_history; \
    chown webterm:webterm /home/webterm/.bash_history; \
    chmod 0600 /home/webterm/.bash_history; \
    chmod 0750 /home/webterm/scripts

WORKDIR /app
COPY --from=production-dependencies /build/node_modules ./node_modules
RUN chmod -R a-w /app/node_modules
COPY --from=build /build/package.json /build/package-lock.json ./
COPY --from=build /build/apps/server/package.json apps/server/package.json
COPY --from=build /build/apps/server/dist apps/server/dist
COPY --from=build /build/apps/client/package.json apps/client/package.json
COPY --from=build /build/apps/client/dist apps/client/dist
COPY --from=build /build/packages/shared/package.json packages/shared/package.json
COPY --from=build /build/packages/shared/dist packages/shared/dist

RUN node --input-type=module -e "await import('bcrypt'); await import('jose')" \
  && test -n "$(find apps/client/dist/assets -type f -name 'JetBrainsMonoNerdFont-Regular-*.ttf' -print -quit)" \
  && test -n "$(find apps/client/dist/assets -type f -name 'terminal-bell-*.wav' -print -quit)" \
  && chmod -R a-w /app/package.json /app/package-lock.json /app/apps /app/packages \
  && chown webterm:webterm /app/data \
  && chmod 0700 /app/data

ENV HOME=/home/webterm \
    USER=webterm \
    LOGNAME=webterm \
    TERM=xterm-256color \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8
USER webterm
EXPOSE ${APP_PORT}
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.APP_PORT||'3000')+'/health').then(async r=>{const v=await r.json();if(!r.ok||v.status!=='ok')process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/dist/index.js"]
