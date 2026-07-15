# Favicon and Authentication Logo Design

## Goal

Use the supplied `flanterminal.png` as the FlanTerminal browser favicon and as
the primary visible brand mark across authentication screens.

## Scope

- Move the source image to `apps/client/public/flanterminal.png`.
- Add `<link rel="icon" type="image/png" href="%BASE_URL%flanterminal.png" />`
  to `apps/client/index.html`. Vite replaces `%BASE_URL%` with its configured
  base URL, including the trailing slash.
- Render one reusable, accessible brand-lockup component above each
  authentication state in `LoginScreen`: access error, first-run setup, and
  normal sign-in.
- Keep existing state-specific headings and form behavior unchanged.
- Do not add branding to the authenticated terminal workspace, settings, or
  admin views.

## Component Design

`AuthBrand` is a small client component responsible only for rendering the
logo image and the visible text `FlanTerminal`. It uses
`${import.meta.env.BASE_URL}flanterminal.png`, which Vite supplies with a
trailing slash, for the same public asset as the favicon. Its `<img>` has
`alt=""` because the adjacent visible text supplies the accessible application
name. `LoginScreen` places one `AuthBrand` inside each existing state
`section`/`form`, directly before its current `h1`, avoiding duplicated markup
and keeping every auth state visually consistent.

The lockup is a 40-by-40px image beside the `FlanTerminal` text, with an 8px
gap and a 12px bottom margin. It remains within the existing responsive
`min(320px, 100%)` authentication card width. The existing `h1` headings
remain the accessible labels for their corresponding screen or form. The logo
is supporting branding, not a replacement for state semantics.

## Asset Delivery

Deployments hosted below a URL prefix resolve both references through Vite's
base URL. No image conversion or generated variants are needed for this change.

## Error Handling

No new runtime state, network request, or error path is introduced. If the
asset cannot be served, browsers retain normal broken-image/favicon fallback
behavior; authentication controls remain usable and their existing error
messages are unchanged.

## Verification

- Add component tests proving each authentication state contains exactly one
  visible `FlanTerminal` brand lockup and a decorative logo image.
- Verify `index.html` declares the favicon with the specified `rel`, `type`,
  and Vite base-path URL.
- Run the targeted client tests and the client typecheck/lint command used by
  the repository.
