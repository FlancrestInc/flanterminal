# Terminal Wheel Capture Design

## Goal

Make ordinary vertical mousewheel and trackpad gestures scroll xterm's browser
buffer and never reach the shell as Up/Down input.

## Evidence and root cause

The affected environment reports all expected prerequisites: workspace
scrollback is 10,000 lines, tmux history is 20,000 lines, the managed window
has `alternate-screen off`, and tmux has `mouse off`. The behavior reproduces
in Firefox and Chrome, in new tabs, at a plain shell, and after explicitly
selecting xterm's normal buffer. xterm's native wheel path is therefore the
remaining boundary: it may translate or report wheel gestures as terminal
input before the browser viewport owns them. The current Chromium-only E2E
configuration does not directly cover alternate browser engines, and the E2E
wrapper silently ignores command-line filters.

## Selected approach

Install a capture-phase `wheel` listener on the terminal host before opening
xterm. For an unmodified gesture whose vertical delta dominates its horizontal
delta, normalize line, page, and pixel deltas, call xterm's `scrollLines`, call
`preventDefault` and `stopPropagation`, and do not allow the event to reach
xterm's input/mouse-protocol listeners. Preserve pixel remainders for smooth
trackpad input. Delegate Ctrl, Meta, Shift, and primarily horizontal gestures
unchanged.

Register the listener for each terminal instance and remove it during effect
cleanup. This keeps the behavior local to the terminal surface and preserves
keyboard input, selection, links, context menus, and tmux configuration.

## Alternatives considered

1. Continue changing tmux options. Runtime evidence proves the relevant
   options are already applied, so further server changes do not address the
   failing boundary.
2. Use xterm's `attachCustomWheelEventHandler`. xterm can bypass this callback
   when an active mouse protocol owns wheel events, which leaves the reported
   input leak possible.
3. Capture vertical wheel events on the host. This runs before xterm's target
   listeners and guarantees the gesture remains browser-local.

## Testing

- Add client unit coverage that vertical wheel events scroll signed line/page/
  pixel amounts, retain pixel remainders, prevent propagation, and never send
  socket input.
- Verify modified and horizontal gestures remain delegated.
- Verify listener cleanup and terminal recreation do not leak handlers.
- Strengthen Playwright configuration with explicit Chromium and Firefox
  workflow projects, and make the E2E wrapper forward requested test arguments.
- Run the terminal wheel regression in both Chromium and Firefox, then run the
  full unit, lint, typecheck, and build checks.
