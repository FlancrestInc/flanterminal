# Terminal Wheel Capture Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scroll retained tmux history after reconnect and later xterm history without recalling shell commands, while preserving ordinary drag selection.

**Architecture:** Keep tmux mouse enabled for retained history, delegate wheel only while xterm has no browser-local scrollback, then capture it with xterm's supported wheel hook. Force ordinary primary-button drags into xterm selection at the DOM boundary so tmux mouse mode does not require Shift-drag. Strengthen the E2E harness and exact reconnect regression in Chromium and Firefox.

**Tech Stack:** TypeScript, React, xterm.js 6, Vitest, Playwright, POSIX shell, Docker Compose.

**Design:** `docs/superpowers/specs/2026-07-16-terminal-wheel-capture-design.md`

---

## Chunk 1: Hybrid retained-history wheel ownership

### Task 1: Route wheels to the history owner and preserve selection

**Files:**

- Modify: `apps/client/src/Terminal.test.tsx`
- Modify: `apps/client/src/Terminal.tsx`

- [ ] **Step 1: Add the failing terminal wheel tests.**

  Extend `TerminalLike`'s fake in `Terminal.test.tsx` with captured custom wheel
  handler and `scrollLines` spy. Add focused tests proving:

  - signed line deltas accumulate fractional lines, emit only integers, return
    `false`, call `preventDefault`, and never call `socket.sendInput`;
  - page deltas use `Math.max(terminal.rows - 1, 1)`;
  - pixel deltas divide by rendered row height, fall back to
    `fontSize * lineHeight`, retain fractions, and reset the fraction on
    direction changes;
  - Ctrl, Meta, Shift, Alt, and primarily horizontal gestures return `true`,
    do not prevent default or scroll, and reset any pending remainder;
  - recreating xterm registers a distinct handler on the new instance.
  - wheels delegate while xterm `baseY` is zero so tmux can expose retained
    history after reconnect;
  - ordinary primary-button drag is forced into xterm selection even while the
    tmux mouse protocol is active.

- [ ] **Step 2: Run the focused client test and observe RED.**

  Run: `npm test -w @flanterminal/client -- --run src/Terminal.test.tsx`

  Expected: FAIL because `TerminalLike` and the component do not expose or
  register custom wheel scrolling.

- [ ] **Step 3: Implement the minimal supported wheel handler.**

  In `Terminal.tsx`:

  - add `scrollLines(amount: number)` and
    `attachCustomWheelEventHandler(handler)` to `TerminalLike` and the default
    xterm adapter;
  - after `terminal.open(host)`, attach one handler with a per-instance
    fractional line remainder and direction;
  - expose whether xterm currently has scrollback and delegate while it does
    not; also delegate modified, zero-vertical, and primarily horizontal gestures,
    resetting the remainder;
  - convert line, page, and pixel delta modes exactly as the design specifies;
  - use `.xterm-rows > div` CSS height when positive and finite, otherwise use
    `settings.fontSize * settings.lineHeight`;
  - truncate accumulated lines toward zero, retain the unused fraction, call
    `scrollLines` only with nonzero integers, call `preventDefault`, and return
    `false` for every handled vertical gesture.
  - keep managed tmux mouse migration on and capture ordinary primary-button
    mousedown before xterm, redispatching it with xterm's platform-specific
    force-selection modifier; remove the listener on cleanup.

- [ ] **Step 4: Run the focused client test and observe GREEN.**

  Run: `npm test -w @flanterminal/client -- --run src/Terminal.test.tsx`

  Expected: all terminal tests pass.

- [ ] **Step 5: Commit the client behavior.**

  ```sh
  git add apps/client/src/Terminal.tsx apps/client/src/Terminal.test.tsx
  git commit -m "fix(client): keep wheel scrolling browser-local"
  ```

### Task 2: Make cross-browser E2E verification real

**Files:**

- Modify: `playwright.config.ts`
- Modify: `scripts/run-e2e.sh`
- Modify: `e2e/terminal.spec.ts`

- [ ] **Step 1: Strengthen the wheel E2E assertion.**

  Create retained output before detach/full reload, begin from tmux mouse off,
  verify reconnect migration, then wheel before creating browser-local history.
  Keep draft/history assertions, require the scroll position to change, and
  cover ordinary unmodified full-row drag selection.

- [ ] **Step 2: Configure explicit browser projects.**

  In `playwright.config.ts`, set the enrollment project to Chromium. Replace
  `workflows` with `workflows-chromium` and `workflows-firefox`, both ignoring
  the setup test and depending on `first-run-auth`, with explicit
  `use.browserName` values.

- [ ] **Step 3: Forward E2E wrapper arguments without re-parsing.**

  In `scripts/run-e2e.sh`, have `run_variant` shift its three routing arguments,
  start the Compose `app` service with
  `up --no-build --force-recreate --wait -d app` so the app healthcheck and any
  Cloudflare fixture dependency are healthy before testing, then run the E2E
  service with:

  ```sh
  docker compose ... run --rm e2e npm run test:e2e:run -- "$@"
  ```

  Pass the script's original `"$@"` to every `run_variant` call. Preserve
  per-variant teardown, environment interpolation, exit status, and cleanup.

- [ ] **Step 4: Run the exact Chromium regression.**

  Run:

  ```sh
  E2E_MODE=local npm run test:e2e -- --project workflows-chromium --grep "native xterm scrolling exposes managed-session history"
  ```

  Expected: PASS in Chromium and output shows only the requested workflow test
  plus its setup dependency for each local base-path variant.

- [ ] **Step 5: Run the exact Firefox regression.**

  Run:

  ```sh
  E2E_MODE=local npm run test:e2e -- --project workflows-firefox --grep "native xterm scrolling exposes managed-session history"
  ```

  Expected: PASS in Firefox and output shows only the requested workflow test
  plus its setup dependency for each local base-path variant.

- [ ] **Step 6: Commit the cross-browser harness.**

  ```sh
  git add playwright.config.ts scripts/run-e2e.sh e2e/terminal.spec.ts
  git commit -m "test: cover terminal wheel scrolling across browsers"
  ```

### Task 3: Validate the completed fix

**Files:** No new files.

- [ ] **Step 1: Format changed files.**

  Run:

  ```sh
  npx prettier --write apps/client/src/Terminal.tsx apps/client/src/Terminal.test.tsx playwright.config.ts e2e/terminal.spec.ts
  ```

- [ ] **Step 2: Run static and unit validation.**

  Run each command and require exit 0:

  ```sh
  npm run lint
  npm run typecheck
  npm test
  npm run build
  git diff --check
  ```

- [ ] **Step 3: Re-run both exact browser regressions after formatting.**

  Run the exact Chromium and Firefox commands from Tasks 2.4 and 2.5 again.
  Expected: both pass for root and `/terminal` base-path variants.

- [ ] **Step 4: Confirm scope.**

  Verify `git status --short`, `git log --oneline main..HEAD`, and
  `git diff --stat main...HEAD`. Only the design docs, terminal client/tests,
  Playwright config, E2E wrapper, and terminal E2E test may differ.
