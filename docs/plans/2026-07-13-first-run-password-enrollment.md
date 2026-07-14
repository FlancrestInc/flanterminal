# First-Run Password Enrollment Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the first browser visitor to a fresh local-auth installation set the password for the configured administrator username without a Docker password secret.

**Architecture:** Extend the shared authentication state with a strict setup-required branch and a dedicated setup request. Load local credentials into an explicit initialized/uninitialized store, serialize enrollment at that boundary, and expose it through bounded AuthService admission and `POST /api/auth/setup`. The React authentication controller renders a dedicated first-run form and recovers safely from ambiguous post-commit failures.

**Tech Stack:** TypeScript strict mode, Zod, Node.js, Express, bcrypt, React, Vitest/Testing Library, Playwright, Docker Compose.

**Design:** `docs/designs/2026-07-13-first-run-password-enrollment.md`

---

## Chunk 1: Domain And Server

### Task 1: Shared Authentication Contracts

**Files:**

- Modify: `packages/shared/src/auth.ts`
- Modify: `packages/shared/src/auth.test.ts`
- Modify: `packages/shared/src/tabs.ts`
- Modify: `packages/shared/src/admin.test.ts`

- [ ] Add failing contract tests for the exact setup bootstrap
      `{ authenticated: false, mode: 'local', setupRequired: true, username }`,
      strict rejection of extra fields, and immutable parsed results.
- [ ] Add failing tests for `parseSetupRequest({ password })`, including strict
      object shape, 12/72 UTF-8-byte boundaries, multibyte boundaries, NUL
      rejection, and frozen output.
- [ ] Add failing API error-code tests for `setup_required` and
      `setup_already_completed`.
- [ ] Run
      `npm test -w @flanterminal/shared -- --run src/auth.test.ts src/admin.test.ts`
      and confirm failures are caused by the missing setup contracts.
- [ ] Implement a strict setup bootstrap schema alongside the existing strict
      unauthenticated branch; use an ordered `z.union` where the current
      authenticated discriminated union cannot represent two `false` branches.
- [ ] Implement `setupRequestSchema`, `SetupRequest`, and `parseSetupRequest`
      with the same 12–72 UTF-8-byte and NUL-free predicate used by credentials.
- [ ] Add both setup error codes to `apiErrorCodeSchema`.
- [ ] Re-run the focused shared tests and commit:

```sh
git add packages/shared/src/auth.ts packages/shared/src/auth.test.ts \
  packages/shared/src/tabs.ts packages/shared/src/admin.test.ts
git commit -m "feat(auth): define first-run enrollment contracts"
```

### Task 2: Credential Store State And Enrollment

**Files:**

- Modify: `apps/server/src/credential-store.ts`
- Modify: `apps/server/src/credential-store.test.ts`
- Modify: `apps/server/src/credential-store.integration.test.ts`

- [ ] Replace bootstrap-secret fixture tests with failing initialization tests:
      missing `auth.json` produces `initialized === false`, valid existing data
      produces `true`, and malformed/unsafe data still rejects startup.
- [ ] Add failing enrollment tests for password validation, configured username,
      bcrypt cost, mode `0600`, committed state transition, refusal to replace an
      initialized record, and serialized concurrent calls.
- [ ] Add scripted tests showing `committed_durability_uncertain` initializes the
      store, while `not_committed` leaves it uninitialized so a queued attempt may
      retry; assert no second hash occurs after any committed outcome.
- [ ] Add integration coverage for fresh enrollment, restart/login using the
      enrolled password, existing-record compatibility, and absence of plaintext
      passwords from `auth.json`.
- [ ] Run
      `npm test -w @flanterminal/server -- --run src/credential-store.test.ts src/credential-store.integration.test.ts`
      and confirm the new tests fail before implementation.
- [ ] Change initialization to accept configured username and bcrypt cost only,
      read an existing record if present, and preserve missing as a valid
      uninitialized state. Remove bootstrap filesystem types, byte buffers, secret
      reads, and password-file ownership checks.
- [ ] Add synchronous `isInitialized()` and queued `enroll(password)` methods.
      Recheck state inside the queue before hashing and return a typed outcome:
      `enrolled`, `already_initialized`, or `not_committed`, retaining the
      persistence durability result for bounded warning logging.
- [ ] Keep verification and password replacement fail-closed unless initialized.
- [ ] Re-run focused tests and commit:

```sh
git add apps/server/src/credential-store.ts \
  apps/server/src/credential-store.test.ts \
  apps/server/src/credential-store.integration.test.ts
git commit -m "feat(auth): persist atomic first-run enrollment"
```

