# Contributing to FlanTerminal

Contributions should preserve FlanTerminal's central boundary: persistent tmux
sessions run inside the application container, while remote machines require
only SSH. Keep changes focused on the Version 1 terminal workspace unless a
broader design has been agreed first.

## Development setup

Development requires Node.js 24 or newer, npm, tmux at `/usr/bin/tmux`, and SSH
at `/usr/bin/ssh`.

```sh
npm ci
HOME_DIR="$HOME" DATA_DIR=/tmp/flanterminal-data AUTH_MODE=none npm run dev
```

Open <http://localhost:5173>. Development authentication is intentionally
disabled by that command; never expose the development listener to an
untrusted network.

## Required checks

Run the focused tests while developing and the complete relevant gate before
submitting a change:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
docker compose build
npm run test:e2e
./scripts/verify-container.sh
```

Docker and Playwright checks create isolated projects and remove their test
volumes. Do not point them at a production Compose project or persistent home.

## Engineering expectations

- Add tests for behavioral changes and regressions.
- Keep terminal input and output out of logs, errors, fixtures, and metadata.
- Preserve strict validation for IDs, display names, frames, configuration, and
  proxy identity.
- Treat authentication, CSRF, WebSocket upgrades, PTY ownership, tmux lifecycle,
  filesystem durability, and reverse-proxy trust as security-sensitive code.
- Keep browser scrollback, tmux history, output buffering, sessions, and metrics
  bounded.
- Do not add remote agents or require software on SSH destination machines.
- Do not commit `.env`, passwords, tokens, SSH material, certificates, runtime
  data, terminal captures, Playwright reports, or generated build output.

Use clear, scoped commits. Explain deployment or compatibility effects in the
pull request and update README configuration, persistence, security, backup, or
upgrade guidance when those contracts change.

## Security reports

Do not use a public issue for a suspected vulnerability. Follow
[SECURITY.md](SECURITY.md).
