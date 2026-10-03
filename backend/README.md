# ARENA-X Backend

This is the ARENA-X TypeScript and Fastify JSON API. Authentication and competition data are stored in PostgreSQL through parameterized `pg` queries, with schema changes managed by `node-pg-migrate`. It remains separate from the GitHub Pages frontend.

## Requirements

- Node.js 22 or later (Node.js 24 LTS is recommended)
- npm
- PostgreSQL is required for data-backed authentication and competition endpoints.
- Without `DATABASE_URL`, the server still starts and serves health checks; data-backed endpoints return a safe service-unavailable response.

## Setup

From this directory, install dependencies and create a local environment file:

```powershell
npm install
Copy-Item .env.example .env
```

Set `DATABASE_URL` to a PostgreSQL connection string. Never commit `.env`. `CORS_ORIGINS` is a comma-separated list of exact origins; the example contains only `https://homekart000-create.github.io`. Add the local static server origin to a development `.env` when needed. Production startup fails when the allowlist is empty; wildcard origins are not accepted.

## Run

```powershell
npm run dev
```

The API listens on `HOST` and `PORT` (defaults: `127.0.0.1:3000`). Check `GET /api/health` for a JSON response indicating the process is running. The health endpoint does not test database connectivity.

## Authentication API

- `POST /api/auth/register` creates an active normal user and an HTTP-only session.
- `POST /api/auth/login` accepts an email or username and password.
- `POST /api/auth/logout` revokes the current session and clears the cookie.
- `GET /api/auth/me` returns the authenticated user's safe profile.
- `GET /api/users/me` returns the same safe profile.

Passwords are hashed with Argon2id. Cookies are HTTP-only with a seven-day default lifetime; production uses `Secure` and `SameSite=None` because the GitHub Pages frontend and API are cross-site. Development uses `SameSite=Lax`. Auth writes require an `Origin` header matching the exact allowlist, and CORS allows credentials only for configured exact origins. No cookie signing secret is required: cookies contain random opaque tokens, while only token hashes are stored in PostgreSQL.

Registration is limited to 5 requests per IP per 15 minutes and login to 10 per IP per 15 minutes. The current rate-limit store is process-local; multi-instance deployments need a shared rate-limit store.

The frontend authentication/session integration and its GitHub Pages configuration constraints are documented in [`../docs/frontend-auth-phase-1.md`](../docs/frontend-auth-phase-1.md). Competition frontend compatibility and Step 20 API limitations are documented in [`../docs/frontend-competition-phase-2.md`](../docs/frontend-competition-phase-2.md). The frontend remains static; no Node runtime is required to serve it.

## Database and migrations

The implementation uses the PostgreSQL `pg` client with parameterized SQL, not an ORM. `node-pg-migrate` tracks and runs the reversible migration in `migrations/001_create_auth_tables.cjs`.

After configuring `DATABASE_URL` in a local `.env`, run migrations from `backend/`:

```powershell
npm run migrate:up
```

To roll back the latest migration in a disposable development database:

```powershell
npm run migrate:down
```

The migrations create `users`, `user_credentials`, `user_role_assignments`, `auth_sessions`, the tournament/team/match tables, and wallet/ledger tables. Password hashes and session-token hashes are stored separately from user profile fields. Migration execution was **NOT RUN** because no `DATABASE_URL` is configured.

## Operator-only first-admin bootstrap

Normal registration always creates a `user` role. To grant the existing `admin` role, an authorized database operator can run the backend CLI; there is intentionally no public API for granting roles. This command requires the exact email or username and an explicit confirmation flag:

```powershell
npm run admin:grant -- --confirm <exact-email-or-username>
```

Run it from `backend/` after dependencies are installed and migrations are current. Supply `DATABASE_URL` through the operator's approved secret manager or private shell environment; the CLI never prints it. For local work, `dotenv/config` loads the backend `.env`. Before using a production connection, independently verify the exact account identifier with the account owner. The command only grants an existing active account, locks the matched user in a transaction, rejects missing/ambiguous/inactive accounts, and is idempotent. It writes no credentials or session data and does not accept a client-supplied role. No production account is promoted by deployment or migration.

The assignment's existing `assigned_at` records when the current grant was made. The existing KYC/withdrawal audit tables are domain-specific and are not used for role grants; the command does not write to those records.

## Tournament, team, and match APIs

- `GET /api/tournaments` and `GET /api/tournaments/:id` return public tournaments; admin sessions may also view drafts.
- `POST /api/tournaments` and `PATCH /api/tournaments/:id` require an admin session.
- `POST /api/tournaments/:id/register` and `DELETE /api/tournaments/:id/register` require an authenticated user. Registration changes no wallet data.
- `GET /api/teams/:id`, `POST /api/teams`, `PATCH /api/teams/:id`, `POST /api/teams/:id/members`, and `DELETE /api/teams/:id/members/:userId` provide team access and captain/admin membership controls.
- `POST /api/teams/:id/invitations` creates invitations; `PATCH /api/team-invitations/:id` lets only the receiver accept or decline.
- `GET /api/matches` and `GET /api/matches/:id` return public match projections; an admin can also read private matches.
- `POST /api/matches`, `PATCH /api/matches/:id`, and `POST /api/matches/:id/result` require an admin session.
- `GET /api/matches/:id/room-credentials` requires an authenticated admin or an eligible participant while room access is enabled.

