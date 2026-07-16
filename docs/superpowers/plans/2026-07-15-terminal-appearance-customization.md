# Terminal Appearance Customization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide vibrant terminal presets, practical font choices, and a saved custom terminal color palette without changing application UI colors.

**Architecture:** The shared settings contract owns all palette data and legacy normalization; the server supplies its expanded constraints and defaults. The client separates preset UI tokens from resolved terminal palettes, so Custom changes only xterm. SettingsView edits a complete canonical palette and derives `cursorAccent` from background.

**Tech Stack:** TypeScript, Zod, React 19, xterm.js, Vitest, Testing Library, Express workspace settings API.

---

## File structure

- `packages/shared/src/settings.ts` — setting enums, palette schema/default, legacy normalization, limits and constraints.
- `packages/shared/src/settings.test.ts` — contract, normalization, custom-palette validation tests.
- `apps/server/src/index.ts` — supported options and new-workspace defaults.
- `apps/server/src/{settings-routes,settings-store,settings-store.integration,session-runtime-settings}.test.ts` — updated complete fixtures, default/constraint coverage, and persisted legacy migration.
- `apps/client/src/themes.ts` — font stacks, preset palettes, custom terminal resolver, shared Midnight UI tokens.
- `apps/client/src/themes.test.ts` — deterministic palettes, font fallback stacks, resolver and contrast tests.
- `apps/client/src/theme.css` — Midnight UI variables for new dark preset data attributes.
- `apps/client/src/App.tsx` — map Custom to Midnight UI data-theme instead of an undefined CSS theme.
- `apps/client/src/{SettingsView,Terminal}.tsx` — palette editor and resolved xterm configuration.
- `apps/client/src/{SettingsView,Terminal,App,AuthenticatedRoot,settings-api,useSettings,TerminalSession}.test.tsx` — complete settings fixtures and observable client behavior.

## Chunk 1: Shared contract and server defaults

### Task 1: Define the canonical terminal-palette contract

**Files:**
- Modify: `packages/shared/src/settings.test.ts`
- Modify: `packages/shared/src/settings.ts`

- [ ] **Step 1: Write failing shared-contract tests**

  Add a `customTerminalPalette` fixture in the canonical key order and tests that:
  - parse all six font identifiers and seven themes (`dark`, `light`, `ubuntu`, `midnight-electric`, `aurora-night`, `carbon-violet`, `custom`);
  - reject a palette missing `brightWhite`, an unknown palette key, and non-`#RRGGBB` colors;
  - parse an otherwise-valid legacy v1 object with no palette and receive a frozen complete Midnight Electric palette;
  - reject `theme: 'custom'` when its palette is incomplete.

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `npm run test -w @flanterminal/shared -- settings.test.ts`

  Expected: failures identifying missing enum values and `customTerminalPalette` support.

- [ ] **Step 3: Implement the smallest compatible schema change**

  In `settings.ts`, export the canonical palette key list, a frozen Midnight Electric palette, and a narrowly named legacy-palette detector for the store. Add a strict color schema and strict `customTerminalPalette` object. Expand font/theme enums. Normalize only a missing palette on a legacy object before strict parsing, derive/overwrite `cursorAccent` from `background`, and keep output fully frozen. Retain strict rejection of all other missing or unknown settings fields. Make `custom` require the full palette through the same parsed settings shape.

- [ ] **Step 4: Run the focused test and verify GREEN**

  Run: `npm run test -w @flanterminal/shared -- settings.test.ts`

  Expected: all shared settings contract tests pass.

- [ ] **Step 5: Commit the contract change**

  Run:
  ```bash
  git add packages/shared/src/settings.ts packages/shared/src/settings.test.ts
  git commit -m "feat(shared): add terminal appearance palette settings"
  ```

### Task 2: Expose all choices and change new-workspace defaults

