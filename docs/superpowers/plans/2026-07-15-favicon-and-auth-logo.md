# Favicon and Authentication Logo Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use the supplied FlanTerminal image as a Vite-served browser favicon and the shared primary brand mark on every authentication screen.

**Architecture:** A single public PNG will be addressed via Vite's base URL in both the static HTML favicon link and a small `AuthBrand` React component. `LoginScreen` will compose that component before each state-specific heading; CSS confines the lockup to the existing responsive authentication card without altering authentication behavior.

**Tech Stack:** React, TypeScript, Vite public assets, Vitest, Testing Library, CSS.

---

## Chunk 1: Asset and Favicon

### File Structure

- Create: `apps/client/public/flanterminal.png` — source PNG served by Vite.
- Modify: `apps/client/index.html` — declares the PNG favicon using Vite's HTML base URL replacement.
- Modify: `apps/client/src/LoginScreen.test.tsx` — asserts the static favicon declaration alongside existing client branding tests.
- Delete: `flanterminal.png` — source-root copy moved into the client public directory.

### Task 1: Declare the Vite-aware favicon

**Files:**
- Modify: `apps/client/src/LoginScreen.test.tsx`
- Modify: `apps/client/index.html`
- Create: `apps/client/public/flanterminal.png`
- Delete: `flanterminal.png`

- [ ] **Step 1: Write the failing static-HTML assertion**

  Add this test near the existing CSS-source assertion in `LoginScreen.test.tsx`:

  ```tsx
  it('declares the Vite-served PNG favicon', () => {
    const html = readFileSync('../index.html', 'utf8');

    expect(html).toContain(
      '<link rel="icon" type="image/png" href="%BASE_URL%flanterminal.png" />',
    );
  });
  ```

- [ ] **Step 2: Run the focused test to verify it fails**

  Run: `npm run test -w @flanterminal/client -- LoginScreen.test.tsx -t "declares the Vite-served PNG favicon"`

  Expected: FAIL because `index.html` lacks the `rel="icon"` PNG link.

- [ ] **Step 3: Move the image into the Vite public directory and declare it**

  Create `apps/client/public/` if it does not exist, then move the untracked root
  `flanterminal.png` to `apps/client/public/flanterminal.png` without modifying
  its binary contents. In the `<head>` of `apps/client/index.html`, add:

  ```html
  <link rel="icon" type="image/png" href="%BASE_URL%flanterminal.png" />
  ```

- [ ] **Step 4: Run the focused test to verify it passes**

  Run: `npm run test -w @flanterminal/client -- LoginScreen.test.tsx -t "declares the Vite-served PNG favicon"`

  Expected: PASS.

- [ ] **Step 5: Commit the asset and favicon declaration**

  ```bash
  git add apps/client/public/flanterminal.png apps/client/index.html apps/client/src/LoginScreen.test.tsx
  git add -u flanterminal.png
  git commit -m "feat(client): add FlanTerminal favicon"
  ```

## Chunk 2: Shared Authentication Brand Lockup

### File Structure

- Create: `apps/client/src/AuthBrand.tsx` — renders the decorative PNG and visible `FlanTerminal` name.
- Modify: `apps/client/src/LoginScreen.tsx` — renders one `AuthBrand` before the existing `h1` in access-error, setup, and sign-in states.
- Modify: `apps/client/src/theme.css` — styles the 40px mark, text, 8px gap, and 12px spacing inside the existing card width.
- Modify: `apps/client/src/LoginScreen.test.tsx` — covers one lockup in every authentication state and verifies its accessible semantics.

### Task 2: Add tests for the shared lockup

**Files:**
- Modify: `apps/client/src/LoginScreen.test.tsx`

