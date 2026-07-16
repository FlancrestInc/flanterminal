# Terminal Wheel Capture Design

## Goal

Make ordinary vertical mousewheel and trackpad gestures scroll xterm's browser
buffer and never reach the shell as Up/Down input.

## Evidence and root cause

The exact reconnect regression established that tmux retains history which a
new xterm instance does not own: immediately after a full reload,
`terminal.buffer.active.baseY` is zero while the old output remains in tmux's
history. With tmux mouse disabled, xterm translates a wheel in that state to
Up/Down input. With tmux mouse enabled, wheel reaches retained history, but
xterm disables ordinary drag selection because the terminal mouse protocol is
active. Prepending `capture-pane` output before `attach-session` was also
tested and rejected because tmux's attach redraw clears that browser history.

The defect is therefore split ownership without an explicit boundary. Both
the retained tmux history path and xterm's later browser-local scrollback path
must be supported, while tmux mouse mode must not regress ordinary selection.
The Chromium-only E2E configuration and argument-dropping E2E wrapper also hid
this interaction from alternate browser engines and focused regression runs.

## Selected approach

Use a hybrid ownership boundary. Managed tmux sessions migrate `mouse` to
`on`, so a reconnect with no xterm scrollback can navigate retained tmux
history. Register xterm's supported custom wheel hook and inspect
`terminal.buffer.active.baseY`: delegate ordinary vertical wheel while it is
zero; once browser-local scrollback exists, normalize the gesture and call
`scrollLines`, preventing tmux or the shell from also consuming it. Modified
and primarily horizontal gestures remain delegated.

Maintain a fractional line remainder per terminal instance. Convert
`DOM_DELTA_LINE` directly to lines; convert `DOM_DELTA_PAGE` to
`deltaY * max(rows - 1, 1)` lines; and convert `DOM_DELTA_PIXEL` using the CSS
height of the first rendered xterm row, falling back to
`fontSize * lineHeight`. Reset the remainder when direction changes or when a
gesture is delegated. Add the converted delta, truncate toward zero, retain
the unused fraction, and pass only a nonzero integer to `scrollLines`.

Because tmux mouse mode normally disables xterm selection, install a capture
listener before `terminal.open`. For an ordinary primary-button press, replace
the event with xterm's platform force-selection modifier (Shift outside macOS,
Option on macOS with `macOptionClickForcesSelection`). Thus an unmodified user
drag remains browser selection and never becomes a tmux mouse press. Register
fresh handlers per terminal and remove the capture listener during cleanup.

## Alternatives considered

1. Keep tmux mouse off and always capture wheel in xterm. This cannot expose
   retained history after a fresh reconnect because xterm has no such lines.
2. Replay `capture-pane` before attach. The attach redraw clears the prepended
   output and leaves xterm without retained scrollback.
3. Require Shift-drag selection. This changes established ordinary selection
   behavior and is unnecessary when the app can force selection internally.

## Testing

- Add client unit coverage that tmux-owned wheels delegate, while xterm-owned
  vertical wheel events scroll signed line/page/
  pixel amounts, retain pixel remainders, prevent the browser default, return
  `false`, and never send socket input.
- Verify modified and horizontal gestures remain delegated.
- Verify terminal recreation registers a fresh handler owned by the new xterm
  instance.
- Reproduce retained output created before reload, migration from tmux mouse
  off, wheel-before-new-browser-history, draft preservation, and ordinary
  unmodified drag selection in browser E2E coverage.
- Give the existing setup project `browserName: 'chromium'`; add explicit
  Chromium and Firefox workflow projects that both depend on that one-time
  enrollment project and each set `use.browserName`.
- Make `run-e2e.sh` preserve its positional test arguments and execute the E2E
  service through `docker compose run ... npm run test:e2e:run -- "$@"` after
  bringing the app service up, so filters and browser projects reach
  Playwright without string re-parsing.
- Run the terminal wheel regression in both Chromium and Firefox, then run the
  full unit, lint, typecheck, and build checks.
