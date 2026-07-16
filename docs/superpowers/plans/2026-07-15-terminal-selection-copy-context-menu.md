# Terminal Selection, Copy, and Context-Menu Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore ordinary terminal text selection, copy selected text with the platform shortcut, and prevent browser and tmux context menus from overlapping the terminal.

**Architecture:** Configure each managed tmux session with mouse reporting disabled, which lets xterm retain its native selection behavior. Extend the local xterm adapter with selection and custom-key APIs, use that handler only for selected-text copy, and cancel `contextmenu` on the terminal host.

**Tech Stack:** TypeScript, React 19, xterm.js 6, Node.js, tmux, Vitest, Playwright.

---

## Chunk 1: Restore xterm Selection Ownership

### Task 1: Configure managed tmux sessions without mouse reporting

**Files:**
- Modify: `apps/server/src/tmux.test.ts`
- Modify: `apps/server/src/tmux.ts`

- [ ] **Step 1: Change creation and existing-session expectations.**

In the existing `TmuxSessionPreparer` creation test, remove the expected
creation-time `set-option ... mouse on` command and expect a separate,
targeted `set-option ... mouse off` command after creation. Add an
already-existing-session case that expects the same targeted command.
Add a non-zero result case for that targeted command; `prepare()` must reject
with its bounded `Tmux command failed` error rather than returning an attach
spec for a session that still reports mouse events.

- [ ] **Step 2: Run the focused server test and verify it fails.**

Run: `npm test -w @flanterminal/server -- --run src/tmux.test.ts`

Expected: FAIL because the production command still enables mouse reporting
during creation, does not migrate an existing managed session, and does not
reject a failed migration.

- [ ] **Step 3: Make the minimal tmux configuration change.**

Remove the creation command's `mouse on` option. After the creation-or-exists
branch, run a targeted `set-option -t <managed-session> mouse off` command.
This applies the setting to both a newly created session and a persisted
existing one without changing global tmux settings, window setup, or
user-created sessions. Check the returned exit code and throw the existing
bounded error for a non-zero result. Do not issue a cleanup kill after this
post-creation migration: another request can replace the managed session under
the same tab ID between migration failure and cleanup. A later prepare retries
the targeted `mouse off` migration safely.

- [ ] **Step 4: Re-run the focused server test.**

Run: `npm test -w @flanterminal/server -- --run src/tmux.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the server behavior and test.**

```bash
git add apps/server/src/tmux.ts apps/server/src/tmux.test.ts
git commit -m "fix(server): restore terminal text selection"
```

## Chunk 2: Copy and Browser Context-Menu Handling

### Task 2: Specify selected-copy and context-menu behavior

**Files:**
- Modify: `apps/client/src/Terminal.test.tsx`
- Modify: `apps/client/src/Terminal.tsx`

- [ ] **Step 1: Expand the fake terminal surface.**

Add `selection`, `hasSelection`, `getSelection`, and an
`attachCustomKeyEventHandler` implementation to `FakeTerminal`. Retain the
handler and provide a `key(event)` helper that invokes it. Add an
accepted-control helper that sends `\x03` through `input` when the retained
handler returns `true`; this models xterm's forwarding path to the existing
socket listener without requiring an xterm DOM instance.

- [ ] **Step 2: Add failing selected-copy tests.**

Add tests that set fake selection text and assert:

```ts
expect(terminal.key(keyEvent({ ctrlKey: true }))).toBe(false);
expect(event.defaultPrevented).toBe(true);
expect(clipboardWrite).toHaveBeenCalledWith('copied terminal output');
```

Cover Windows/Linux `Ctrl+C`, macOS `Cmd+C`, and clipboard rejection or
synchronous throw. Use the accepted-control helper to assert unselected
`Ctrl+C` reaches the existing socket input listener. Assert unselected macOS
`Cmd+C` also returns `true` without browser cancellation; no copy handler may
intercept a shortcut when there is no selection. With a selection on macOS,
also assert `Ctrl+C` returns `true`, leaves the clipboard untouched, does not
cancel the browser event, and forwards `\x03` to the socket; only `Cmd+C` may
copy the selected text.

- [ ] **Step 3: Add a failing browser-menu test.**

Render `Terminal`, dispatch a cancelable `contextmenu` event on the terminal
region, and assert `event.defaultPrevented` is true. Continue asserting that
the configured xterm options retain `rightClickSelectsWord: true`.

- [ ] **Step 4: Run the focused client test and verify it fails.**

Run: `npm test -w @flanterminal/client -- --run src/Terminal.test.tsx`

Expected: FAIL because `TerminalLike` does not expose the selection/key API,
no copy handler is registered, and the host does not cancel `contextmenu`.

- [ ] **Step 5: Implement the xterm adapter and selected-copy helper.**

Extend `TerminalLike` and `defaultDependencies` with:

```ts
hasSelection(): boolean;
getSelection(): string;
attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
```

Add a private clipboard helper that invokes `navigator.clipboard?.writeText`
and absorbs synchronous throws and promise rejections. Immediately after
`terminal.open(host)`, register one custom key handler. It must return `false`
and call `preventDefault()` only for the platform copy shortcut when selected;
all unselected copy shortcuts must return `true`.

- [ ] **Step 6: Cancel the terminal host context-menu event.**

Add `onContextMenu={(event) => event.preventDefault()}` to the returned
terminal host. Do not stop propagation or alter the existing right-click
word-selection option.

- [ ] **Step 7: Re-run the focused client test.**

Run: `npm test -w @flanterminal/client -- --run src/Terminal.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit the client behavior and test.**

```bash
git add apps/client/src/Terminal.tsx apps/client/src/Terminal.test.tsx
git commit -m "fix(client): copy selected terminal text"
```

## Chunk 3: Browser-Level Regression Coverage

### Task 3: Prove an ordinary drag stays selected and copies

**Files:**
- Modify: `e2e/terminal.spec.ts`

- [ ] **Step 1: Add the failing end-to-end copy scenario.**

Grant clipboard permissions, write a unique marker to the active terminal,
then drag across the marker on `.xterm-screen` with `page.mouse`. Poll for a
non-empty `.xterm-selection` rectangle before sending `Control+C`; finally
assert `navigator.clipboard.readText()` equals the marker.

- [ ] **Step 2: Run the focused E2E test and verify it fails before the
implementation is present.**

Run: `E2E_MODE=local npm run test:e2e -- e2e/terminal.spec.ts -g "copies selected terminal text"`

Expected: FAIL on the absence of retained selection or clipboard content.

- [ ] **Step 3: Run the focused E2E test after Chunks 1 and 2.**

Run: `E2E_MODE=local npm run test:e2e -- e2e/terminal.spec.ts -g "copies selected terminal text"`

Expected: PASS, demonstrating an unmodified drag selects and the platform
shortcut copies the exact marker.

- [ ] **Step 4: Run focused validation.**

Run:

```bash
npx prettier --check apps/client/src/Terminal.tsx apps/client/src/Terminal.test.tsx apps/server/src/tmux.ts apps/server/src/tmux.test.ts e2e/terminal.spec.ts
npm run typecheck
npm test -w @flanterminal/client -- --run src/Terminal.test.tsx
npm test -w @flanterminal/server -- --run src/tmux.test.ts
git diff --check
```

Expected: each command exits successfully.

- [ ] **Step 5: Commit the end-to-end regression test.**

```bash
git add e2e/terminal.spec.ts
git commit -m "test: cover terminal selection copy"
```
