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
remaining boundary: without an application-owned wheel hook, it may translate
or report wheel gestures as terminal input instead of scrolling the browser
buffer. The current Chromium-only E2E
configuration does not directly cover alternate browser engines, and the E2E
wrapper silently ignores command-line filters.

## Selected approach

Register xterm's `attachCustomWheelEventHandler` after opening each terminal.
xterm 6 invokes this supported hook before both its native no-scrollback
translation and active mouse-protocol reporting. For a gesture with no Ctrl,
Meta, Shift, or Alt modifier whose vertical delta dominates its horizontal
delta, convert the delta to signed whole terminal lines, call `scrollLines`,
call `preventDefault`, and return `false` so xterm performs no further wheel
processing. Delegate modified and primarily horizontal gestures by returning
`true`.

Maintain a fractional line remainder per terminal instance. Convert
`DOM_DELTA_LINE` directly to lines; convert `DOM_DELTA_PAGE` to
`deltaY * max(rows - 1, 1)` lines; and convert `DOM_DELTA_PIXEL` using the CSS
height of the first rendered xterm row, falling back to
`fontSize * lineHeight`. Reset the remainder when direction changes or when a
gesture is delegated. Add the converted delta, truncate toward zero, retain
the unused fraction, and pass only a nonzero integer to `scrollLines`.

Register a fresh handler for each terminal instance; terminal disposal removes
xterm's owning listeners. This keeps behavior local to the terminal surface
and preserves keyboard input, selection, links, context menus, and tmux
configuration.

## Alternatives considered

1. Continue changing tmux options. Runtime evidence proves the relevant
   options are already applied, so further server changes do not address the
   failing boundary.
2. Capture wheel events with a separate DOM listener. This duplicates xterm's
   event ownership and cleanup when its supported custom wheel hook already
   covers both processing paths.
3. Use `attachCustomWheelEventHandler`. This is the narrow supported boundary
   and restores the behavior removed by the native-scrollback regression.

## Testing

- Add client unit coverage that vertical wheel events scroll signed line/page/
  pixel amounts, retain pixel remainders, prevent the browser default, return
  `false`, and never send socket input.
- Verify modified and horizontal gestures remain delegated.
- Verify terminal recreation registers a fresh handler owned by the new xterm
  instance.
- Give the existing setup project `browserName: 'chromium'`; add explicit
  Chromium and Firefox workflow projects that both depend on that one-time
  enrollment project and each set `use.browserName`.
- Make `run-e2e.sh` preserve its positional test arguments and execute the E2E
  service through `docker compose run ... npm run test:e2e:run -- "$@"` after
  bringing the app service up, so filters and browser projects reach
  Playwright without string re-parsing.
- Run the terminal wheel regression in both Chromium and Firefox, then run the
  full unit, lint, typecheck, and build checks.