Tournament participation uses the existing `type` field: `Solo` registers one authenticated player without a team, `Duo` requires a team with exactly two active members, and `Squad` requires exactly four. Teams are not assigned a separate mode field or a universal four-member backend ceiling. Their active registrations constrain roster changes to remain valid for the registered tournament types. A tournament's `maxSlots` counts registrations, not individual roster members.

Match records store selected registration links. Public match projections never include room secrets and expose results only after publication. Room IDs/passwords are encrypted with AES-256-GCM and stored separately from match rows. Set `ROOM_CREDENTIALS_KEY` to a base64-encoded 32-byte key using the deployment secret manager; non-empty room credentials cannot be stored without it. For local development, generate a key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` and keep it only in the ignored `.env` file.

All mutation endpoints require an exact allowlisted `Origin`; configure the GitHub Pages origin or an explicitly approved development origin in `CORS_ORIGINS`. Client-provided roles, owners, statuses, result identities, or registration member lists are not trusted. Tournament capacity, participant uniqueness, team membership, invitations, match capacity, and result membership are checked server-side and backed by database constraints/transactions where applicable.

## Wallet and ledger APIs

- `GET /api/wallet` returns only the authenticated user's INR wallet projection.
- `GET /api/wallet/transactions` returns that user's newest-first history and supports bounded `limit`/`offset` plus type/status filters.
- `POST /api/wallet/withdrawal-requests` accepts `amountMinor` and an `Idempotency-Key` header; it creates a pending hold after server-side eligibility checks.

Money is integer paise throughout the API and database (`100 paise = INR 1`). For example, INR 12.34 is `amountMinor: 1234`. Wallet reads return `availableBalanceMinor`, `reservedBalanceMinor`, and integer total fields; client-supplied balances are never accepted. Transaction amounts are positive integer minor units; direction determines credit or debit.

Internal `WalletService` operations cover deposit-credit recording, adjustment, winning, refund, and tournament entry-fee debit. They are not exposed as arbitrary HTTP balance-mutation endpoints. Each operation requires an idempotency key, locks the wallet row, writes immutable transaction facts, a status event, balanced signed ledger entries, and the cached projection in one PostgreSQL transaction. Replays with the same key/payload return the prior transaction; reuse with a different payload conflicts. A deferred database constraint verifies that each transaction's ledger postings sum to zero, and append-only triggers prevent edits/deletes to transaction facts, events, and entries.

Withdrawal requests reduce available funds and move the same amount to reserved funds atomically. The workflow has controlled pending/approved/processing/paid/failed/rejected/cancelled states. Admin review and payout results use balanced append-only ledger postings to settle the reserved amount or release it; they never overwrite wallet balances. Payout retries use durable attempt IDs and idempotency keys, while ambiguous results stay reserved for reconciliation.

## KYC and review APIs

- `GET /api/kyc` reports the authenticated user's profile or `unverified`; `POST`/`PATCH /api/kyc` submit/update their own profile.
- `GET /api/admin/kyc`, `GET /api/admin/kyc/:userId`, and `GET /api/admin/kyc/:userId/audit` are admin-only. `POST /api/admin/kyc/:userId/review` handles admin decisions and stores reviewer, time, reason, and append-only audit records.
- KYC transitions are `unverified -> pending -> verified/rejected`, `verified -> suspended`, `rejected -> pending`, and `suspended -> verified/pending`. Client status/reviewer/provider-verification fields are rejected.
- Admin withdrawal endpoints are `GET /api/admin/withdrawals`, `GET /api/admin/withdrawals/:withdrawalRequestId`, and POST approve/reject/retry/reconcile actions. Owners can list/view their requests and cancel only pending/approved ones. User detail is owner-scoped.
- Production requires verified KYC for withdrawals. `WITHDRAWAL_KYC_REQUIRED` cannot be disabled in production; configurable minimum/maximum values are integer paise and capped by the existing wallet maximum.
- Payout provider contracts support create/status/reconcile/webhook verification, but runtime currently injects an unavailable provider. No real bank/UPI/provider payout is performed or represented as successful.
- Mutation and webhook limits are process-local, matching the existing Fastify rate limiter; deployments with multiple API instances need a shared store.
- This is infrastructure only, not a claim of compliance with gaming, KYC, AML, tax, RBI, payment-provider, or other legal/regulatory requirements.

## Tests

Run the API tests with `npm test`. Tests exercise Fastify routes and in-memory/scripted repositories without connecting to or modifying a PostgreSQL database. They do not verify SQL execution, true multi-connection PostgreSQL concurrency, or migration compatibility against live PostgreSQL; those integration checks remain **NOT RUN** until a test `DATABASE_URL` is configured.

## Build and start

```powershell
npm run typecheck
npm run build
npm run start
```

## Current limitations

- No localStorage users, tournaments, teams, invitations, matches, or sessions have been imported; the existing frontend remains a local demo and is not connected to these endpoints.
- Password reset, email verification, session refresh, CSRF tokens, account administration, and distributed rate limiting are not implemented.
- No live payout adapter, payout destination/bank/UPI storage, unattended reconciliation worker, or frontend KYC/withdrawal flow is implemented. No payout webhook is enabled in runtime configuration.
- KYC and payout behavior must receive external legal, provider, operational, and data-retention review before any production payout use.
- Production deployment still requires HTTPS, a managed secret/database configuration, operational monitoring, and a PostgreSQL migration rehearsal.