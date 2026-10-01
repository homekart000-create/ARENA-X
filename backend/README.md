# ARENA-X Backend

This is the ARENA-X TypeScript and Fastify JSON API. Authentication data is stored in PostgreSQL through parameterized `pg` queries, with schema changes managed by `node-pg-migrate`. It remains separate from the GitHub Pages frontend.

## Requirements

- Node.js 22 or later (Node.js 24 LTS is recommended)
- npm
- PostgreSQL is required for registration, login, logout, and authenticated user endpoints.
- Without `DATABASE_URL`, the server still starts and serves health checks; auth endpoints return a safe service-unavailable response.

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

The migration creates `users`, `user_credentials`, `user_role_assignments`, and `auth_sessions`. Password hashes and session-token hashes are stored separately from user profile fields. No migration was executed as part of this setup because no `DATABASE_URL` is configured.

## Tests

Run the API tests with `npm test`. Each test uses a new in-memory repository and exercises the actual Fastify routes without connecting to or modifying a PostgreSQL database. These tests do not verify SQL execution or migration compatibility against a live PostgreSQL instance.

## Build and start

```powershell
npm run typecheck
npm run build
npm run start
```

## Current limitations

- No localStorage users or sessions have been imported; the existing frontend remains a local demo.
- Password reset, email verification, session refresh, CSRF tokens, account administration, and distributed rate limiting are not implemented.
- Tournament, team, match, wallet, payment, and KYC features are not implemented.
- Production deployment still requires HTTPS, a managed secret/database configuration, operational monitoring, and a PostgreSQL migration rehearsal.