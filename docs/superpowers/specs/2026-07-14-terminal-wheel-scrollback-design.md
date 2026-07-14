# Terminal Wheel Scrollback Design

## Goal

Make mouse-wheel movement in a terminal tab browse xterm's retained
scrollback instead of sending mouse-wheel input to the connected shell,
tmux, or other terminal program.

## Selected approach

Add a small adapter around xterm's wheel-event hook in `Terminal.tsx`.
When an ordinary vertical wheel event arrives, the adapter calls
`attachCustomWheelEventHandler`, calls `event.preventDefault()`, converts its
vertical movement to a line delta, calls xterm's `scrollLines` API, and
returns `false`. In xterm v6, that return value suppresses xterm's native
wheel/mouse-reporting path, so the event cannot reach the connected terminal
program. This gives the terminal host sole ownership of ordinary vertical
wheel scrolling.

This is preferred over configuration-only changes (which cannot stop
application mouse tracking) and over changing shell/tmux configuration
(which would vary by user's program and session).

## Boundaries

- Extend the local `TerminalLike` abstraction only with the xterm wheel and
  viewport methods required by this behavior.
- Pass Ctrl/Meta-modified, Shift-modified, and horizontal-dominant wheel
  gestures through to xterm unchanged. Existing xterm mode-dependent browser
  cancellation remains unchanged for those gestures. Preserve touch behavior
  and existing terminal preferences.
- Use xterm's own scrollback buffer; do not maintain a duplicate history.

## Wheel normalization

For unmodified, vertically dominant wheel events, normalize `deltaY` to
whole terminal lines: line-mode deltas are rounded to their nearest line;
page-mode deltas are multiplied by the current row count; pixel-mode deltas
are accumulated until they reach a 40-pixel threshold, preserving any
remainder for subsequent trackpad events. Each nonzero normalized delta is
passed to `scrollLines`. The handler calls `preventDefault()` and returns
`false` even at the top or bottom of scrollback so the page does not scroll
and the terminal program cannot receive an accidental mouse report.

## Verification

- Add unit coverage for handler registration, browser cancellation
  (`preventDefault()`), xterm cancellation (`false`),
  positive and negative line movement, pixel accumulation, line and page
  delta modes, and horizontal/modifier passthrough.
- Assert cleanup/recreation replaces the handler with the terminal instance,
  and normal `onData`/socket input forwarding remains unaffected.
- Run the client test suite and TypeScript checks for the affected package.
