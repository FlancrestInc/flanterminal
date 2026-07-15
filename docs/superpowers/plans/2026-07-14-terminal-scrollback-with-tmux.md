# Terminal Scrollback With Tmux Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the initial managed tmux window in xterm’s normal buffer so its configured browser scrollback can be navigated with the mouse wheel.

**Architecture:** Apply tmux’s `alternate-screen off` as a window option to the initial build-session window before its bootstrap pane is replaced. Remove the bespoke client wheel adapter and let xterm’s native viewport handle normal-buffer scrollback. Prove command construction in server tests and visible wheel-driven history in the existing terminal Playwright flow.

**Tech Stack:** TypeScript, Node.js, tmux, React, xterm.js 6, Vitest, Playwright.

**Design:** `docs/superpowers/specs/2026-07-14-terminal-scrollback-with-tmux-design.md`

---

## Chunk 1: Normal-Buffer Tmux Sessions And Native Wheel Scrolling

### Task 1: Reproduce browser scrollback failure

**Files:**

- Modify: `e2e/terminal.spec.ts`

- [ ] **Step 1: Write the failing browser-level scrollback test.**

  In `e2e/terminal.spec.ts`, open a managed terminal and print deterministic,
  non-wrapping output with an early unique marker, 200 numbered lines, and a
  final unique marker. Confirm the final marker is visible, hover the active
  terminal’s `.xterm-screen`, and use `page.mouse.wheel(0, -120)` repeatedly
  with polling until the early marker should be visible. The assertion must
  time out on the current alternate-screen configuration.

- [ ] **Step 2: Run the new E2E test to observe RED.**

  ```sh
  npm run test:e2e -- --grep "scrollback"
  ```

  Expected: FAIL because the initial tmux window enters xterm's alternate
  buffer and therefore has no browser scrollback to reveal.

### Task 2: Configure the initial managed tmux window

**Files:**

- Modify: `apps/server/src/tmux.test.ts`
- Modify: `apps/server/src/tmux.ts`

- [ ] **Step 1: Write a failing argument-array assertion.**

  In `TmuxSessionPreparer`’s creation test, require this command segment after
  the existing session options and before `split-window`:

  ```ts
  ';',
  'set-window-option',
  '-t',
  `${BUILD_SESSION_NAME}:0`,
  'alternate-screen',
  'off',
  ```

  Assert the target is exactly the generated build session’s initial window,
  and assert the command does not use global-option flags. Keep existing tests
  proving only the build session is mutated and an existing session is not
  changed.

- [ ] **Step 2: Run the focused test to observe RED.**

  ```sh
  npm test -w @flanterminal/server -- --run src/tmux.test.ts
  ```

  Expected: FAIL because session creation does not yet configure
  `alternate-screen`.

- [ ] **Step 3: Add the minimal tmux command.**

  In `TmuxSessionPreparer.prepare`, define the existing initial window target
  as `${buildName}:0` (separate from the pane target `${buildName}:`) and add
  the exact `set-window-option -t <build>:0 alternate-screen off` segment
  before `split-window`. Do not change `history-limit`, default shell/command,
  cleanup, rename, or attach behavior.

- [ ] **Step 4: Verify focused server tests and commit.**

  ```sh
  npm test -w @flanterminal/server -- --run src/tmux.test.ts
  git add apps/server/src/tmux.ts apps/server/src/tmux.test.ts
  git commit -m "fix(server): retain tmux output in browser scrollback"
  ```

  Expected: test passes and the commit is limited to tmux setup/coverage.

### Task 3: Restore native xterm wheel behavior and prove visible scrollback

**Files:**

- Modify: `apps/client/src/Terminal.tsx`
- Modify: `apps/client/src/Terminal.test.tsx`
- Modify: `e2e/terminal.spec.ts`

- [ ] **Step 1: Remove the custom wheel adapter tests.**

  Delete the fake terminal wheel listener, `scrollLines` adapter member,
  wheel-event factory, and all bespoke wheel behavior tests from
  `Terminal.test.tsx`. Run the focused client test to ensure the simplified
  adapter test double still compiles before changing `Terminal.tsx`.

- [ ] **Step 2: Remove the custom client wheel interception.**

  Delete `PIXELS_PER_SCROLL_LINE`, `TerminalLike.scrollLines`,
  `TerminalLike.attachCustomWheelEventHandler`, their default xterm adapter
  proxies, and the handler registration after `terminal.open(host)`. Leave the
  constructor’s `scrollback: settings.scrollback` option and all normal
  `onData` socket forwarding intact so xterm’s native viewport processes wheel
  events.

- [ ] **Step 3: Verify client and E2E behavior.**

  ```sh
  npm test -w @flanterminal/client -- --run src/Terminal.test.tsx
  npm run test:e2e -- --grep "scrollback"
  ```

  The E2E test must also wheel downward until the existing final marker is
  visible *before* sending a new command, then confirm a new unique output
  marker. Expected: client tests pass; browser scrolling reaches both retained
  markers and live terminal input/output remains functional.

- [ ] **Step 4: Run formatting, full validation, and commit.**

  ```sh
  npx prettier --check apps/client/src/Terminal.tsx apps/client/src/Terminal.test.tsx e2e/terminal.spec.ts
  npm run lint
  npm run typecheck
  npm test
  git diff --check
  git add apps/client/src/Terminal.tsx apps/client/src/Terminal.test.tsx e2e/terminal.spec.ts
  git commit -m "fix(client): use native terminal scrollback"
  ```

  Expected: all commands succeed; the commit removes only the obsolete custom
  wheel implementation and adds end-to-end browser-scrollback coverage.
