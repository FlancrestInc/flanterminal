# Terminal Wheel Scrollback Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ordinary vertical mouse-wheel motion scroll the xterm scrollback viewport without reporting wheel input to the connected terminal program.

**Architecture:** Keep the behavior inside the client-side xterm adapter in `Terminal.tsx`. Register xterm's custom wheel hook after opening the terminal; handled vertical events are normalized to integer terminal rows, scrolled with xterm's own buffer API, explicitly browser-cancelled, and rejected from xterm's native mouse-reporting path. The existing fake terminal tests exercise the hook directly, so the behavior remains isolated from socket and browser integration details.

**Tech Stack:** TypeScript, React 19, xterm.js 6, Vitest, Testing Library.

**Design:** `docs/superpowers/specs/2026-07-14-terminal-wheel-scrollback-design.md`

---

## Chunk 1: Terminal Wheel Handling

### Task 1: Specify the terminal adapter contract with failing tests

**Files:**

- Modify: `apps/client/src/Terminal.test.tsx`

- [ ] **Step 1: Extend `FakeTerminal` with controllable xterm wheel behavior.**

  Add `scrollLines = vi.fn()` and an `attachCustomWheelEventHandler = vi.fn()`
  that retains the listener. Add an `emitWheel(event)` helper returning the
  retained handler result. This makes the test double conform to the expanded
  xterm adapter without coupling tests to xterm's DOM internals.

- [ ] **Step 2: Write failing tests for handled vertical input.**

  Construct plain wheel-event doubles containing `deltaX`, `deltaY`,
  `deltaMode`, modifier flags, and `preventDefault`. Assert that terminal
  initialization registers one handler and that:

  - a positive line-mode vertical delta calls `scrollLines` with the same
    positive whole-line count, calls `preventDefault`, and returns `false`;
  - a negative line-mode delta scrolls upward with the negative count;
  - page-mode input multiplies its rounded page count by the current terminal
    `rows` value (24 in the fixture);
  - pixel-mode input accumulates small deltas until the 40-pixel threshold,
    preserves the remainder, then scrolls the resulting whole number of rows;
  - an already-at-boundary event is still cancelled (the adapter always calls
    `scrollLines`, leaving xterm to clamp its buffer position).

- [ ] **Step 3: Write failing passthrough and lifecycle regression tests.**

  Assert that Ctrl/Meta, Shift, and horizontal-dominant wheel events return
  `true`, do not call `scrollLines`, and do not call `preventDefault`. Rerender
  with a constructor-setting change (for example `fontSize`) and assert the
  replacement terminal has its own handler while the old terminal is disposed.
  Keep the existing `onData` test and add an assertion after handled-wheel
  input that `socket.sendInput` has not received wheel-derived data.

- [ ] **Step 4: Run the focused test and confirm it fails for missing adapter methods.**

  Run:

  ```sh
  npm test -w @flanterminal/client -- --run src/Terminal.test.tsx
  ```

  Expected: FAIL because `TerminalLike`/`FakeTerminal` and production setup do
  not yet expose or register the custom wheel hook.

### Task 2: Implement the xterm wheel adapter

**Files:**

- Modify: `apps/client/src/Terminal.tsx`
- Test: `apps/client/src/Terminal.test.tsx`

- [ ] **Step 1: Extend the local terminal abstraction and real adapter.**

  Add these methods to `TerminalLike` and proxy them in `defaultDependencies`:

  ```ts
  scrollLines(amount: number): void;
  attachCustomWheelEventHandler(
    handler: (event: WheelEvent) => boolean,
  ): void;
  ```

  The real adapter delegates them directly to `XtermTerminal.scrollLines` and
  `XtermTerminal.attachCustomWheelEventHandler`.

- [ ] **Step 2: Register one local handler for each terminal instance.**

  Immediately after `terminal.open(host)`, retain a per-instance pixel
  remainder initialized to `0`, then register the handler. Return `true`
  without modification for Ctrl/Meta, Shift, or horizontal-dominant gestures.
  For ordinary vertical gestures, compute integer rows using this policy:

  ```ts
  // deltaMode: 0 = pixels, 1 = lines, 2 = pages
  const rows =
    event.deltaMode === 2 ? Math.round(event.deltaY) * terminal.rows
    : event.deltaMode === 1 ? Math.round(event.deltaY)
    : consumePixelDelta(event.deltaY, 40);
  ```

  `consumePixelDelta` adds to the retained remainder, emits its truncation
  toward zero divided by `40`, and keeps the fractional remainder. For every
  handled event, call `event.preventDefault()`, call `terminal.scrollLines(rows)`
  only when `rows !== 0`, and return `false`. Do not send any wheel data through
  `sendInput`; xterm sees `false` and therefore does not perform mouse
  reporting. Keep the helper private to this module unless extracting it is
  necessary for clear testing.

- [ ] **Step 3: Run the focused test and make it pass.**

  Run:

  ```sh
  npm test -w @flanterminal/client -- --run src/Terminal.test.tsx
  ```

  Expected: PASS, including existing resize, bell, cleanup, and socket tests.

- [ ] **Step 4: Format and run package-level validation.**

  Run:

  ```sh
  npx prettier --check apps/client/src/Terminal.tsx apps/client/src/Terminal.test.tsx
  npm run typecheck -w @flanterminal/client
  npm test -w @flanterminal/client
  ```

  Expected: all commands exit successfully.

- [ ] **Step 5: Run repository checks and commit.**

  Run:

  ```sh
  npm run lint
  npm run typecheck
  git diff --check
  git add apps/client/src/Terminal.tsx apps/client/src/Terminal.test.tsx
  git commit -m "fix(client): scroll terminal history with mouse wheel"
  ```

  Expected: lint, typecheck, and whitespace checks pass; the commit contains
  only the terminal adapter and its regression coverage.
