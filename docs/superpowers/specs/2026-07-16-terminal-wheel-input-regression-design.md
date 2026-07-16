# Terminal Wheel Input Regression Design

## Goal

Restore mouse-wheel scrolling of the browser terminal buffer without allowing
vertical wheel gestures to reach the shell as command-history input.

## Root cause

The previous browser-scrollback change removed the custom xterm wheel handler
in favor of xterm's native viewport behavior. In the affected runtime, wheel
events can instead be reported to the terminal application; readline then
interprets them as up/down input and cycles command history. The current E2E
test only proves that visible output changes, so it does not detect this input
leak.

## Selected approach

Register xterm's custom wheel-event handler after opening each terminal. For
plain vertical wheel events, normalize the delta into terminal lines, call
`scrollLines`, prevent the browser default, and return `false` so xterm does
not send the event to the connected terminal. Preserve the prior pixel-delta
remainder so trackpads scroll smoothly. Leave Ctrl, Meta, Shift, and primarily
horizontal gestures to xterm by returning `true`.

## Alternatives considered

1. Rely on native xterm scrolling. This is simpler but is the path that now
   leaks wheel input in the affected runtime.
2. Re-enable tmux mouse handling. This would route mouse events through tmux,
   which conflicts with browser-owned scrollback and can still deliver input
   to applications.
3. Intercept only plain vertical wheel events in xterm. This is scoped to the
   regression, preserves browser scrollback, and avoids changing tmux setup.

## Boundaries

- Change only the terminal adapter and its direct unit tests.
- Do not change tmux settings, keyboard input forwarding, or scrollback
  limits.
- Avoid reintroducing broad DOM-level wheel listeners.

## Verification

- Add focused unit coverage for line, pixel, and page wheel deltas.
- Assert vertical wheel events are consumed and never call `sendInput`.
- Assert modifier and horizontal gestures remain delegated to xterm.
- Run the focused client test, typecheck, lint, and the wheel-scroll E2E flow.
