# Production Security Hardening: Step 23A

## Scope and status

Step 23A audited authentication/session handling, authorization, input validation, database access, rate limiting, CORS, response headers, room credentials, wallet operations, errors/logging, secrets/configuration, dependencies, frontend storage/rendering, and service-worker behavior.

The reported paid tournament-registration vulnerability was fixed and covered by a production-repository regression test. No Step 24 payment, KYC, or payout work was started.

## Finding and fix

### HIGH — paid registration could bypass entry-fee settlement

The public authenticated tournament-registration API previously created registrations for tournaments with a nonzero entry fee without collecting or verifying payment. The frontend's disabled paid-entry UI was not an authorization control; direct API calls could bypass it.

`PostgresCompetitionRepository` now checks the locked tournament row's integer `entry_fee_minor` within the registration transaction and rejects nonzero fees with HTTP 409 and code `PAID_REGISTRATION_UNAVAILABLE`. The error causes transaction rollback before a registration row can be inserted. Free registrations retain their existing path. The paid-registration repository test asserts the conflict, rollback, client release, and absence of a registration insert.

Atomic wallet deduction plus registration remains intentionally unavailable until a supported settlement contract is designed and implemented.

## Controls verified

- Passwords use Argon2id; opaque session tokens are stored as hashes. Sessions expire and revoked sessions are rejected. Logout revokes the session.
- Authentication responses do not return password hashes or session tokens. Production auth cookies are HttpOnly and Secure, with SameSite configuration tested.
- Protected actions derive user identity from the authenticated server session. Admin checks are server-side; tested user-scoped resources reject unauthorized access.
- Mutating routes enforce exact configured-origin checks. CORS production origins are configured via `CORS_ORIGINS`, not a wildcard.
- Competition and wallet SQL values are parameterized. Wallet amounts use integer paise, withdrawal requests are idempotent and transactional, and concurrent writes use database locking.
- Public match responses omit room credentials. Authorized room credentials use AES-256-GCM and the environment-provided `ROOM_CREDENTIALS_KEY`.
- Frontend authentication tokens/passwords are not persisted. Migrated wallet data is backend-authoritative; room credentials are not stored in browser storage.
- The service worker does not cache authenticated API responses or wallet/account data.
- API error handling returns client-safe errors rather than raw database details.

## Step 23C — wallet, room credentials, secrets, and abuse

### Wallet / financial security

**Verified:** wallet mutations use positive safe integer paise with a ₹1,000,000 per-operation ceiling. Withdrawal routes accept only `amountMinor`, require authentication, an allowed Origin, and a user-scoped idempotency key. The server obtains the user ID from the authenticated session. Database operations lock the wallet and atomically reserve funds with ledger/withdrawal records; the `(user_id, idempotency_key)` constraint and request hash protect replay and changed-payload conflicts. No public credit/debit endpoint exists. These controls do not provide real deposits or payout settlement.

**Abuse control added:** withdrawal requests now have a route-specific process-local limit of 5 requests per 15 minutes, matching registration's route limit. The regression test verifies throttling and that repeated idempotent submissions still create only one withdrawal transaction.

### Room credentials

**Verified:** credentials are encrypted using AES-256-GCM with a random IV and authentication tag. `ROOM_CREDENTIALS_KEY` is parsed only from environment configuration and must be canonical base64 encoding of exactly 32 bytes. Public match projections omit plaintext credentials. Credential retrieval checks the authenticated participant/admin authorization and match visibility/state before decrypting.

**Tests added:** missing-key decryption returns a generic `ROOM_ENCRYPTION_UNAVAILABLE` response without plaintext or key material; malformed-length keys are rejected during configuration parsing. No credentials are placed in browser storage or written to application request logs.

### Secrets and environment

**Verified:** `.gitignore` excludes `backend/.env` and `backend/.env.*`, except the tracked `backend/.env.example`. The example leaves deployment secrets blank. `DATABASE_URL`, `ROOM_CREDENTIALS_KEY`, `CORS_ORIGINS`, cookie name, session lifetime, host, and port are read from environment configuration; no production secret should be copied from example values. The tracked-path audit found no tracked real `.env` file.