### Task 3: AuthService Enrollment Admission

**Files:**

- Modify: `apps/server/src/auth-types.ts`
- Modify: `apps/server/src/auth-service.ts`
- Modify: `apps/server/src/auth-service.test.ts`
- Modify: `apps/server/src/logger.ts`
- Modify: `apps/server/src/logger.test.ts`

- [ ] Extend the credential authority test double with `isInitialized()` and
      `enroll()`, then add failing bootstrap tests for setup-required versus normal
      local unauthenticated states.
- [ ] Add failing login-on-uninitialized tests that return `setup_required`
      without rate-limit consumption or credential verification.
- [ ] Add failing enrollment tests for non-local and initialized prechecks,
      shared rate-bucket consumption, bounded establishment admission, one
      authenticated winner, admitted concurrent conflicts, precommit retry, and
      postcommit no-rehash behavior.
- [ ] Add a failing postcommit session-establishment test: force random/session
      creation to fail after enrollment, assert credentials remain initialized,
      assert no session survives, and prove the enrolled password can subsequently
      log in.
- [ ] Confirm an already initialized setup attempt does not consume limiter
      capacity and an overflow attempt produces `rate_limited`.
- [ ] Run the focused AuthService and logger tests and observe the expected
      failures.
- [ ] Add `LocalSetupAttempt` and setup result/failure types. Implement
      `AuthService.setup()` using prechecks before limiter admission, the existing
      establishment reservation, and normal local session establishment after a
      committed credential claim.
- [ ] Return explicit internal outcomes for `setup_required`,
      `already_initialized`, `rate_limited`, and generic persistence failure without
      serializing internal details to clients.
- [ ] Accept an injected durability-warning callback in AuthService and invoke a
      bounded lifecycle log event for uncertainty containing no username, password,
      environment, or filesystem path.
- [ ] Re-run focused tests and commit:

```sh
git add apps/server/src/auth-types.ts apps/server/src/auth-service.ts \
  apps/server/src/auth-service.test.ts apps/server/src/logger.ts \
  apps/server/src/logger.test.ts
git commit -m "feat(auth): admit bounded administrator enrollment"
```

### Task 4: HTTP Setup Endpoint

**Files:**

- Modify: `apps/server/src/auth-routes.ts`
- Modify: `apps/server/src/auth-routes.test.ts`
- Modify: `apps/server/src/app.test.ts`

- [ ] Add failing route tests for setup success, session cookie publication,
      configured workspace bootstrap, strict body validation, request-origin and
      content-type enforcement, client address forwarding, non-local `409`,
      initialized `409`, rate `429`, and generic persistence `500`.
- [ ] Add failing route tests mapping login on uninitialized state to
      `409 setup_required`, while preserving current authentication-failure behavior
      after initialization.
- [ ] Add a failing workspace-bootstrap test where credential commitment and
      session establishment succeed but workspace initialization rejects; assert the
      route returns a generic `500`, revokes the created session, leaves credentials
      initialized, and allows later normal login.
- [ ] Extend public-route inventory tests to include only
      `POST /api/auth/setup`; private endpoints must remain protected.
- [ ] Run focused route/app tests and confirm the setup endpoint is missing.
- [ ] Register `POST /auth/setup` with `requirePublicMutationSecurity`, bounded
      JSON parsing, `setupRequestSchema`, local-mode gating, bounded address
      forwarding, exact result-to-status mapping, and existing `publishBootstrap`
      session/cookie/workspace behavior.
- [ ] Map `setup_required` and `setup_already_completed` through the shared error
      schema without exposing internal store outcomes.
- [ ] Re-run focused tests and commit:

```sh
git add apps/server/src/auth-routes.ts apps/server/src/auth-routes.test.ts \
  apps/server/src/app.test.ts
git commit -m "feat(auth): expose first-run setup endpoint"
```

### Task 5: Production Startup Without A Secret

**Files:**

- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/config.test.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/index.test.ts`

- [ ] Add failing configuration tests proving local mode has no password-file
      property/default and ignores obsolete config-file password paths.
- [ ] Add failing production-runtime tests proving fresh local initialization
      calls credential initialization with username and bcrypt cost only, starts
      uninitialized, and retains existing credential records.
- [ ] Add a failing production wiring test that triggers
      `committed_durability_uncertain` through the injected AuthService callback and
      expects `authentication_activity_failed` with only
      `{ category: 'durability_uncertain' }` from the lifecycle logger.
- [ ] Run focused config/index tests and confirm failures.
- [ ] Remove `localAuthPasswordFile` and `LOCAL_AUTH_PASSWORD_FILE` from active
      config parsing, config-file schema, returned configuration, and production
      initialization.
- [ ] Update credential-store construction and AuthService dependency types for
      enrollment, and inject the production durability-warning callback from the
      runtime logger.
- [ ] Re-run focused tests and commit:

```sh
git add apps/server/src/config.ts apps/server/src/config.test.ts \
  apps/server/src/index.ts apps/server/src/index.test.ts
