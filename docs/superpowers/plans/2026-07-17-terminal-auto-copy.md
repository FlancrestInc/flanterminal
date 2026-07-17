# Terminal Automatic Copy Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically copy completed terminal selections and give success feedback without changing scrollback routing.

**Architecture:** Keep terminal gesture, clipboard, and wheel handling within `Terminal.tsx`. A capture-phase release handler snapshots selection before xterm clears it; the existing Clipboard API path reports fulfilled writes to compact component state that renders an accessible toast.

**Tech Stack:** React, TypeScript, xterm.js, Vitest, Playwright.

---

## Chunk 1: Terminal behavior and unit coverage

### Task 1: Specify completed-selection auto-copy

**Files:**
- Modify: `apps/client/src/Terminal.test.tsx`
- Modify: `apps/client/src/Terminal.tsx`

- [ ] **Step 1: Write failing tests** for a primary-button release with a non-empty selection, asserting one Clipboard write and a `role=status` success message only after fulfillment; add rejected/unavailable clipboard cases that do not show success.
- [ ] **Step 2: Run the focused test file**

Run: `npm test --workspace @flanterminal/client -- Terminal.test.tsx`

Expected: FAIL because the release handler and success status do not exist.

- [ ] **Step 3: Implement the smallest behavior**: use a capture-phase `mouseup` handler restricted to the terminal screen and primary button, reuse the Clipboard API writer with an on-success callback, and render/clear a short-lived polite toast. Do not alter `attachCustomWheelEventHandler`.
- [ ] **Step 4: Run the focused test file**

Run: `npm test --workspace @flanterminal/client -- Terminal.test.tsx`

Expected: PASS.

### Task 2: Verify browser behavior

**Files:**
- Modify: `e2e/terminal.spec.ts`
- Modify: `apps/client/src/theme.css`

- [ ] **Step 1: Write/update the E2E selection test** to verify a drag copies its terminal marker automatically and exposes “Copied to clipboard”; retain the managed-session native scrollback test unchanged.
- [ ] **Step 2: Run the focused E2E test**

Run: `E2E_MODE=local npm run test:e2e -- e2e/terminal.spec.ts -g "copies selected terminal text"`

Expected: FAIL before the automatic-copy implementation.

- [ ] **Step 3: Add minimal toast styling** positioned within the terminal workspace, visible without intercepting terminal input.
- [ ] **Step 4: Run focused and regression verification**

Run: `npm test --workspace @flanterminal/client -- Terminal.test.tsx && E2E_MODE=local npm run test:e2e -- e2e/terminal.spec.ts -g "copies selected terminal text|native xterm scrolling exposes managed-session history"`

Expected: PASS.
