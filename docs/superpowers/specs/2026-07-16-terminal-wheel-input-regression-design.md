# Terminal Wheel Input Regression Design

## Goal

Restore mouse-wheel scrolling of the browser terminal buffer without allowing
vertical wheel gestures to reach the shell as command-history input.

## Root cause

The current client correctly delegates ordinary wheel events to xterm. xterm
converts those events into up/down input only when its active buffer has no
scrollback, such as tmux's alternate screen. Managed sessions created before
the `alternate-screen off` change retain that old per-window configuration:
the server configures the option only while creating a new session and does
not migrate an existing one before attaching. Readline receives xterm's
up/down input and cycles command history. The current E2E test creates a new
session and only proves that visible output changes, so it misses this
existing-session case.

## Selected approach

Before attaching any managed tmux session, configure its initial window with
`alternate-screen off`, whether that session was just created or already
existed. This restores xterm's normal buffer and native scrollback for the
previously created sessions that exhibit the regression. Keep the current
client implementation: xterm owns wheel normalization and scrolling whenever
the buffer has scrollback.

## Alternatives considered

1. Reintroduce a custom xterm wheel adapter. It cannot provide browser
   scrollback while the active buffer is the alternate buffer, and xterm skips
   the adapter while an application requests wheel mouse reporting.
2. Re-enable tmux mouse handling. This routes wheel events through tmux,
   conflicts with browser-owned scrollback, and can still deliver input to
   applications.
3. Migrate the managed initial window to normal-buffer behavior before attach.
   This fixes the missing precondition for native xterm scrolling without
   changing wheel handling or tmux behavior in unrelated windows.

## Boundaries

- Change only managed-session tmux preparation, its direct tests, and the
  terminal E2E regression coverage.
- Do not change client wheel handling, keyboard input forwarding, or
  scrollback limits.
- Scope the tmux change to the managed session's initial window; do not alter
  user-created windows or global tmux configuration.

## Verification

- Add a server unit test that an existing managed session receives the
  window-scoped `alternate-screen off` command before attach.
- Extend the browser test to reuse a managed session created without that
  option, verify that wheel-up reveals retained output, then type and submit a
  unique command to prove the wheel gesture did not replace the draft with a
  command from history.
- Run focused server tests, typecheck, lint, and the wheel-scroll E2E flow.
