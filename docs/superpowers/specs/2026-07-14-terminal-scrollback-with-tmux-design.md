# Terminal Scrollback With Tmux Design

## Goal

Make the configured browser scrollback usable in the initial window of a
managed tmux session, so ordinary mouse-wheel movement reveals retained
terminal output.

## Root cause

xterm retains scrollback only in its normal buffer. tmux's default
`alternate-screen` behavior switches the attached terminal to xterm's
alternate buffer, which has no browser scrollback. The client-side custom
wheel hook then consumes wheel events without a buffer to move.

## Selected approach

Configure the initial window of each managed tmux session with
`set-window-option -t <managed-session>:0 alternate-screen off`. This is
scoped to the managed window and cannot change unrelated tmux sessions. A
user-created or switched-to tmux window retains tmux's own configuration.
The initial window's output then remains in xterm's normal buffer and is
subject to the existing browser scrollback limit. Remove the custom wheel-event
adapter so xterm's native viewport owns wheel normalization, scrolling, and
event handling.

tmux's independent `history-limit` remains configured as before; this change
does not alter its retained-line count or session lifecycle.

## Boundaries

- Update only the managed-session tmux setup and the client wheel interception
  introduced for the prior change, plus their direct tests.
- Do not add a duplicate terminal-history store or emulate tmux copy mode.
- Accept the standard `alternate-screen off` tradeoff: full-screen programs
  no longer restore or clear the prior terminal screen when they exit; their
  output remains available in scrollback.

## Verification

- Add server unit coverage that managed-session creation sets
  `alternate-screen off` via a window-targeted tmux command alongside its
  existing tmux options.
- Remove now-obsolete wheel-hook test scaffolding and retain tests proving
  normal xterm input forwarding and constructor scrollback settings.
- Add browser-level coverage in the managed-tmux E2E environment: emit more
  lines than the terminal viewport, wheel upward, confirm an early line is
  visible, then return to the bottom and confirm new input/output remains
  live.
- Run focused server/client tests, lint, typecheck, and the full suite.