**Deployment-dependent:** this code review cannot establish the actual secret-manager values, database TLS, edge HTTPS/proxy behavior, or effective deployment environment. `DATABASE_URL` was not configured, so no live database was used.

### Rate limiting and operational errors

Login is limited to 10 requests per 15 minutes, registration to 5 per 15 minutes, and withdrawal requests to 5 per 15 minutes. Limits are process-local and do not coordinate across instances; configure a shared/edge limiter before multi-instance production if a global limit is required. No blanket rate limit was added to ordinary tournament/team/match use.

API 5xx logs retain request ID and error type rather than raw exception values. The startup failure handler logs the raw startup exception server-side; deployment log access/retention must therefore be restricted. No evidence showed request passwords, cookies, room plaintext, or wallet amounts included in normal application logs. Error responses do not echo encryption errors or key material.

### Step 23C disposition

- **Fixed:** route-specific withdrawal abuse limit.
- **Verified/tested:** integer-paise bounds, auth and origin checks, session-derived ownership, atomic reservation/idempotency behavior, encrypted/authorized room credential access, safe failures for missing/invalid room keys, and absence of secrets from tested responses.
- **Deployment-dependent:** process-local rate limiting across instances, HTTPS/proxy and edge policies, real secret-manager contents, log retention/access controls, and database TLS.
- **Deferred to Step 24:** payment/deposit handling, KYC, bank/UPI payout settlement, and paid tournament entry settlement.

## Production configuration requirements

Configure these in the deployment secret/configuration system; sample values in `.env.example` are examples, not production credentials:

| Variable | Production requirement |
| --- | --- |
| `NODE_ENV` | Set to `production` to enable production cookie behavior. |
| `DATABASE_URL` | Required for production data access. Protect credentials and configure secure database transport at the hosting/database layer. |
| `CORS_ORIGINS` | Required in production; provide only trusted exact frontend origins including scheme and host. |
| `ROOM_CREDENTIALS_KEY` | Provide a managed secret containing canonical base64 for a 32-byte key wherever room credentials are stored or read. Never commit or expose it. |
| `HOST`, `PORT` | Set to the deployment's intended bind interface and port; defaults are development-oriented. |
| `SESSION_TTL_HOURS` | Select a production session lifetime appropriate to the deployment's security policy. |
| `AUTH_COOKIE_NAME` | Optional; set only if the deployment requires a distinct cookie name. |

Terminate HTTPS correctly at the production edge, preserve secure cookie behavior through any reverse proxy, and verify the deployed CORS, database TLS, and secret values in the actual hosting environment.

## Remaining risks and deployment work

- Login, registration, and withdrawal requests have explicit process-local rate limits (10, 5, and 5 requests per 15 minutes respectively). There is no shared rate-limit store, and other mutation routes do not have explicit route-specific limits. These limits do not coordinate across multiple server instances; production multi-instance abuse controls require a shared strategy or an edge rate limiter.
- The application did not configure CSP, HSTS, frame protection, `X-Content-Type-Options`, or `Referrer-Policy` in the audited code. JSON API responses do not need a frontend script CSP, but the frontend static host/reverse proxy should set appropriate CSP (including `frame-ancestors`), HSTS on HTTPS, MIME-sniffing, referrer, and permissions policies without breaking the PWA.
- Effective HTTPS/proxy behavior, database TLS, and production headers/configuration could not be verified without access to the deployed environment.
- `DATABASE_URL` was not configured. Unit/contract tests and scripted repository tests do not establish live PostgreSQL behavior.
- Deposits/payment processing, KYC, bank/UPI payout settlement, and paid tournament entry settlement remain out of scope for this phase and are deferred to Step 24.

## Dependency audit

`npm audit` in `backend/` reported zero vulnerabilities across 144 dependency entries (production, development, and optional). The repository root has no package manifest/lockfile, so a root-level `npm audit` is not applicable; dependency audit was run against the backend package and its lockfile.

## Verification

