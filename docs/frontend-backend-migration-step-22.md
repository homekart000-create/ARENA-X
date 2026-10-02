# Frontend-to-Backend Migration: Step 22

## Status

- Step 22A authentication and shared API client: complete.
- Step 22B tournaments, teams, and matches: complete, subject to the API gaps below.
- Step 22C wallet and transactions: complete, subject to the payment/settlement gaps below.
- Step 22D cleanup and verification: final audit complete.
- No Step 23 work is included.

The frontend continues to use the existing UI and PWA shell. `js/api.js` is the shared request client; it includes cookies, normalizes unsafe/network failures, supports a configurable HTTPS API URL, and uses localhost port 3000 only for local development. No production API host or backend secret is embedded in the frontend.

## Authoritative sources

| Domain | Authoritative source | Frontend behavior |
| --- | --- | --- |
| Authentication/session | `/api/auth/register`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/me` | HTTP-only backend cookie; no local session-token authority. A sanitized legacy profile cache may retain non-authoritative profile/history hints, but not role, status, password, token, or legacy wallet balance. |
| Tournaments and registrations | `/api/tournaments`, `/api/tournaments/:id`, `/api/tournaments/:id/register` | Backend reads and authenticated registration/cancellation; callers do not choose their identity. |
| Teams and invitations | `/api/teams/:id`, team member/invitation routes | Backend reads and mutations; server checks actor permissions and roster constraints. Legacy team IDs in sessionStorage are lookup hints only. |
| Matches and results | `/api/matches`, `/api/matches/:id`, result route, protected room-credentials route | Public match projections omit room secrets; room credentials are fetched only after backend authorization and are not persisted. Result publication is backend-authorized. |
| Wallet | `/api/wallet` | Current authenticated user's backend wallet projection in integer paise. |
| Transactions | `/api/wallet/transactions` | Current user's backend ledger; page currently requests the first 100 entries and applies its existing type filters. |
| Withdrawal requests | `/api/wallet/withdrawal-requests` | Body contains only integer `amountMinor`; ownership comes from the session and request has an idempotency key. A successful request refreshes wallet and transaction data. |

The migrated competition legacy modules remain in the page script lists for compatibility, but exit when `ArenaCompetitionBackend` is installed. They do not supply fallback records to migrated pages. Migrated wallet/admin code does not read `arenaX_wallets` or `arenaX_transactions`.

## Legacy/non-authoritative browser data

- `arena-x-users-v1`: sanitized legacy profile hints for existing UI compatibility only. Passwords, password hashes, session tokens, role/status, demo flags, and legacy `walletBalance` are stripped; backend session identity/role/status remains authoritative.
- `arena-x-session-v1`: removed as a legacy authentication session; backend cookie is authoritative.
- `arenaX_pendingTournament`: temporary post-login navigation intent, not registration state.
- `arenaX_tournaments`, `arenaX_participants`, `arenaX_teams`, `arenaX_teamInvitations`, `arenaX_matches`: retained for compatibility but not read as authoritative on migrated competition pages. Legacy demo modules are guarded there.
- `arenaX_wallets`, `arenaX_transactions`: retained but not read or written by wallet functionality.
- `arenaX_notifications`: remains on its prior local notification path. Step 22 did not add a notification API.
- `arenaX_admin_activity`: remains a local, browser-only activity log; it is not represented as a backend audit ledger.
- Team lookup uses sessionStorage only as a possible team-ID hint; it does not grant membership or authorization.

The historical `docs/backend-architecture.md` describes the pre-migration browser-backed architecture and legacy records. It is background/history, not the authority for migrated page behavior.

The current backend also has no admin user-directory or account-status-management API. The admin page therefore shows those controls as unavailable instead of presenting cached profiles or locally mutating account status.

## Intentional API limitations

- There is no registration/team/invitation discovery API. My Tournaments and team/invitation discovery can show unavailable states when session-local or link-based data is absent.
- No complete leaderboard/standings API is available; the frontend does not invent results or rankings.
- No public atomic tournament-registration plus wallet entry-fee settlement contract is available. Paid tournament registration is disabled; free registration remains available.
- There is no deposit/payment endpoint, gateway, KYC integration, or bank/UPI withdrawal settlement. Add Money is disabled. A withdrawal request reserves backend funds but does not transfer them.
- There is no cross-user admin wallet summary/history or wallet mutation API. Admin wallet totals and transaction history show unavailable rather than using browser data.
- Notifications remain local because no backend notification API is in scope or introduced here.
- The profile dashboard does not substitute legacy local competition history when backend history endpoints are absent.

## Production and verification limits

GitHub Pages has no configured production API host/proxy in this repository. A real HTTPS backend URL and matching cookie/CORS configuration must be supplied at deployment. `DATABASE_URL` was not configured for this final audit; backend unit/contract tests do not establish live PostgreSQL behavior.

Final verification for this audit:

- Frontend auth (14), competition (15), and wallet (9) contract tests passed.
- All 68 backend auth, competition, and wallet tests passed.
- TypeScript typecheck and backend build passed.
- Changed frontend/test JavaScript syntax checks and `git diff --check` passed.
- All 15 HTML pages passed relative JS/CSS reference checks; both manifest icons exist.
- Browser smoke used mocked API responses for login, signup, home, tournaments/detail, teams, matches, wallet, profile, and admin behavior. The regular-user admin redirect and authorized-admin unavailable user-directory/wallet states rendered without browser errors.
- Desktop and mobile layouts were checked with no horizontal overflow on the tested pages. PWA/service-worker registration and manifest assets were checked.
- Browser smoke is not live API or PostgreSQL verification; `DATABASE_URL` was not configured.

No commit or push was performed.
