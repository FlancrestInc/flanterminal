# Terminal Text Selection and Copy Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users select xterm output and copy it with the platform copy shortcut without suppressing an unselected terminal interrupt.

**Architecture:** Keep selection owned by xterm. Extend the small `TerminalLike` adapter with xterm’s selection and custom-key APIs, then register one handler per terminal instance. A dependency-owned clipboard/platform boundary makes browser behavior testable; the E2E test proves selection and clipboard integration in Chromium.

**Tech Stack:** React 19, TypeScript, xterm 6, Vitest/Testing Library, Playwright.

---

## File structure

- `apps/client/src/Terminal.tsx` — xterm adapter and lifecycle-owned copy shortcut handler.
- `apps/client/src/Terminal.test.tsx` — unit coverage for terminal-level shortcut semantics and clipboard failures.
- `e2e/terminal.spec.ts` — browser-level selection/copy regression test.

## Chunk 1: Terminal adapter and unit coverage

### Task 1: Specify selected-copy behavior in a failing unit test

**Files:**
- Modify: `apps/client/src/Terminal.test.tsx:47-151`
- Modify: `apps/client/src/Terminal.test.tsx:154-416`

- [ ] **Step 1: Extend the fake terminal only with the unimplemented xterm adapter surface.**

  Add `hasSelection()`, `getSelection()`, and
  `attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean)` to
  `FakeTerminal`. Store the latest handler and add a helper that invokes it so
  tests exercise the real callback rather than an implementation detail.

- [ ] **Step 2: Add a focused failing test for selected Ctrl+C on non-macOS.**

  Configure the fake selection as `"copied terminal output"`. In test setup,
  define a configurable `navigator.clipboard` object with a `writeText` spy,
  then spy on that function; set the browser platform through
  `Object.defineProperty(navigator, 'platform', ...)`, and invoke the registered
  handler with a cancelable `KeyboardEvent('keydown', { key: 'c', ctrlKey:
  true })`, and expect `navigator.clipboard.writeText` to receive the exact selection,
  `event.defaultPrevented` to be true, and the xterm handler result to be
  `false`. Give the fake an additional helper that models xterm forwarding an
  accepted Ctrl+C as `onData('\\x03')`, so pass-through tests can prove the
  existing socket path receives the interrupt. Restore the original clipboard
  and platform descriptors in `afterEach` so each platform case is isolated.

- [ ] **Step 3: Run the focused test to verify it fails.**

  Run: `npm test -w @flanterminal/client -- Terminal.test.tsx -t "copies selected text with Ctrl+C"`

  Expected: FAIL because the fake/production adapter and dependencies do not
  expose the selection, handler, or clipboard behavior yet.

- [ ] **Step 4: Add failing tests for platform and failure boundaries.**

  Add one test proving selected `Cmd+C` copies on macOS while selected macOS
  `Ctrl+C` returns `true` and does not cancel. Add tests proving no-selection
  Ctrl+C on both non-macOS and macOS returns `true`, leaves
  `defaultPrevented` false, and—through the fake forwarding helper—sends
  `'\\x03'` to the existing socket input path. Add a no-selection macOS
  `Cmd+C` test that prevents the browser event, returns `false`, makes no
  clipboard write, and sends no terminal input. Add separate tests where
  `navigator.clipboard.writeText` rejects, throws synchronously, or is
  unavailable; in each case, assert the event remains cancelled and the
  terminal does not throw.
  Add `Alt+C` and combined Cmd+Ctrl+C assertions to prove altered shortcuts are
  not intercepted.

- [ ] **Step 5: Run the focused unit group to verify it fails for the missing behavior.**

  Run: `npm test -w @flanterminal/client -- Terminal.test.tsx -t "selected text|unselected Ctrl|macOS|clipboard failure|altered shortcut"`

  Expected: FAIL only because the copy shortcut behavior has not been
  implemented.

### Task 2: Implement the minimal xterm copy boundary

**Files:**
- Modify: `apps/client/src/Terminal.tsx:33-111`
- Modify: `apps/client/src/Terminal.tsx:156-263`
- Test: `apps/client/src/Terminal.test.tsx`

- [ ] **Step 1: Add the adapter and local clipboard contracts.**

  Extend `TerminalLike` with xterm-compatible
  `hasSelection`, `getSelection`, and `attachCustomKeyEventHandler`. In the
  real adapter, delegate each method to `XtermTerminal`. Keep the browser
  clipboard boundary in a small local helper that calls
  `navigator.clipboard.writeText(text)` and derives macOS from
  `navigator.platform`. The helper must not store copied output and must remain
  safely callable when clipboard support is unavailable.