**Files:**
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/settings-store.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/src/settings-routes.test.ts`
- Modify: `apps/server/src/settings-store.test.ts`
- Modify: `apps/server/src/settings-store.integration.test.ts`
- Modify: `apps/server/src/session-runtime-settings.test.ts`

- [ ] **Step 1: Write failing server tests**

  Update every complete `WorkspaceSettings` fixture with the canonical palette. Add assertions that the production constraints expose all six font identifiers and all seven themes, and that `defaultWorkspaceSettings` supplies `dejavu-sans-mono`, `midnight-electric`, and the complete default palette. Add an integration test that initializes from a persisted legacy settings object, snapshots the normalized palette, and reloads `settings.json` to assert the complete canonical palette was durably rewritten.

- [ ] **Step 2: Run the focused server tests and verify RED**

  Run: `npm run test -w @flanterminal/server -- settings-routes.test.ts settings-store.test.ts settings-store.integration.test.ts session-runtime-settings.test.ts app.test.ts`

  Expected: fixtures/default assertions fail until server choices and defaults are updated.

- [ ] **Step 3: Implement constraints and defaults**

  In `apps/server/src/index.ts`, enumerate the new font and theme identifiers in `workspaceSettingsConstraints`, and set DejaVu/Midnight/default palette in `defaultWorkspaceSettings`. In `settings-store.ts`, detect a persisted legacy object before parsing; once it parses successfully, replace it with the normalized full settings object using the existing secure-file durability behavior before marking the store ready. Do not add server-side color conversion; rely on the shared parser for normalization and validation.

- [ ] **Step 4: Run the focused server tests and verify GREEN**

  Run: `npm run test -w @flanterminal/server -- settings-routes.test.ts settings-store.test.ts settings-store.integration.test.ts session-runtime-settings.test.ts app.test.ts`

  Expected: all listed server tests pass, including legacy persisted settings normalization.

- [ ] **Step 5: Commit server integration**

  Run:
  ```bash
  git add apps/server/src/index.ts apps/server/src/settings-store.ts apps/server/src/app.test.ts apps/server/src/settings-routes.test.ts apps/server/src/settings-store.test.ts apps/server/src/settings-store.integration.test.ts apps/server/src/session-runtime-settings.test.ts
  git commit -m "feat(server): default to Midnight terminal appearance"
  ```

## Chunk 2: Palette resolution and terminal integration

### Task 3: Add deterministic fonts, presets, and palette resolution

**Files:**
- Modify: `apps/client/src/themes.ts`
- Modify: `apps/client/src/themes.test.ts`
- Modify: `apps/client/src/theme.css`
- Modify: `apps/client/src/LoginScreen.test.tsx`

- [ ] **Step 1: Write failing theme tests**

  Add tests that assert:
  - DejaVu, Noto, Liberation, and Courier stacks start with their named system font, flow through practical fallbacks, and end in generic `monospace`; JetBrains remains the only bundled-font stack;
  - all seven theme identifiers exist, with every canonical-key value for Midnight Electric, Aurora Night, and Carbon Violet matching the approved palette tables;
  - `terminalThemeFor(settings)` returns preset terminal colors for presets, custom palette values for `custom`, and never substitutes custom colors into `ui` tokens;
  - all dark preset CSS data-theme selectors use Midnight's readable UI variables, and existing UI contrast tests remain satisfied.

- [ ] **Step 2: Run the focused client theme tests and verify RED**

  Run: `npm run test -w @flanterminal/client -- themes.test.ts LoginScreen.test.tsx`

  Expected: failures for absent stacks, identifiers, resolver, and CSS selectors.

- [ ] **Step 3: Implement the resolver and CSS mapping**

  Extend `FONT_STACKS`, define the three specified xterm palettes in `themes.ts`, and replace `themeFor` at xterm call sites with a resolver accepting full settings. Keep `themeFor` (or a narrowly named UI resolver) responsible only for UI tokens. Add grouped CSS selectors so `midnight-electric`, `aurora-night`, `carbon-violet`, and `custom` receive Midnight UI variables; leave light/Ubuntu behavior intact.

- [ ] **Step 4: Run the focused client theme tests and verify GREEN**

  Run: `npm run test -w @flanterminal/client -- themes.test.ts LoginScreen.test.tsx`

  Expected: all focused theme and login contrast tests pass.

- [ ] **Step 5: Commit client palette foundations**

  Run:
  ```bash
  git add apps/client/src/themes.ts apps/client/src/themes.test.ts apps/client/src/theme.css apps/client/src/LoginScreen.test.tsx
  git commit -m "feat(client): add vibrant terminal palettes and fonts"
  ```

### Task 4: Apply the resolved palette when xterm is recreated

**Files:**
- Modify: `apps/client/src/Terminal.test.tsx`
- Modify: `apps/client/src/Terminal.tsx`
- Modify: `apps/client/src/App.test.tsx`
- Modify: `apps/client/src/App.tsx`

- [ ] **Step 1: Write failing runtime tests**

  Update terminal settings fixtures with a palette. Add a Terminal test rendering `theme: 'custom'` and asserting the xterm factory receives its custom background, foreground, cursor, selection, and ANSI values. Rerender with a changed custom palette and assert the previous terminal is disposed and a replacement is configured with the new colors. Add an App test asserting Custom sets `document.documentElement.dataset.theme` to `midnight-electric` rather than `custom`.

- [ ] **Step 2: Run the focused runtime tests and verify RED**

  Run: `npm run test -w @flanterminal/client -- Terminal.test.tsx App.test.tsx`

  Expected: custom palette and Custom UI-data-theme assertions fail.

- [ ] **Step 3: Implement xterm and UI-theme application**

  Pass full settings to the terminal resolver, include `customTerminalPalette` in the terminal effect dependencies, and preserve the existing settings-driven teardown/recreation lifecycle. In `App.tsx`, map `custom` to `midnight-electric` only for the root data attribute.

- [ ] **Step 4: Run the focused runtime tests and verify GREEN**

  Run: `npm run test -w @flanterminal/client -- Terminal.test.tsx App.test.tsx`

  Expected: all Terminal and App tests pass, demonstrating live saved-settings application through recreation.

- [ ] **Step 5: Commit runtime application**

  Run:
  ```bash
  git add apps/client/src/Terminal.tsx apps/client/src/Terminal.test.tsx apps/client/src/App.tsx apps/client/src/App.test.tsx
  git commit -m "feat(client): apply custom terminal colors"
  ```

## Chunk 3: Settings editor, fixture sweep, and final verification

### Task 5: Build the advanced terminal color editor

**Files:**
- Modify: `apps/client/src/SettingsView.test.tsx`
- Modify: `apps/client/src/SettingsView.tsx`
- Modify: `apps/client/src/theme.css`

- [ ] **Step 1: Write failing settings-view tests**

  Extend the response fixture with all new limits and palette fields. Test that font options use the approved labels and availability hint; Custom selection reveals a named advanced section containing color and text inputs for background, foreground, cursor, selection, normal ANSI, and bright ANSI colors; other themes hide it. Change the background hex input, submit, and assert the submitted palette has both `background` and a matching derived `cursorAccent`. Enter an invalid hex string and assert submission is blocked with an accessible field error.

- [ ] **Step 2: Run the focused settings-view test and verify RED**

  Run: `npm run test -w @flanterminal/client -- SettingsView.test.tsx`

  Expected: failures for missing Custom controls, labels, derivation, and invalid-value feedback.

- [ ] **Step 3: Implement minimal accessible editor behavior**

  Add explicit labels for all font choices. Add a Custom theme option through server limits, a `Terminal colors` section conditional on Custom, and a focused `TerminalColorField` helper that pairs native `<input type="color">` with a controlled hex text input. Validate format before calling `onSave`; on background change, update `cursorAccent` in the form state. Add compact grid styles with visible focus states and no fixed-width overflow.

- [ ] **Step 4: Run the focused settings-view test and verify GREEN**

  Run: `npm run test -w @flanterminal/client -- SettingsView.test.tsx`

  Expected: all SettingsView tests pass, including palette submission and invalid input blocking.

- [ ] **Step 5: Commit settings editor**

  Run:
  ```bash
  git add apps/client/src/SettingsView.tsx apps/client/src/SettingsView.test.tsx apps/client/src/theme.css
  git commit -m "feat(client): edit custom terminal colors"
  ```

### Task 6: Update complete response fixtures and run the repository checks

**Files:**
- Modify: `apps/client/src/AuthenticatedRoot.test.tsx`
- Modify: `apps/client/src/TerminalSession.test.tsx`
- Modify: `apps/client/src/settings-api.test.ts`
- Modify: `apps/client/src/useSettings.test.tsx`
- Modify: any remaining fixtures returned by `rg -l "WorkspaceSettings|SettingsResponse|fontFamily: 'jetbrains-mono-nerd'|theme: 'dark'" apps packages`

- [ ] **Step 1: Update each strict fixture through tests first**

  Use the type-aware search above, then add the complete normalized custom palette to every `WorkspaceSettings`/`SettingsResponse` fixture. Update expected defaults and option lists, and avoid weakening assertions with casts or partial objects.

- [ ] **Step 2: Run all workspace unit tests and fix only fixture fallout**

  Run: `npm test`

  Expected: initially reports the remaining fixtures that omit the new required palette; after updating them, reports zero failures.

- [ ] **Step 3: Run static and production verification**

  Run:
  ```bash
  npm run lint
  npm run format:check
  npm run typecheck
  npm run build
  ```

  Expected: each command exits 0; build includes production distribution verification.

- [ ] **Step 4: Commit fixture sweep and verification-ready state**

  Run:
  ```bash
  git add apps/client/src packages/shared/src apps/server/src
  git commit -m "test: cover terminal appearance settings"
  ```

- [ ] **Step 5: Perform final diff review**

  Run:
  ```bash
  git status --short
  git log --oneline -5
  ```

  Expected: only intentional commits are present and the working tree is clean.
