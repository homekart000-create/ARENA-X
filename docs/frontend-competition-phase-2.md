# Frontend Competition API Migration: Phase 2

The tournament, team, and match stores used by competition pages now read and mutate through `js/api.js` and the Step 20 routes. API responses are normalized in memory for the existing page shapes; successful competition mutations are not written to localStorage. The existing `arenaX_tournaments`, `arenaX_participants`, `arenaX_teams`, `arenaX_teamInvitations`, and `arenaX_matches` keys are not deleted, imported, or used as authoritative data on migrated pages. No legacy demo records are uploaded. A current team ID may be kept in tab-scoped sessionStorage only as a lookup hint; the frontend fetches the team and confirms membership from the backend response before using it.

The standalone notifications page remains on its pre-existing local data path because notification migration is out of scope. Wallet and transaction migration is tracked separately in [frontend-wallet-step-22c.md](frontend-wallet-step-22c.md). CSS, the service worker, and static deployment were not redesigned.

## Current API contract limits

Step 20 has no endpoint to list a user's tournament registrations, teams, or incoming/outgoing team invitations. `My Tournaments` therefore displays an explicit unavailable state after navigation/reload; the frontend only remembers a registration response in memory for immediate confirmation/cancellation. Team lookup by ID works, but finding a user's team requires an existing team-ID hint or a team link. Invitation creation and invitation response call the backend, but there is no invitation-list UI source or username-search endpoint; invitation creation therefore requires the recipient's backend user ID to already be available to the frontend. Captain transfer and self-leave are not supported by the available routes and fail without local mutation.

Public match list/detail APIs provide public match projections, participant counts, and a published result summary. They do not expose participant rosters, room visibility, private room values, or a user's match list. Authenticated admin match projections additionally include the room-visibility boolean so the editor can preserve it; encrypted room values remain available only through the protected room-credentials endpoint and are never stored by the frontend. Admin result entry therefore requires a backend participant/team ID; the backend validates that ID against the match.

There is no leaderboard endpoint, and published match projections do not include stable player/team IDs or a complete standings set. The frontend does not rank local records or infer cross-event standings. The profile dashboard likewise avoids presenting legacy local competition history as backend data.

Admin mutations call the backend routes, which enforce the session role. The browser displays admin functionality only when `/api/auth/me` returns an active user with the admin role; the role and status are not read from localStorage. Direct client calls are still rejected by the backend for non-admin sessions.

## Deployment and tests

The shared `API_BASE_URL` in `js/api.js` remains empty, so relative API requests are suitable only when the API shares the static site's origin/path. GitHub Pages currently has no API proxy or deployed backend URL; authentication and competition requests will report the backend unavailable there until a real HTTPS API is configured. Do not add a localhost or placeholder production URL. See [frontend-auth-phase-1.md](frontend-auth-phase-1.md) for cookie/CORS deployment requirements.

Frontend tests use mocked API responses and verify contracts without a database. They do not prove live PostgreSQL behavior. `DATABASE_URL` remains required for live database integration, and no migration/import of browser data is performed.