git commit -m "refactor(auth): start local mode uninitialized"
```

## Chunk 2: Browser Enrollment

### Task 6: Client API And Authentication Controller

**Files:**

- Modify: `apps/client/src/auth-api.ts`
- Modify: `apps/client/src/auth-api.test.ts`
- Modify: `apps/client/src/useAuth.ts`
- Modify: `apps/client/src/useAuth.test.tsx`

- [ ] Add failing API tests for strict setup request parsing, `POST auth/setup`,
      credentials inclusion, abort behavior, response parsing, and bounded API
      errors.
- [ ] Add failing controller tests for setup-required publication, setup success,
      duplicate-operation cancellation, conflict recovery, authenticated ambiguous
      recovery, normal-login ambiguous recovery with the specified message, and
      retryable setup recovery.
- [ ] Assert distinct bounded controller messages: rate rejection **Too many setup
      attempts. Try again shortly.**, server validation **Password could not be
      accepted.**, already-created conflict **Administrator already created. Sign in
      to continue.**, ambiguous committed recovery **Administrator created. Sign in
      to continue.**, and unverifiable network state **Setup status could not be
      verified. Try again.**
- [ ] Run the focused client tests and confirm failures.
- [ ] Add `AuthApi.setup()` and expose `setup(password)` from `AuthController`.
- [ ] Implement ambiguous setup recovery by clearing setup input ownership in
      the view, refreshing `GET auth/session`, publishing authenticated results,
      mapping ordinary unauthenticated results to the administrator-created message,
      and retaining setup-required state for retry.
- [ ] Keep login/logout/private-fetch epoch and abort semantics unchanged.
- [ ] Re-run focused tests and commit:

```sh
git add apps/client/src/auth-api.ts apps/client/src/auth-api.test.ts \
  apps/client/src/useAuth.ts apps/client/src/useAuth.test.tsx
git commit -m "feat(auth): manage browser enrollment state"
```

### Task 7: First-Run Setup Interface

**Files:**

- Modify: `apps/client/src/LoginScreen.tsx`
- Modify: `apps/client/src/LoginScreen.test.tsx`
- Modify: `apps/client/src/AuthenticatedRoot.tsx`
- Modify: `apps/client/src/AuthenticatedRoot.test.tsx`
- Modify: `apps/client/src/theme.css`

- [ ] Add failing component tests for the **Set up FlanTerminal** heading,
      read-only configured username, `new-password` autocomplete, visible byte
      requirement, confirmation mismatch, submit locking, focus after error, field
      clearing after controller state change, and `Create administrator` action.
- [ ] Assert accessible local messages for password byte bounds and confirmation
      mismatch, plus each distinct controller error from Task 6 without rendering
      raw server error text.
- [ ] Add failing root integration tests selecting setup versus sign-in from the
      strict bootstrap branch and entering the workspace after enrollment.
- [ ] Run focused component tests and confirm failures.
- [ ] Extend `LoginScreen` with a setup-specific form branch. Keep password and
      confirmation state inside that branch, calculate UTF-8 bytes without
      viewport-dependent UI, reject mismatch/invalid bounds before API submission,
      and clear fields when setup state changes.
- [ ] Wire `AuthenticatedRoot` to pass bootstrap setup state and `auth.setup`.
- [ ] Reuse existing compact login tokens; add only focused helper/error styles,
      stable field dimensions, and existing responsive touch sizing.
- [ ] Re-run focused tests, build the client, and commit:

```sh
git add apps/client/src/LoginScreen.tsx apps/client/src/LoginScreen.test.tsx \
  apps/client/src/AuthenticatedRoot.tsx \
  apps/client/src/AuthenticatedRoot.test.tsx apps/client/src/theme.css
