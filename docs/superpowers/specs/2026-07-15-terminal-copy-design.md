# Terminal Text Selection, Copy, and Context-Menu Design

## Goal

Allow users to select terminal output with an ordinary drag, copy it with the
platform shortcut, and right-click without an overlapping browser or tmux
context menu. Preserve unselected `Ctrl+C` or `Cmd+C` behavior in the
connected shell.

## Selected approach

Set `mouse off` for each managed tmux session. With tmux mouse reporting on,
xterm disables its selection service and sends the drag and right-click to
tmux; this causes the tmux popup shown in the reported behavior and prevents
ordinary selection. Disabling it gives xterm ownership of normal drag
selection.

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

Finally, cancel the terminal host's `contextmenu` event. xterm will still
apply its existing right-click word-selection behavior, while neither the
browser menu nor the tmux popup can obscure the terminal.

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
- Preserve xterm's right-click word-selection option and all existing terminal
  preferences.
- Managed tmux sessions no longer support mouse-driven tmux or TUI actions;
  this tradeoff restores the browser terminal's standard selection model.

## Data flow

1. The managed tmux session starts with mouse reporting disabled, so a user
   drags over terminal output and xterm owns the selection state.
2. The user presses the platform copy shortcut (`Ctrl+C` on Windows/Linux or
   `Cmd+C` on macOS).
3. If the selection is non-empty, the terminal reads it, requests a browser
   clipboard write, synchronously prevents the browser default, and returns
   `false` to xterm.
4. If no selection exists, Windows/Linux `Ctrl+C` and macOS `Ctrl+C` return
   without cancellation so xterm forwards the terminal interrupt. An
   unselected macOS `Cmd+C` is cancelled without a clipboard write.
5. A right-click may select the word under the pointer through xterm, but the
   terminal host cancels `contextmenu`; the browser menu cannot appear.

## Verification

- Add unit tests showing selected text is written to the clipboard and the
  browser event is cancelled only when a selection exists.
- Cover the Windows/Linux Ctrl and macOS Cmd variants, an unselected macOS
  Ctrl+C terminal interrupt, an unselected macOS Cmd+C no-op, and rejected or
  thrown clipboard writes.
- Verify that unselected `Ctrl+C` reaches the existing socket input path.
- Add a server test proving new managed tmux sessions receive `mouse off`.
- Add client coverage that the terminal host cancels the browser context menu.
- Add an end-to-end test that grants clipboard read/write permissions, selects
  a known terminal output value with an ordinary drag, and asserts the exact
  copied value through the browser clipboard API.
- Run the affected client tests, typecheck, and the focused terminal E2E test.
