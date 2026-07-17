# Terminal Automatic Copy Design

## Goal

Copy completed terminal text selections to the clipboard automatically, confirm successful copies with a brief toast, and preserve the existing browser-local scrollback behavior.

## Root cause

The current selection compatibility handler replaces a trusted primary-button `mousedown` with a synthetic modifier-bearing event. The remainder of the drag remains real and unmodified, so xterm receives mismatched selection gesture events and clears the selection on release.

## Design

The terminal host will observe a primary-button release in the capture phase. It will read xterm's completed selection before xterm's own release handling can clear it. A non-empty selection is written once through the Clipboard API. On fulfilled writes only, the terminal renders a short-lived, polite status toast reading “Copied to clipboard”. Rejected, unavailable, and synchronous Clipboard API failures remain non-disruptive and do not show a success message.

The existing selection compatibility input remains focused only on terminal screen presses. The automatic-copy release handler is independent of the custom wheel event handler; it neither prevents wheel events nor forwards input to tmux. Existing Ctrl/Cmd+C behavior remains available as a fallback and gains the same success reporting.

## Testing

- Unit tests prove that a completed primary selection copies once and reports success only after the Clipboard promise resolves.
- Unit tests cover unavailable/rejected clipboard access without a toast or terminal input side effect.
- The existing wheel unit tests and managed-session scrollback E2E coverage remain unchanged as regression protection.
- The selection E2E test verifies automatic clipboard content and the status toast without requiring Ctrl/Cmd+C.