git commit -m "feat(auth): add first-run administrator form"
```

## Chunk 3: Deployment, Documentation, And Release Verification

### Task 8: Remove Bootstrap Secrets From Docker

**Files:**

- Modify: `docker-compose.yml`
- Modify: `docker-compose.example.yml`
- Modify: `docker-compose.e2e.yml`
- Modify: `.env.example`
- Modify: `scripts/verify-container.sh`

- [ ] Change static Compose verification first so it fails unless local Compose
      contains no password-file environment, service secret mount, or top-level
      secret declaration.
- [ ] Change resolved-model tests to require only `/app/data` and
      `/home/webterm` writable mounts for local and Cloudflare services.
- [ ] Replace failed-bootstrap-secret cases with container checks for fresh
      setup-required startup, malformed existing `auth.json` fail-closed behavior,
      and mode override compatibility.
- [ ] Run `scripts/verify-container.sh --check hardening` and confirm the old
      Compose model fails the new assertions.
- [ ] Remove local password secret declarations/mounts and obsolete environment
      variables from default, example, and E2E Compose and `.env.example`.
- [ ] Update container verification helpers to enroll through the setup endpoint,
      retain the chosen test password only in process memory, logout, log in again,
      change password, recreate the container, and verify persistence and log/data
      secrecy.
- [ ] Re-run `scripts/verify-container.sh --check hardening`, then run the full
      `scripts/verify-container.sh` runtime workflow and commit:

```sh
git add docker-compose.yml docker-compose.example.yml docker-compose.e2e.yml \
  .env.example scripts/verify-container.sh
git commit -m "build(auth): remove local bootstrap password secret"
```

### Task 9: Playwright And Operator Documentation

**Files:**

- Modify: `scripts/run-e2e.sh`
- Modify: `playwright.config.ts`
- Modify: `e2e/fixtures/auth.ts`
- Create: `e2e/first-run-auth.setup.ts`
- Modify: `e2e/local-auth.spec.ts`
- Modify: `README.md`

- [ ] Add a failing Playwright local-auth workflow that starts fresh, verifies
      setup UI, rejects mismatched confirmation locally, enrolls, reaches the
      terminal, logs out, and signs in with the enrolled password at `/` and the
      configured base path.
- [ ] Remove temporary local password-file creation from `scripts/run-e2e.sh`;
      pass the test password only to the Playwright process, not the app container.
- [ ] Add `enrollLocalAdministrator(page)` to the auth fixture for the exact setup
      form interaction, confirmation mismatch assertion, successful enrollment,
      workspace arrival, logout, and normal sign-in with `E2E_LOCAL_PASSWORD`.
- [ ] Add a `first-run-auth` Playwright setup project matching only
      `e2e/first-run-auth.setup.ts`, plus a `workflows` project that ignores the
      setup file and declares `dependencies: ['first-run-auth']`. The setup test
      skips in Cloudflare mode; in local mode it must start on a fresh Compose
      volume and complete enrollment before any other spec can run.
- [ ] Keep `workers: 1` as the suite invariant so password-change coverage cannot
      race other local workflows. Update `local-auth.spec.ts` terminology and
      assertions from bootstrap credential to enrolled administrator password.
- [ ] Run the local E2E variant and confirm failure before updating the workflow.
- [ ] Implement the Playwright setup flow and ensure Cloudflare variants remain
      unchanged.
- [ ] Rewrite README quick start, architecture, authentication, configuration,
      reset/recovery, troubleshooting, backup, upgrade, and security guidance for
      first-visitor enrollment. Explicitly warn operators to enroll before network
      exposure and explain that deleting `auth.json` reopens the claim window.
- [ ] Require recovery operators to stop or network-isolate the service, retain an
      app-data backup, delete only `auth.json`, restart while still isolated, complete
      enrollment, and only then restore proxy/network exposure.
- [ ] Document secure removal of obsolete `secrets/local_auth_password` after a
      successful upgrade and confirm no tracked docs instruct users to create it.
- [ ] Run the focused local E2E workflow and commit:

```sh
git add scripts/run-e2e.sh playwright.config.ts e2e/fixtures/auth.ts \
  e2e/first-run-auth.setup.ts e2e/local-auth.spec.ts README.md
git commit -m "docs(auth): document first-run administrator setup"
```

### Task 10: Full Verification And Publication

**Files:**

- Modify only files required by failures attributable to this feature.

- [ ] Run `npm run format:check`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm test` and record client/server/shared counts.
- [ ] Run `npm run build`.
- [ ] Run `scripts/verify-container.sh --check hardening`.
- [ ] Run the full `scripts/verify-container.sh` runtime workflow.
- [ ] Run the local Playwright E2E variant for both root and base-path cases.
- [ ] Run `git diff --check`, inspect `git status`, and scan tracked files for
      obsolete bootstrap-secret references and accidental secret material.
- [ ] Rebuild and start the default Compose application without a `secrets/`
      directory, verify `/health`, `/ready`, setup bootstrap, enrollment, logout,
      login, and container recreation manually.
- [ ] Commit any verification-only corrections with a focused message, push
      `main`, and report migration instructions and the first-visitor security
      boundary.
