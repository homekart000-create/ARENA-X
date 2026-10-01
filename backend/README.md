# ARENA-X Backend

This is the first backend service for ARENA-X: a TypeScript and Fastify JSON API, structured to add PostgreSQL access later. It is separate from the existing GitHub Pages frontend.

## Requirements

- Node.js 22 or later (Node.js 24 LTS is recommended)
- npm
- PostgreSQL is not required to run the current skeleton or health endpoint. Future data-backed features will require a configured PostgreSQL database.

## Setup

From this directory, install dependencies and create a local environment file:

```powershell
npm install
Copy-Item .env.example .env
```

Set `DATABASE_URL` only when using a local PostgreSQL instance. Never commit `.env`. `CORS_ORIGINS` is a comma-separated list of exact browser origins; configure the deployed frontend origin before running in production. Production startup fails when that allowlist is empty.

## Run

```powershell
npm run dev
```

The API listens on `HOST` and `PORT` (defaults: `127.0.0.1:3000`). Check `GET /api/health` for a JSON response indicating the process is running. The health endpoint does not test database connectivity.

## Build and start

```powershell
npm run typecheck
npm run build
npm run start
```

## PostgreSQL foundation

`DATABASE_URL` is validated and exposed through the database configuration module for future PostgreSQL integration. No database driver, ORM, migrations, or live connection is included in this initial skeleton. Do not place credentials in source files or `.env.example`.

## Current limitations

- The existing frontend continues to use `localStorage`; no frontend data has been migrated.
- Authentication, users, payments, wallet functionality, tournaments, and KYC are not implemented.
- This skeleton is not production-ready for user data or real-money activity.