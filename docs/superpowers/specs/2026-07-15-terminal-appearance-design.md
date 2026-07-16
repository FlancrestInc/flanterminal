# Terminal appearance design

## Goal

Make FlanTerminal's typography and color settings feel more expressive while
keeping font selection and color customization dependable without user-managed
font installation. System font choices are explicitly best-effort stacks, not
a promise that an exact font exists on every device.

## User decisions

- The visual baseline is Midnight Electric: dark navy backgrounds, vibrant
  readable terminal colors, and high-contrast text.
- Offer curated presets plus terminal-only custom color controls.
- Make DejaVu Sans Mono the default font. Retain JetBrainsMono Nerd Font and
  add Noto Sans Mono, Liberation Mono, and Courier. Courier is chiefly a
  classic fallback choice.
- Keep application UI chrome tied to a selected preset; custom colors affect
  the terminal only.

## Settings model

Extend workspace settings with:

- Font identifiers for `dejavu-sans-mono`, `noto-sans-mono`,
  `liberation-mono`, and `courier`, alongside the existing JetBrains and
  system-monospace identifiers.
- Six theme identifiers: existing `dark`, `light`, and `ubuntu`, plus
  `midnight-electric`, `aurora-night`, and `carbon-violet`. Keep existing
  themes valid for saved workspaces. The three new choices share Midnight
  Electric's UI tokens so application controls stay consistent; each supplies
  its own xterm palette.
- A theme selection that can be `custom`.
- A `customTerminalPalette` object containing the xterm keys `background`,
  `foreground`, `cursor`, `cursorAccent`, `selectionBackground`, `black`,
  `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`,
  `brightBlack`, `brightRed`, `brightGreen`, `brightYellow`, `brightBlue`,
  `brightMagenta`, `brightCyan`, and `brightWhite`. Keys are required, their
  order in the Settings editor follows that list (normal then bright ANSI
  colors), and each value is a six-digit `#RRGGBB` CSS color. The editor does
  not expose `cursorAccent`; it always derives it from the selected terminal
  background when the palette is edited or saved.

The shared schema validates those values, the settings route receives them as
part of the existing full replacement, and deployment constraints expose all
supported fonts and themes. The settings version remains `1`: the parser
normalizes a legacy object without `customTerminalPalette` by supplying the
complete Midnight Electric palette before validation and persistence. New
workspace defaults use DejaVu Sans Mono and Midnight Electric.

Midnight Electric is the reference palette and must use these exact xterm
values:

| Key | Value | Key | Value |
| --- | --- | --- | --- |
| background | `#101827` | foreground | `#DCE8FF` |
| cursor | `#82B1FF` | cursorAccent | `#101827` |
| selectionBackground | `#294A82` | black / brightBlack | `#152238` / `#4A5D80` |
| red / brightRed | `#FF7B8B` / `#FF9EAA` | green / brightGreen | `#74D99F` / `#99E9B6` |
| yellow / brightYellow | `#F6CB6C` / `#FFDA91` | blue / brightBlue | `#82B1FF` / `#A8C8FF` |
| magenta / brightMagenta | `#D8A0FF` / `#EDB9FF` | cyan / brightCyan | `#76D7EA` / `#A8E8F5` |
| white / brightWhite | `#DCE8FF` / `#FFFFFF` | | |

The other new dark choices use the same key order and Midnight UI tokens. Their
complete terminal palettes are fixed as follows (keys appear in canonical
order after `selectionBackground`):

```text
aurora-night: #071B1C, #D6F5EF, #70E1C2, #071B1C, #164A49,
  #102A2B, #FF7B89, #75E6A6, #F5D06F, #75BFFF, #D7A5FF, #65D9DF, #D6F5EF,
  #416B6B, #FFA0AA, #A2F2BF, #FFE09A, #A4D5FF, #ECBFFF, #99EEF1, #FFFFFF
carbon-violet: #15111F, #EEE5FF, #B99CFF, #15111F, #3B2C59,
  #272035, #FF7D9A, #8DDEA8, #F1C76A, #9CB7FF, #D6A5F4, #7EDBE5, #EEE5FF,
  #625574, #FFA4B7, #AFECC3, #FFE09A, #C0D0FF, #E7C4FF, #A9EEF3, #FFFFFF
```

## Client behavior

`themes.ts` owns preset UI tokens and xterm palettes, and exposes a resolver
that returns a preset palette or a custom terminal palette. The resolver keeps
Midnight Electric UI tokens for custom palettes. Font stacks use the named
font first and include suitable generic monospace fallbacks, so an unavailable
system font gracefully falls back without setup. No new font files are bundled:
only the existing JetBrainsMono Nerd Font asset stays bundled. DejaVu, Noto,
Liberation, and Courier resolve from the user's system; their ordered stacks
fall back through the other selected practical fonts and then generic
`monospace`.

The terminal component uses the resolver when creating and updating xterm.
Appearance changes take effect immediately after a successful settings save by
recreating the xterm instance using its existing settings-driven lifecycle;
the current screen buffer is not preserved, but the remote session continues
unchanged and new output uses the chosen appearance.
The settings page displays the practical font names with a concise
“uses system font when available” hint for DejaVu, Noto, Liberation, and
Courier; JetBrains remains labelled bundled. It displays preset themes and a
clearly labelled advanced custom-terminal-colors section when Custom is
selected. The editor contains controls for the terminal background, foreground,
cursor, selection, and the normal/bright ANSI colors; cursor accent is derived
from the background rather than edited separately. It uses standard native
color controls plus editable hexadecimal text, preserving the existing explicit
Save action and busy/error handling.

## Boundaries and errors

- The custom palette never changes the application's UI tokens, preventing an
  unreadable Settings page or controls.
- Invalid or malformed custom colors are rejected by shared validation before
  persistence. The client should prevent submission of invalid values and show
  an inline field error where native input validation is insufficient.
- A custom theme without a complete palette is invalid; a non-custom theme
  always carries the normalized Midnight Electric palette, which is ignored
  until Custom is selected and keeps full replacement settings structurally
  stable.
- Existing theme names remain rendered and selectable. Missing fonts resolve
  through their stack rather than causing a setting failure.

## Tests

- Shared tests validate new identifiers, custom color format, completeness, and
  rejection of invalid color values.
- Server and settings-store tests cover the expanded constraints and new
  defaults while retaining compatibility with existing stored settings.
- Theme tests assert all six supported preset identifiers, the exact Midnight
  Electric palette, font-stack ordering, and custom palette resolution.
- Settings view tests verify the available choices, custom controls,
  validation/error behavior, and complete settings submission.
- Terminal tests verify xterm receives the resolved custom palette.
- Contrast tests continue to cover UI text because UI colors remain preset
  controlled; terminal color choices are user-owned.
