# First-Run Password Enrollment Design

## Purpose

Replace host-managed bootstrap passwords with an explicit browser enrollment
flow for new local-authentication installations. The first visitor to an
uninitialized installation becomes the administrator by setting the password
for the configured `LOCAL_AUTH_USERNAME`.

Existing installations with `/app/data/auth.json` continue to use normal local
sign-in without migration or credential replacement.

## Decisions

- Use a dedicated first-run enrollment endpoint instead of overloading login.
- Keep `LOCAL_AUTH_USERNAME` authoritative and display it read-only during
  setup.
- Remove the local password file and Compose secret from the normal deployment.
- Treat the first successful enrollment request as the administrator claim.
- Require 12 to 72 UTF-8 bytes for the password and hash it with the configured
  bcrypt cost.
- Never log, return, or persist the plaintext password.
- Keep Cloudflare Access, trusted-header, and no-auth modes unchanged.

## Authentication State

`CredentialStore` has two local states after initialization:

1. `uninitialized`: no valid `auth.json` exists.
2. `initialized`: a valid credential record was loaded or enrolled.

Initialization reads and validates an existing credential record but does not
create one and does not read a bootstrap secret. A missing record is a valid
first-run state. Unsafe, malformed, or unreadable existing records remain fatal
startup errors so corruption cannot silently reopen enrollment.

The existing public `GET /api/auth/session` contract adds a local
setup-required state containing the configured username. The endpoint is not
renamed or aliased. An initialized local deployment without a valid application
session continues to return the existing unauthenticated local state.

The local public states are exact JSON objects:

```json
{
  "authenticated": false,
  "mode": "local",
  "setupRequired": true,
  "username": "webterm"
}
```

```json
{ "authenticated": false, "mode": "local" }
```

The setup-required object is a distinct strict shared-schema branch; the
ordinary unauthenticated object does not gain optional setup fields.

## Enrollment Flow

1. The browser requests `GET /api/auth/session`.
2. An uninitialized local server returns `setupRequired: true`, mode `local`,
   and the configured username.
3. The client renders a dedicated **Set up FlanTerminal** form with the username
   read-only and new-password and confirmation inputs.
4. The client checks that the values match and submits
   `{ "password": "..." }` to `POST /api/auth/setup`.
5. The route enforces the same public mutation origin, content-type, and body
   limits used by login, validates the request schema, and passes the bounded
   client address to enrollment admission control.
6. `AuthService` rejects non-local mode and an already initialized store before
   consuming rate capacity. It then consumes the existing global and
   per-address login-rate buckets, reserves an existing bounded establishment
   slot, and delegates to `CredentialStore.enroll()`.
7. The credential store serializes enrollment attempts, rechecks its current
   state, hashes the password, durably writes `auth.json` with mode `0600`, and
   transitions to initialized only after a committed write.
8. The winner receives a normal local authenticated session and enters the
   terminal workspace.

Concurrent admitted attempts are serialized within the single supported
application process. The credential state is rechecked inside that serialized
operation before bcrypt begins, so at most one enrollment bcrypt operation runs
at a time. After a committed claim, no later request hashes or replaces the
credential. If hashing or persistence fails before commitment, the store stays
uninitialized and the next admitted queued request may attempt enrollment. The
existing establishment bound, derived from
`AUTH_SESSION_MAX_COUNT` and capped by `AuthService`, limits active and queued
enrollment requests; attempts beyond that bound or either rate bucket receive
`429 rate_limited`. Admitted losers receive `409 setup_already_completed`,
refresh bootstrap state, and see normal sign-in. Enrollment never replaces an
initialized credential.

The endpoint contract is:

| Server state                               | Request                                                                         | Result                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Uninitialized local, admitted winner       | Strict `{ "password": string }`                                                 | `200`, normal authenticated local bootstrap, and session cookie |
| Uninitialized local, invalid body/password | Invalid JSON contract, password outside 12–72 UTF-8 bytes, or password with NUL | `400 { "error": "invalid_request" }`                            |
| Uninitialized local, admission rejected    | Valid request                                                                   | `429 { "error": "rate_limited" }`                               |
| Initialized local                          | Valid request                                                                   | `409 { "error": "setup_already_completed" }`                    |
| Non-local authentication mode              | Any valid setup request                                                         | `409 { "error": "invalid_session_state" }`                      |

The initialized and non-local prechecks run before rate-limit consumption. The
serialized credential-store recheck remains authoritative for requests that
passed the uninitialized precheck concurrently.

