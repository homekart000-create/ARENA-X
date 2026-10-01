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

The current `localStorage` frontend authentication is unchanged. It is not connected to these endpoints, and no browser records are copied or migrated.

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

The migrations create `users`, `user_credentials`, `user_role_assignments`, `auth_sessions`, and the tournament, registration, team, invitation, match, participant, room-credential, and result tables. Password hashes and session-token hashes are stored separately from user profile fields. Migration execution was **NOT RUN** because no `DATABASE_URL` is configured.

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

## Tests

Run the API tests with `npm test`. Tests use isolated in-memory repositories and exercise the actual Fastify routes without connecting to or modifying a PostgreSQL database. They cover authentication plus tournament, team, mode-size, match, result, and room-credential behavior. These tests do not verify SQL execution, transaction behavior, or migration compatibility against live PostgreSQL; those integration checks remain **NOT RUN** until a test `DATABASE_URL` is configured.

## Build and start

```powershell
npm run typecheck
npm run build
npm run start
```

## Current limitations

- No localStorage users, tournaments, teams, invitations, matches, or sessions have been imported; the existing frontend remains a local demo and is not connected to these endpoints.
- Password reset, email verification, session refresh, CSRF tokens, account administration, and distributed rate limiting are not implemented.
- Wallet, payment, and KYC features are not implemented.
- Production deployment still requires HTTPS, a managed secret/database configuration, operational monitoring, and a PostgreSQL migration rehearsal.