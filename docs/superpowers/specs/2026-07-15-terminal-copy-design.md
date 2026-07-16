# Terminal Text Selection and Copy Design

## Goal

Allow users to select terminal output and copy it with standard browser and
terminal gestures, without changing the behavior of an unselected `Ctrl+C` or
`Cmd+C` in the connected shell.

## Selected approach

Use xterm's built-in selection model and add a narrowly scoped custom key
event handler in `Terminal.tsx`. The handler recognizes `Ctrl+C` on Windows
and Linux and `Cmd+C` on macOS. If xterm has selected text, it synchronously
calls `event.preventDefault()`, requests a browser clipboard write, and
returns `false` so xterm cannot forward the key to the shell. It does not call
`stopPropagation()`. Clipboard rejection or a synchronous clipboard exception
is ignored after event cancellation. When no text is selected, it returns
`true` without cancelling the event so `Ctrl+C` continues to deliver the
terminal interrupt character. On macOS, selected `Ctrl+C` is likewise passed
through as terminal input; only `Cmd+C` performs copy. An unselected macOS
`Cmd+C` is a no-op, matching the normal terminal copy command; it must not be
forwarded to the shell.

The existing xterm rendering surface already supplies mouse-drag selection and
browser context-menu behavior. This change adds no toolbar control or separate
clipboard dependency.

## Boundaries

- Extend the local `TerminalLike` adapter with `hasSelection(): boolean`,
  `getSelection(): string`, and
  `attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean):
void`. The handler returns `false` to stop xterm input processing and `true`
  to retain it. xterm exposes no disposable registration for this handler; its
  lifecycle is the terminal instance, so recreation and disposal replace it.
- Treat clipboard-write failures as non-fatal; selection remains available and
  the terminal must stay usable.
- Do not intercept paste or alter shell input beyond the selected-text copy
  shortcut.
- Preserve the current right-click word-selection option and all existing
  terminal preferences.

## Data flow

1. A user drags over terminal output; xterm owns the native selection state.
2. The user presses the platform copy shortcut (`Ctrl+C` on Windows/Linux or
   `Cmd+C` on macOS).
3. If the selection is non-empty, the terminal reads it, requests a browser
   clipboard write, synchronously prevents the browser default, and returns
   `false` to xterm.
4. If no selection exists, Windows/Linux `Ctrl+C` and macOS `Ctrl+C` return
   without cancellation so xterm forwards the terminal interrupt. An
   unselected macOS `Cmd+C` is cancelled without a clipboard write.

## Verification

- Add unit tests showing selected text is written to the clipboard and the
  browser event is cancelled only when a selection exists.
- Cover the Windows/Linux Ctrl and macOS Cmd variants, an unselected macOS
  Ctrl+C terminal interrupt, an unselected macOS Cmd+C no-op, and rejected or
  thrown clipboard writes.
- Verify that unselected `Ctrl+C` reaches the existing socket input path.
- Add an end-to-end test that grants clipboard read/write permissions, selects
  a known terminal output value, and asserts the exact copied value through
  the browser clipboard API.
- Run the affected client tests, typecheck, and the focused terminal E2E test.