`POST /api/auth/login` on an uninitialized local server returns
`409 { "error": "setup_required" }` without running credential verification.
The setup endpoint is not available as a credential mutation after enrollment.

## User Interface

The setup form reuses the compact authentication-page layout and includes:

- Heading **Set up FlanTerminal**.
- Configured username presented as read-only account identity.
- Password and confirmation controls with `autocomplete="new-password"`.
- A visible 12 to 72 UTF-8 byte requirement.
- Submit command **Create administrator**.
- Accessible, bounded mismatch, validation, conflict, and network errors.
- Submission locking so duplicate browser actions do not create parallel work.

The existing sign-in and upstream access-error states remain unchanged.

## Security

First-visitor enrollment intentionally creates a claim window. The default
Compose deployment remains bound to `127.0.0.1`; operators must complete setup
before exposing the application through Cloudflare, another reverse proxy, or
an untrusted network.

The setup endpoint requires an accepted request origin and JSON mutation
headers. It is rate-limited to bound bcrypt work and request concurrency.
Passwords are accepted only in request bodies, are never included in structured
logs, and are cleared from client component state after completion or state
transition.

Deleting `/app/data/auth.json` reopens enrollment. Recovery documentation must
require stopping or isolating the service before deletion and retaining a
backup. Invalid existing credential data must fail closed instead of being
treated as a fresh installation.

Enrollment reuses login admission rather than adding an independent unbounded
queue. Bcrypt work is serialized, and no request hashes after a credential has
committed. Rate-limit and admission errors do not reveal whether another
request is currently hashing a password.

## Deployment Changes

The default Compose service no longer mounts `local_auth_password`, and the
top-level secret declaration and `LOCAL_AUTH_PASSWORD_FILE_HOST` configuration
are removed. Local mode can start with only writable application data and home
volumes. The obsolete runtime password-file setting is removed from the active
configuration contract.

Existing `auth.json` records remain compatible. Existing ignored password files
become unused and may be securely removed after an upgrade. Cloudflare-specific
Compose remains independent from local credentials.

## Error Handling

- Missing `auth.json`: valid setup-required state.
- Malformed, unsafe, or unreadable `auth.json`: fatal startup failure.
- Invalid password: bounded `400 invalid_request` response.
- Enrollment after initialization: `409 setup_already_completed`.
- Rate or concurrency admission failure: `429 rate_limited`.
- Persistence or hashing failure: generic `500` without sensitive details.
- Client conflict: refresh bootstrap and transition to normal sign-in.
- Client network failure: retain setup mode and permit a deliberate retry.

`SecureJsonFile.replace()` can report `committed_durability_uncertain` when the
credential rename succeeded but syncing its parent directory failed. Enrollment
treats both `committed` and `committed_durability_uncertain` as claimed,
transitions the in-memory store to initialized, and never permits a retry to
overwrite it. The uncertain outcome emits a bounded structured durability
warning without credential values but otherwise returns enrollment success.
Only `not_committed` leaves the store uninitialized and produces a generic
server error.

Credential commitment is the irreversible enrollment boundary. If session
creation, workspace bootstrap, cookie publication, or response delivery fails
after that boundary, credentials remain initialized and are never rolled back.
On any ambiguous setup failure, the client refreshes `GET /api/auth/session`
and clears both password fields. An authenticated response is published through
the normal auth controller and enters the workspace. An unauthenticated response
that no longer requires setup presents normal sign-in with the bounded message
**Administrator created. Sign in to continue.** A setup-required response
permits enrollment retry. A workspace-bootstrap failure revokes any partially
created application session but does not remove credentials.

## Verification

Automated tests cover:

- Fresh local initialization without a password secret.
- Setup-required bootstrap parsing and publication.
- First enrollment persistence, bcrypt hashing, and immediate authentication.
- Exactly one winner under concurrent enrollment.
- Refusal to overwrite initialized credentials.
- Password byte boundaries and invalid request rejection.
- Origin, rate, and concurrency enforcement.
- Existing credential loading and login after restart.
- Setup form rendering, confirmation validation, focus, submission locking, and
  authenticated transition.
- Compose local startup without a secret declaration or host secret file.
- Container first-run enrollment followed by logout and normal login.
- Absence of plaintext setup passwords from logs and persisted metadata.

Before release, run formatting, linting, strict type checking, unit and component
tests, production build, container hardening verification, and the core
Playwright workflow.