- Backend auth, competition, wallet, and production-repository tests: 72 passed.
- Frontend auth, competition, and wallet tests: 38 passed.
- TypeScript typecheck and backend build: passed.
- Syntax checks: 19 tracked JavaScript files passed.
- `git diff --check`: passed.
- Step 23A browser check covered all migrated pages at desktop/mobile widths. Step 23C smoke is limited to wallet, match, and login at desktop/mobile widths. Both use local static pages and are not live API or database tests.
- Live PostgreSQL verification: not run (`DATABASE_URL` was not configured).

## 23D Final Verification

This section records final verification of the existing 23A–23C work. It does not claim that the application is production-secure or fully production-ready.

| Area | Status and result |
| --- | --- |
| Backend tests | **VERIFIED** — complete suite passed: 72 tests, 0 failures. |
| Frontend tests | **VERIFIED** — auth 14/14, competition 15/15, wallet 9/9. |
| Typecheck/build | **VERIFIED** — both TypeScript typecheck projects and backend build passed. |
| JavaScript/diff | **VERIFIED** — syntax check passed for 19 tracked JS files; `git diff --check` passed. |
| Dependency audit | **VERIFIED** — backend `npm audit` reported 0 vulnerabilities (0 info, low, moderate, high, critical). No dependency update was necessary; safe fixes are not applicable. |
| Secrets | **VERIFIED (repository scope)** — `backend/.env.example` is the only tracked backend env file; no tracked real `.env` was found. `.gitignore` excludes `backend/.env` and `backend/.env.*` except the example. Narrow scans found no hardcoded database URL, room key, or common provider-secret pattern. This is not a guarantee against every secret pattern or untracked deployment secret. |
| Auth/authorization | **VERIFIED (tests/code)** — protected-route authentication, user-scoped wallet/profile access, team/tournament/match authorization, server-side admin checks, session expiry/revocation/logout, and sensitive auth response fields are covered by existing tests. |
| Wallet | **VERIFIED (tests/code)** — integer paise bounds, no public arbitrary client credit/debit route, session-derived ownership, withdrawal reservation/idempotency, concurrent debit safety, and ledger transaction/rollback behavior have regression coverage. No live database invariant check was run. |
| Room credentials | **VERIFIED (tests/code)** — public projections omit secrets; retrieval is authenticated and permission-checked; AES-256-GCM uses an environment-provided 32-byte key; missing/malformed key paths return safe failures; frontend does not persist credentials. Tests assert secret values are absent from public/safe error responses. |
| Rate limits | **VERIFIED (tests/code)** — login 10/15 minutes, registration 5/15 minutes, withdrawal 5/15 minutes. **DEPLOYMENT-DEPENDENT** — limits are process-local and need shared/edge enforcement if quotas must be global across instances. |
| Browser/PWA | **VERIFIED (local static smoke)** — login, signup, home, tournament list/detail, team pages, matches, wallet, admin, and profile were checked at desktop and mobile widths. No horizontal overflow, uncaught browser exceptions, console errors, or failed page requests were observed; manifest and service-worker registration were present. **NOT VERIFIED** — this does not establish live API or database behavior. |
| Live database | **NOT VERIFIED** — `DATABASE_URL` was not configured; no live PostgreSQL test was performed. |

### Configuration and deployment status

- `NODE_ENV`, `DATABASE_URL`, `CORS_ORIGINS`, `ROOM_CREDENTIALS_KEY`, `SESSION_TTL_HOURS`, `HOST`, and `PORT` are environment-driven and have example names/defaults in `backend/.env.example`. **NOT VERIFIED** — actual production values and secret-manager deployment are unavailable here.
- **DEPLOYMENT-DEPENDENT / NOT VERIFIED** — production HTTPS termination, reverse-proxy forwarding/trust behavior, Secure cookie behavior in the actual deployment, database TLS, and production security headers.
- **DEPLOYMENT-DEPENDENT** — production deployment is not available in this repository verification. Do not infer security from configuration presence alone.
- **DEFERRED** — deposits/payment gateway, KYC, bank/UPI payout settlement, and paid tournament entry settlement remain Step 24 work.
- **NOT VERIFIED** — distributed rate limiting is not present; process-local limits are not a substitute for a shared or edge policy in multi-instance deployments.

### Final status

Steps 23A, 23B, 23C, and 23D are complete for the repository-level audits, fixes, tests, and local static browser checks described above. This is not a production certification or a claim of full production readiness.