- [ ] **Step 2: Register the handler with the terminal instance.**

  Immediately after `terminal.open(host)`, call
  `attachCustomKeyEventHandler`. It must recognize lowercase/uppercase C,
  reject altered shortcuts other than the platform copy modifier, and apply
  `Ctrl+C` only off macOS or `Cmd+C` only on macOS. For a non-empty selection,
  call `event.preventDefault()` synchronously, invoke the local clipboard
  helper with both synchronous throws and promise rejections caught, and return
  `false`. With no selection, return `true` for Ctrl+C; on macOS, cancel
  unselected Cmd+C and return `false` without a clipboard call. Do not call
  `stopPropagation()` and do not add a cleanup callback: xterm owns this
  handler for the lifetime of its terminal object.

- [ ] **Step 3: Run the focused unit group to verify it passes.**

  Run: `npm test -w @flanterminal/client -- Terminal.test.tsx -t "selected text|unselected Ctrl|macOS|clipboard failure|altered shortcut"`

  Expected: PASS with all selected-copy tests green.

- [ ] **Step 4: Run the full client suite and typecheck.**

  Run: `npm test -w @flanterminal/client && npm run typecheck -w @flanterminal/client`

  Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Commit the unit-tested implementation.**

  ```bash
  git add apps/client/src/Terminal.tsx apps/client/src/Terminal.test.tsx
  git commit -m "feat(client): copy selected terminal text"
  ```

## Chunk 2: Browser regression coverage

### Task 3: Add end-to-end selection/copy coverage

**Files:**
- Modify: `e2e/terminal.spec.ts:1-70`

- [ ] **Step 1: Add an E2E helper that selects terminal output.**

  After sending a unique single-word marker and waiting for it to render, find
  `.xterm-rows > div` whose text contains that marker and obtain its bounding
  box. Double-click at `x: 4` and the row’s vertical midpoint, relative to the
  row locator. xterm's native word selection chooses the entire marker at
  column zero without relying on undocumented column or font metrics. Grant
  the page origin `clipboard-read` and `clipboard-write` permissions before
  navigating.

- [ ] **Step 2: Add a focused regression test.**

  Clear the clipboard, press `Control+C` after the double-click, and read
  `navigator.clipboard.readText()` in the page context. Assert the exact
  marker is copied (without unrelated prompt/output text). The test should run
  on the normal Linux Chromium E2E project, matching the non-macOS shortcut
  contract.

- [ ] **Step 3: Run the focused E2E test to verify the browser integration.**

  Run: `E2E_MODE=local E2E_LOCAL_PASSWORD=debug-local-password npm run test:e2e:run -- e2e/terminal.spec.ts -g "copies selected terminal text"`

  Expected: PASS after Task 2’s unit-tested implementation; the browser
  clipboard contains exactly the selected marker.

- [ ] **Step 4: Adjust only deterministic selection mechanics if required.**

  Keep the test focused on native word selection and copy interaction; wait for
  the marker and use its rendered row geometry rather than adding any test-only
  application API.

- [ ] **Step 5: Run the focused E2E test to verify it passes.**

  Run: `E2E_MODE=local E2E_LOCAL_PASSWORD=debug-local-password npm run test:e2e:run -- e2e/terminal.spec.ts -g "copies selected terminal text"`

  Expected: PASS and the clipboard text equals the marker.

- [ ] **Step 6: Commit the E2E regression coverage.**

  ```bash
  git add e2e/terminal.spec.ts
  git commit -m "test(e2e): cover terminal text copy"
  ```

### Task 4: Final verification

**Files:**
- Verify: `apps/client/src/Terminal.tsx`
- Verify: `apps/client/src/Terminal.test.tsx`
- Verify: `e2e/terminal.spec.ts`

- [ ] **Step 1: Re-read the approved spec and check each requirement.**

  Confirm native selection remains xterm-owned; selected platform copy cancels
  browser/xterm processing; unselected terminal interrupts still pass through;
  clipboard failure is harmless; and no paste or context-menu behavior changed.

- [ ] **Step 2: Run final local verification.**

  Run: `npm test -w @flanterminal/client && npm run typecheck -w @flanterminal/client && E2E_MODE=local E2E_LOCAL_PASSWORD=debug-local-password npm run test:e2e:run -- e2e/terminal.spec.ts -g "copies selected terminal text"`

  Expected: PASS with zero failures.

- [ ] **Step 3: Inspect the final diff before handoff.**

  Run: `git diff main...HEAD --check && git status --short`

  Expected: no whitespace errors and only the intended committed changes.