- [ ] **Step 1: Write the failing parameterized component test**

  Add this parameterized test for `access-error`, setup, and normal sign-in.
  Use `container` for the decorative image assertion so the empty alt text is
  not treated as a named image.

  ```tsx
  it.each([
    ['access error', props({ status: 'access-error', error: 'Access denied.' })],
    ['setup', props({ bootstrap: setupRequired })],
    ['sign in', props()],
  ])('renders one FlanTerminal brand lockup for %s', (_state, screenProps) => {
    const { container } = render(<LoginScreen {...screenProps} />);

    expect(screen.getAllByText('FlanTerminal')).toHaveLength(1);
    const logos = container.querySelectorAll('img.auth-brand-mark');
    expect(logos).toHaveLength(1);
    expect(logos[0]).toHaveAttribute('alt', '');
    expect(logos[0]).toHaveAttribute('src', './flanterminal.png');
  });
  ```

- [ ] **Step 2: Run the focused test to verify it fails**

  Run: `npm run test -w @flanterminal/client -- LoginScreen.test.tsx -t "renders one FlanTerminal brand lockup"`

  Expected: FAIL because no brand component or mark exists.

### Task 3: Implement the lockup and style it

**Files:**
- Create: `apps/client/src/AuthBrand.tsx`
- Modify: `apps/client/src/LoginScreen.tsx`
- Modify: `apps/client/src/theme.css`

- [ ] **Step 1: Create the focused `AuthBrand` component**

  Implement the smallest component with a base-path-aware asset URL and
  decorative image:

  ```tsx
  const LOGO_URL = `${import.meta.env.BASE_URL}flanterminal.png`;

  export function AuthBrand() {
    return (
      <div className="auth-brand">
        <img className="auth-brand-mark" src={LOGO_URL} alt="" width={40} height={40} />
        <span>FlanTerminal</span>
      </div>
    );
  }
  ```

- [ ] **Step 2: Compose it into each auth state without changing headings**

  Import `AuthBrand` in `LoginScreen.tsx`. Render `<AuthBrand />` immediately
  before the existing `h1` in the access-error section, setup form, and sign-in
  form. Keep each existing heading ID and `aria-labelledby` value unchanged.

- [ ] **Step 3: Add the constrained lockup styles**

  In `theme.css`, add selectors that keep the lockup within the existing
  320px-wide card:

  ```css
  .auth-brand {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    color: #e5e3de;
    font-size: 18px;
    font-weight: 600;
    line-height: 1.25;
  }

  .auth-brand-mark { width: 40px; height: 40px; flex: none; }
  ```

  These values deliberately match the existing auth `h1` text appearance. Do
  not add a new theme token or alter `.login-form`/`.access-state` width rules.

- [ ] **Step 4: Run the focused brand test to verify it passes**

  Run: `npm run test -w @flanterminal/client -- LoginScreen.test.tsx -t "renders one FlanTerminal brand lockup"`

  Expected: PASS for all three authentication states.

- [ ] **Step 5: Run the complete affected test file**

  Run: `npm run test -w @flanterminal/client -- LoginScreen.test.tsx`

  Expected: PASS with existing setup, sign-in, and error-state behavior intact.

- [ ] **Step 6: Commit the authentication brand component**

  ```bash
  git add apps/client/src/AuthBrand.tsx apps/client/src/LoginScreen.tsx apps/client/src/theme.css apps/client/src/LoginScreen.test.tsx
  git commit -m "feat(client): brand authentication screens"
  ```

## Chunk 3: Final Verification

### Task 4: Validate the production client

**Files:**
- Verify only: `apps/client/public/flanterminal.png`, `apps/client/index.html`, `apps/client/src/AuthBrand.tsx`, `apps/client/src/LoginScreen.tsx`, `apps/client/src/theme.css`, `apps/client/src/LoginScreen.test.tsx`


- [ ] **Step 1: Check formatting and linting**

  Run: `npm run format:check && npm run lint`

  Expected: exit code 0.

- [ ] **Step 2: Typecheck the client**

  Run: `npm run typecheck -w @flanterminal/client`

  Expected: exit code 0.

- [ ] **Step 3: Build the client and inspect its generated favicon reference**

  Run: `npm run build -w @flanterminal/client && rg -n "flanterminal\.png" apps/client/dist`

  Expected: client build succeeds and the generated HTML references the served PNG.

- [ ] **Step 4: Check the final diff**

  Run: `git diff --check HEAD~2..HEAD && git status --short`

  Expected: no whitespace errors and no unexpected files outside the planned asset, client code, tests, and docs.
