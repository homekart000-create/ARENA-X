# ARENA-X Backend Architecture and Database Design

**Status:** Design only. No backend, database, API, payment integration, or frontend migration is implemented by this document.

## 1. Current Application Data Inventory

The current frontend is a localStorage demo. The following keys and shapes were verified in `js/auth.js`, `js/tournaments.js`, `js/teams.js`, `js/matches.js`, `js/leaderboard.js`, `js/wallet.js`, `js/notifications.js`, and `js/admin.js`.

| Area | Current key / source | Observed shape |
| --- | --- | --- |
| Users | `arena-x-users-v1` | Array of user records with `userId`, `fullName`, `username`, `email`, `phone`, plaintext `password`, `dateOfBirth`, `avatar`, `joinedTournaments[]`, `teamId`, `wins`, `matches`, `kills`, `points`, legacy `walletBalance`, `createdAt`, `isDemo`, `role`, and `status`. Some fields are absent on older records. |
| Login session | `arena-x-session-v1` | One object: `userId`, `rememberMe`, `expiresAt`. It is client-controlled and is not a production session. |
| Auth transient state | `arena-x-notice-v1`, `arena-x-return-v1` | One-time notice object (`message`, `type`) and a sanitized return-page string. These are navigation/UI state, not durable domain records. |
| Tournaments | `arenaX_tournaments` | Array with `id`, `name`, `game`, `type`, `entryFee`, `prizePool`, `maxSlots`, denormalized `joinedSlots`, `startDate`, `startTime`, `registrationDeadline`, `status`, `banner`, `description`, `rules[]`, `map`, `mode`, `host`, `prizeDistribution[]`, `featured`, and `createdAt`. Demo records seed this key when absent. |
| Tournament registrations | `arenaX_participants` | Array with `registrationId`, `userId`, `tournamentId`, copied `username`/`fullName`, `registeredAt`, `status` (`registered`/`cancelled`), `teamId`, `captainId`, `memberIds[]`, and `matchId`. `joinedTournaments[]` is also copied onto user records. |
| Pending tournament | `arenaX_pendingTournament` | A single tournament ID used to resume a join flow. It is not a registration. |
| Teams | `arenaX_teams` | Array with `teamId`, `teamName`, `teamTag`, `logo`, `description`, `ownerId`, embedded `members[]` (`userId`, copied username/full name/avatar, role, joinedAt), `createdAt`, `status`, and denormalized `stats` (`wins`, `matches`, `kills`, `points`). Team size is capped at four. |
| Team invitations | `arenaX_teamInvitations` | Array with `invitationId`, `teamId`, copied `teamName`, `senderId`, `receiverId`, `createdAt`, and uppercase `status` (`PENDING`, `ACCEPTED`, `DECLINED`). |
| Matches | `arenaX_matches` | Array with `matchId`, `tournamentId`, `matchNumber`, title/game/mode/date/start time, status (`upcoming`, `live`, `completed`, `cancelled`), map, `roomId`, `roomPassword`, `roomVisible`, `maxPlayers`, embedded registered player/team ID arrays, optional registration ID array, result status (`pending`, `submitted`, `published`), embedded `results[]`, instructions, home-display fields, and timestamps. Room credentials are omitted from the public match projection, but are still stored in browser storage. |
| Match results | Embedded in `arenaX_matches[].results[]` | Optional `teamId`, `playerId`, `winnerName`, `placement`, `points`, `kills`, and `remarks`. The current demo permits one result row during admin updates. |
| Leaderboard | Derived by `js/leaderboard.js` | No leaderboard localStorage key. Aggregated from completed matches with published results; includes player/team identity, matches played, wins, best placement, kills, placement points, total points, member/tournament names, and rank. |
| Wallets | `arenaX_wallets` | Array with `userId`, `balance`, `totalDeposited`, `totalWithdrawn`, `totalWinnings`, and `updatedAt`. A legacy `walletBalance` may be copied from a user record when creating a wallet. |
| Wallet transactions | `arenaX_transactions` | Array with `id`, `userId`, type (`deposit`, `winning`, `refund`, `adjustment`, `withdrawal`, `entry_fee`), positive `amount`, status (`completed`, `pending`, `failed`), `description`, optional `referenceId`, and `createdAt`. The demo writes wallet and transaction arrays together with rollback attempts, not a database transaction. |
| Notifications | `arenaX_notifications` | Array with `id`, `userId`, `type`, `title`, `message`, optional `relatedId`, `createdAt`, and boolean `read`. `auth.js` and `notifications.js` use this same key. Notifications can be generated from registrations, teams, invitations, and matches. |
| Admin activity | `arenaX_admin_activity` | Array with `id`, `adminUserId`, `action`, `targetType`, `targetId`, `description`, and `timestamp`. This is append-oriented demo data with no durable audit guarantee. |

The key `arenaX_users` named in the requested migration checklist does **not** appear in the current source. The actual key is `arena-x-users-v1`. Migration tooling must inspect both only if historical browser data is supplied; it must not silently assume that `arenaX_users` is the current source.

## 2. Recommended Backend Architecture

### Components

1. **Frontend:** Keep the current GitHub Pages UI as a static client. In a later implementation step, replace domain writes/reads with HTTPS API calls. The browser must never connect directly to PostgreSQL or receive database credentials.
2. **API layer:** Versioned REST API at an HTTPS origin such as `https://api.arenax.gg/api/v1`. Validate request/response schemas, enforce rate limits, normalize errors, and apply CORS only for the production frontend origin and approved development origins.
3. **Backend server:** Node.js with TypeScript and Fastify is a pragmatic first service. Separate auth, user, tournament, team, match, leaderboard, wallet, notification, and admin modules. Keep all authorization and money-changing rules server-side.
4. **Database:** Managed PostgreSQL. The API owns all database access. Use migrations, parameterized queries, least-privilege database roles, backups, and point-in-time recovery appropriate to the chosen provider/plan.
5. **Authentication/session:** Use server-verified passwords and opaque random session tokens in `Secure`, `HttpOnly`, `SameSite=Lax` cookies over HTTPS. Store only a cryptographic hash of each token in the database. Rotate on login/refresh, revoke on logout/password reset, expire idle/absolute sessions, and protect cookie-authenticated writes against CSRF. Never accept a `userId` or role claim from the browser as identity proof.
6. **Authorization:** Authenticate first, derive actor identity from the verified server session, then check resource ownership/membership and current server-side role for every request. Use explicit policies for self, team captain/member, tournament organizer, match participant, and admin actions. Fail closed.
7. **Admin authorization:** Store admin grants in a server-controlled role assignment table. Only an already-authorized admin workflow may grant/revoke admin roles; require recent re-authentication and audit such changes. Do not map the demo `isDemo` flag or client-supplied `role` to a production admin grant.
8. **Validation:** Validate shape, length, enum, date/time, numeric ranges, relationships, state transitions, and capacity at the API boundary. Repeat invariant-critical checks in database constraints and inside the transaction that performs the write. Never trust client-calculated totals, balances, participants, status, winner, or result points.
9. **Audit logging:** Write security-sensitive admin actions and wallet state transitions to append-only records within the same database transaction as the action when possible. Redact passwords, session tokens, room passwords, payment secrets, and unnecessary personal data from logs.

### Deployment boundary

GitHub Pages is a static host and cannot securely hold backend secrets. Deploy the API and database separately. Use TLS, strict CORS, request size limits, security headers, secret management, backups, monitoring, and a defined incident/restore process. Keep development, staging, and production credentials/data isolated.

## 3. Database Conventions

Use PostgreSQL UUID primary keys (`gen_random_uuid()`), UTC `timestamptz`, foreign keys, check constraints, and explicit transactions. Monetary amounts are integer minor units (for INR, paise) with an ISO currency code; do not use JavaScript floating-point values or PostgreSQL floating-point columns for money. Use `jsonb` only for bounded metadata/audit snapshots, not to embed entities that need independent querying or constraints.

`NOT NULL` means required; `NULL` means optional. Every mutable table below has `created_at` and `updated_at` unless specifically marked append-only. Set `updated_at` in the server/database for every accepted update. Use partial indexes for active rows where stated. Application enums may be PostgreSQL enums or checked text; version enum changes through migrations.

## 4. Normalized Database Design

### Identity and authentication

#### `users`
- **PK:** `id UUID`.
- **Required fields:** `username VARCHAR(20)`, `email_normalized CITEXT` (or normalized text with a unique lower-case index), `full_name VARCHAR(120)`, `status TEXT` (`active`, `suspended`, `closed`), `created_at`, `updated_at`.
- **Optional fields:** `phone_e164 VARCHAR(20)`, `date_of_birth DATE`, `avatar_key VARCHAR(200)`, `legacy_id TEXT`.
- **FKs:** None.
- **Unique:** Case-insensitive username; case-insensitive email; `legacy_id` when non-null.
- **Indexes:** Unique indexes above; `(status, created_at)` for moderation/admin lists.
- **Notes:** Do not store `teamId`, joined tournament IDs, wallet balance, admin role, or leaderboard totals on this row. Derive those through relationships. Avoid returning phone/date of birth except to the authorized account owner/admin workflow.

#### `user_credentials`
- **PK/FK:** `user_id UUID` references `users(id)` with `ON DELETE CASCADE`.
- **Required fields:** `password_hash TEXT`, `hash_algorithm TEXT`, `password_changed_at TIMESTAMPTZ`, `created_at`, `updated_at`.
- **Optional fields:** `password_reset_required BOOLEAN NOT NULL DEFAULT false`, `failed_login_count INTEGER NOT NULL DEFAULT 0`, `locked_until TIMESTAMPTZ`.
- **Unique:** One credential row per user by primary key.
- **Indexes:** Optional index on `locked_until` for maintenance.
- **Security:** Store only an Argon2id password hash with per-password salt and current recommended work parameters. Never store plaintext, reversible encryption, or log submitted passwords.

#### `user_role_assignments`
- **PK:** `(user_id UUID, role TEXT)`.
- **Required fields:** `user_id`, `role` (`user`, `admin`, or a separately controlled organizer/support role), `assigned_at TIMESTAMPTZ`, `created_at`.
- **Optional fields:** `assigned_by UUID`, `revoked_at TIMESTAMPTZ` if grants are retained as history.
- **FKs:** `user_id -> users(id)`; `assigned_by -> users(id)`.
- **Unique/indexes:** Unique active `(user_id, role)`; index `(role, revoked_at, user_id)`.
- **Security:** This table is not writable through user/profile endpoints. Admin grant/revocation uses a dedicated audited operation.

#### `auth_sessions`
- **PK:** `id UUID`.
- **Required fields:** `user_id UUID`, `token_hash BYTEA` (or fixed-length hex), `created_at TIMESTAMPTZ`, `expires_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ`.
- **Optional fields:** `last_seen_at TIMESTAMPTZ`, `revoked_at TIMESTAMPTZ`, `user_agent TEXT`, privacy-reviewed `ip_prefix INET`, `rotated_from_session_id UUID`.
- **FKs:** `user_id -> users(id)`; rotated-from session self-reference.
- **Unique/indexes:** Unique `token_hash`; index `(user_id, expires_at)` and partial index on non-revoked sessions.
- **Security:** Cookie contains a random token, never the database row ID or token hash. Revoke sessions after logout, credential reset, account suspension, or suspected theft.

### Tournaments and teams

#### `tournaments`
- **PK:** `id UUID`; optional `legacy_id TEXT` retains the current string ID.
- **Required fields:** `name VARCHAR(120)`, `game VARCHAR(60)`, `format TEXT` (current `Solo`/`Duo`/`Squad`), `mode VARCHAR(100)`, `entry_fee_minor BIGINT`, `prize_pool_minor BIGINT`, `currency CHAR(3)`, `max_slots INTEGER`, `starts_at TIMESTAMPTZ`, `registration_deadline TIMESTAMPTZ`, `status TEXT` (`draft`, `upcoming`, `live`, `completed`, `cancelled`), `created_at`, `updated_at`.
- **Optional fields:** `banner_key VARCHAR(80)`, `description TEXT`, `map VARCHAR(80)`, `host_name VARCHAR(120)`, `featured BOOLEAN NOT NULL DEFAULT false`, `timezone TEXT` (IANA name for display/scheduling), `published_at TIMESTAMPTZ`.
- **FKs:** None.
- **Unique/indexes:** Unique non-null `legacy_id`; index `(status, registration_deadline)`, `(starts_at, status)`, `(game, status, starts_at)`.
- **Checks:** Nonnegative entry/prize, positive capacity, valid deadline/start policy. Do not store `joinedSlots`; derive from eligible registrations.

#### `tournament_rules`
- **PK:** `(tournament_id UUID, position SMALLINT)`.
- **Required fields:** `rule_text TEXT`, `created_at`, `updated_at`.
- **FKs:** `tournament_id -> tournaments(id) ON DELETE CASCADE`.
- **Unique/indexes:** Primary key preserves rule order; index by tournament.

#### `tournament_prize_distributions`
- **PK:** `id UUID`.
- **Required fields:** `tournament_id UUID`, `position SMALLINT`, `place_label VARCHAR(60)`, `share_basis_points INTEGER`, `created_at`, `updated_at`.
- **Optional fields:** `fixed_amount_minor BIGINT` when a guaranteed amount is required.
- **FKs:** `tournament_id -> tournaments(id) ON DELETE CASCADE`.
- **Unique/indexes:** Unique `(tournament_id, position)`; index by tournament. Validate the total distribution in the service/transaction (and with a trigger if it must be a database invariant).

#### `teams`
- **PK:** `id UUID`; optional `legacy_id TEXT`.
- **Required fields:** `team_name VARCHAR(32)`, `team_tag VARCHAR(6)`, `status TEXT` (`active`, `closed`, `suspended`), `created_at`, `updated_at`.
- **Optional fields:** `logo_key VARCHAR(200)`, `description VARCHAR(240)`, `legacy_owner_id TEXT` during migration.
- **FKs:** None in the normalized form; captain is determined by the active `team_members` row with role `captain`.
- **Unique:** Case-insensitive team name and tag; unique non-null `legacy_id`.
- **Indexes:** `(status, created_at)`; unique partial constraint described under members ensures only one active captain.
- **Notes:** Current `stats` are denormalized. Compute them from published results or maintain a rebuildable cache/view; do not trust browser-supplied totals.

#### `team_members`
- **PK:** `id UUID`.
- **Required fields:** `team_id`, `user_id`, `role TEXT` (`captain`, `member`), `joined_at`, `created_at`, `updated_at`.
- **Optional fields:** `left_at TIMESTAMPTZ`.
- **FKs:** `team_id -> teams(id)`, `user_id -> users(id)`.
- **Unique/indexes:** Partial unique `(team_id, user_id) WHERE left_at IS NULL`; partial unique `(user_id) WHERE left_at IS NULL` to allow one active team per user; partial unique `(team_id) WHERE role='captain' AND left_at IS NULL`; index `(user_id, left_at)`.
- **Checks:** Enforce four active members maximum and a captain/member invariant transactionally (a trigger or locked team row is needed because a simple CHECK cannot count sibling rows).

#### `team_invitations`
- **PK:** `id UUID`; optional `legacy_id TEXT`.
- **Required fields:** `team_id UUID`, `sender_user_id UUID`, `receiver_user_id UUID`, `status TEXT` (`pending`, `accepted`, `declined`, `cancelled`, `expired`), `created_at`, `updated_at`.
- **Optional fields:** `responded_at TIMESTAMPTZ`, `expires_at TIMESTAMPTZ`.
- **FKs:** team, sender, and receiver reference their corresponding tables.
- **Unique/indexes:** Partial unique `(team_id, receiver_user_id) WHERE status='pending'`; index `(receiver_user_id, status, created_at DESC)` and `(team_id, status)`.

### Registrations, matches, and results

#### `tournament_registrations`
- **PK:** `id UUID`; optional `legacy_id TEXT`.
- **Required fields:** `tournament_id UUID`, `captain_user_id UUID`, `status TEXT` (`registered`, `cancelled`, `disqualified`), `registered_at TIMESTAMPTZ`, `entry_fee_minor BIGINT` and `currency CHAR(3)` snapshots, `created_at`, `updated_at`.
- **Optional fields:** `team_id UUID` (null for solo), `cancelled_at TIMESTAMPTZ`, `cancel_reason TEXT`.
- **FKs:** `tournament_id -> tournaments(id)`, `captain_user_id -> users(id)`, `team_id -> teams(id)`.
- **Unique/indexes:** Unique non-null `legacy_id`; `UNIQUE (id, tournament_id)` as the target key for registration-member composite FKs; partial unique active registration per `(tournament_id, team_id)` for team entries; partial unique active `(tournament_id, captain_user_id)` for solo entries; indexes `(tournament_id, status, registered_at)`, `(captain_user_id, status)`, `(team_id, status)`.
- **Notes:** Admission checks (deadline, capacity, game format, team membership/size, duplicate participants) happen on the server while locking the tournament capacity row.

#### `registration_members`
- **PK:** `(registration_id UUID, user_id UUID)`.
- **Required fields:** `tournament_id UUID`, `role TEXT` (`captain`, `member`), `joined_at TIMESTAMPTZ`, `created_at`, `updated_at`.
- **Optional fields:** `left_at TIMESTAMPTZ` for retained historical membership.
- **FKs:** `(registration_id, tournament_id) -> tournament_registrations(id, tournament_id)`; `user_id -> users(id)`.
- **Unique/indexes:** Partial unique `(tournament_id, user_id) WHERE left_at IS NULL` prevents a player entering the same tournament twice; index `(user_id, left_at)`.

#### `matches`
- **PK:** `id UUID`; optional `legacy_id TEXT`.
- **Required fields:** `tournament_id UUID`, `match_number INTEGER`, `title VARCHAR(80)`, `game VARCHAR(60)`, `mode VARCHAR(80)`, `starts_at TIMESTAMPTZ`, `status TEXT` (`upcoming`, `live`, `completed`, `cancelled`), `result_status TEXT` (`pending`, `submitted`, `published`, `rejected`), `max_participants INTEGER`, `created_at`, `updated_at`.
- **Optional fields:** `map VARCHAR(80)`, `instructions VARCHAR(1000)`, `home_featured BOOLEAN NOT NULL DEFAULT false`, `home_display JSONB` limited to public display fields, `completed_at TIMESTAMPTZ`.
- **FKs:** `tournament_id -> tournaments(id)`.
- **Unique/indexes:** Unique `(tournament_id, match_number)`; unique non-null `legacy_id`; indexes `(tournament_id, status, starts_at)` and `(status, starts_at)`.
- **Notes:** Do not embed participant arrays or result arrays in this row.

#### `match_participants`
- **PK:** `id UUID`.
- **Required fields:** `match_id UUID`, `registration_id UUID`, `status TEXT` (`eligible`, `withdrawn`, `disqualified`), `created_at`, `updated_at`.
- **Optional fields:** `user_id UUID` for a player participant, `team_id UUID` for a team participant, `joined_at TIMESTAMPTZ`.
- **FKs:** match, registration, user, and team reference their tables.
- **Unique/indexes:** Unique `(match_id, registration_id, user_id)` for player rows and `(match_id, registration_id, team_id)` for team rows; indexes `(match_id, status)`, `(user_id, match_id)`, `(team_id, match_id)`.
- **Checks:** Exactly one of `user_id` or `team_id` is present. Populate from the registration/organizer selection inside a transaction, not from client-provided arbitrary IDs.

#### `match_room_credentials`
- **PK/FK:** `match_id UUID -> matches(id)`.
- **Required fields:** `created_at`, `updated_at`.
- **Optional fields:** `encrypted_room_id BYTEA`, `encrypted_password BYTEA`, `visible_from TIMESTAMPTZ`, `visible_until TIMESTAMPTZ`.
- **Indexes:** `visible_from`; no public listing index is needed.
- **Security:** Encrypt secrets with a managed key service; expose only through a participant/admin-checked endpoint when the match window allows. Never return credentials in public match/list responses or logs.

#### `match_result_submissions`
- **PK:** `id UUID`.
- **Required fields:** `match_id UUID`, `status TEXT` (`submitted`, `under_review`, `published`, `rejected`, `superseded`), `submitted_by_user_id UUID`, `submitted_at TIMESTAMPTZ`, `created_at`, `updated_at`.
- **Optional fields:** `reviewed_by_user_id UUID`, `reviewed_at TIMESTAMPTZ`, `review_note TEXT`, `published_at TIMESTAMPTZ`.
- **FKs:** match and submitter/reviewer users.
- **Unique/indexes:** `UNIQUE (id, match_id)` as the target key for result-entry composite FKs; index `(match_id, status, submitted_at DESC)` and `(submitted_by_user_id, submitted_at DESC)`. A partial unique active published submission per match may be used, while retaining prior submissions.

#### `match_result_entries`
- **PK:** `id UUID`.
- **Required fields:** `submission_id UUID`, `match_id UUID`, `placement INTEGER`, `points INTEGER`, `kills INTEGER`, `created_at`, `updated_at`.
- **Optional fields:** `team_id UUID`, `player_id UUID`, `winner_name_snapshot VARCHAR(120)`, `remarks VARCHAR(500)`.
- **FKs:** `(submission_id, match_id) -> match_result_submissions(id, match_id)`; team/player reference their tables.
- **Unique/indexes:** Unique `(submission_id, team_id)` and `(submission_id, player_id)` for applicable rows; indexes `(match_id, placement)`, `(team_id, match_id)`, `(player_id, match_id)`.
- **Checks:** Nonnegative points/kills/placement; exactly one of team/player is set. The API validates participant membership and scoring policy. Published results are immutable; corrections use a new submission/version and audit event.

#### `leaderboard_entries` (view, not a base table)
- Derive rows only from published result submissions and entries, joined to the relevant tournament format and player/team identity.
- Output: entity type/id/name, tournament scope, matches played, wins, best placement, kills, placement points, total points, and rank. Match current scoring rules on the server. If scale later requires a materialized view, make it rebuildable from source results and never use it as the authoritative result record.

### Wallet and accounting

#### `wallets`
- **PK:** `id UUID`.
- **Required fields:** `user_id UUID`, `currency CHAR(3)` (initially `INR`), `status TEXT` (`active`, `restricted`, `closed`), `available_balance_minor BIGINT NOT NULL DEFAULT 0`, `reserved_balance_minor BIGINT NOT NULL DEFAULT 0`, `version BIGINT NOT NULL DEFAULT 0`, `created_at`, `updated_at`.
- **Optional fields:** `legacy_id TEXT`.
- **FKs:** `user_id -> users(id)`.
- **Unique/indexes:** Unique `user_id` (one wallet per user/currency if only one supported); otherwise unique `(user_id, currency)`; unique non-null `legacy_id`.
- **Notes:** These balances are server-maintained projections for fast reads, not values accepted from clients and not the accounting source of truth.

#### `wallet_transactions`
- **PK:** `id UUID`.
- **Required fields:** `wallet_id UUID`, `user_id UUID`, `type TEXT` (`deposit`, `winning`, `refund`, `adjustment`, `withdrawal`, `entry_fee`), `amount_minor BIGINT` positive, `currency CHAR(3)`, `status TEXT` (`pending`, `succeeded`, `failed`, `reversed`), `idempotency_key VARCHAR(128)`, `request_hash BYTEA`, `created_at`, `updated_at`.
- **Optional fields:** `description VARCHAR(160)`, `reference_id VARCHAR(120)`, `related_transaction_id UUID`, `finalized_at TIMESTAMPTZ`, restricted `metadata JSONB`.
- **FKs:** wallet/user; related transaction self-reference.
- **Unique/indexes:** Unique `(user_id, idempotency_key)`; index `(wallet_id, created_at DESC)`, `(status, created_at)`, `(related_transaction_id)`.
- **Immutability:** Amount, currency, actor, type, idempotency key, and original request facts cannot be edited. Status changes must have append-only events. A reversal is a compensating transaction linked to the original; never erase or rewrite ledger history.

#### `ledger_accounts`
- **PK:** `id UUID`.
- **Required fields:** `account_type TEXT` (`user_available`, `user_reserved`, `platform_clearing`, `tournament_prize_pool`, `fee_revenue`), `currency CHAR(3)`, `created_at`, `updated_at`.
- **Optional fields:** `wallet_id UUID`, `tournament_id UUID`, `status TEXT` (`active`, `closed`).
- **FKs:** Wallet/tournament where applicable.
- **Unique/indexes:** Unique `(wallet_id, account_type, currency)` for wallet subaccounts; index `(account_type, currency)`.
- **Notes:** Platform/clearing accounts are controlled by backend operations, never client-selected account IDs.

#### `wallet_ledger_entries`
- **PK:** `id UUID`.
- **Required fields:** `transaction_id UUID`, `account_id UUID`, `amount_minor BIGINT` signed, `currency CHAR(3)`, `created_at`.
- **Optional fields:** `entry_kind TEXT`, `reverses_entry_id UUID`.
- **FKs:** transaction, account, and optional self-reference.
- **Unique/indexes:** `(transaction_id, account_id, entry_kind)` unique; `(account_id, created_at)` and `(transaction_id)` indexed.
- **Rules:** Entries are append-only. Every finalized transaction is balanced per currency (sum is zero across affected accounts), enforced by a deferred constraint/transaction-level validation. A reversal posts opposite entries; it never edits the original entry.

#### `wallet_transaction_events`
- **PK:** `id UUID`.
- **Required fields:** `transaction_id UUID`, `event_type TEXT`, `to_status TEXT`, `occurred_at TIMESTAMPTZ`, `created_at`.
- **Optional fields:** `from_status TEXT`, `actor_user_id UUID`, `reason TEXT`, `request_id UUID`, redacted `metadata JSONB`.
- **FKs:** transaction and optional actor.
- **Indexes:** `(transaction_id, occurred_at)`, `(event_type, occurred_at)`.
- **Immutability:** Append-only transition and operational history; no update/delete API.

### Notifications and administration

#### `notifications`
- **PK:** `id UUID`; optional `legacy_id TEXT`.
- **Required fields:** `user_id UUID`, `type VARCHAR(60)`, `title VARCHAR(160)`, `message TEXT`, `created_at TIMESTAMPTZ`.
- **Optional fields:** `related_entity_type VARCHAR(40)`, `related_entity_id UUID`, `read_at TIMESTAMPTZ`, `dedupe_key VARCHAR(180)`.
- **FKs:** `user_id -> users(id)`; related entity is polymorphic and validated by the service.
- **Unique/indexes:** Unique `(user_id, dedupe_key)` when dedupe key is non-null; index `(user_id, read_at, created_at DESC)`.
- **Notes:** `read_at IS NULL` means unread. Only the owning user or an authorized server process may mark it read.

#### `admin_activity_logs`
- **PK:** `id UUID`.
- **Required fields:** `admin_user_id UUID`, `action VARCHAR(80)`, `target_type VARCHAR(40)`, `description VARCHAR(500)`, `occurred_at TIMESTAMPTZ`, `created_at`.
- **Optional fields:** `target_id UUID`, `request_id UUID`, `before_snapshot JSONB`, `after_snapshot JSONB`, privacy-reviewed `ip_prefix INET`.
- **FKs:** `admin_user_id -> users(id)`; `target_id` is polymorphic and has no single FK.
- **Indexes:** `(admin_user_id, occurred_at DESC)`, `(target_type, target_id, occurred_at DESC)`, `(action, occurred_at DESC)`, `(request_id)`.
- **Immutability:** Insert-only for API actors. Restrict read to admin audit policy; redact credentials, room secrets, and unnecessary personal information.

## 5. Relationship Summary

- **User -> teams:** Many-to-many through `team_members`; at most one active team per user. Captain is an active membership role.
- **User -> tournaments:** Many-to-many through `tournament_registrations` and `registration_members`; a user may be a captain or roster member.
- **Tournament -> registrations:** One-to-many; registrations snapshot entry fee/currency and status.
- **Tournament -> matches:** One-to-many; `(tournament_id, match_number)` is unique.
- **Team -> members:** One-to-many active/history rows in `team_members`; enforce one captain and four active members.
- **Team -> invitations:** One-to-many; sender and receiver are both user FKs.
- **Match -> participants:** One-to-many through `match_participants`, linked to a registration and either user or team.
- **Match -> results:** One-to-many submissions; each submission has participant result entries. Leaderboard derives from published entries.
- **User -> wallet:** One-to-one (or one per currency) through `wallets`.
- **Wallet -> transactions -> ledger entries:** Wallet has many transactions; each transaction posts balanced immutable entries to ledger accounts.
- **User -> notifications:** One-to-many; per-user read state.
- **Admin -> audit activity:** One admin user has many append-only `admin_activity_logs` rows.

## 6. Security Design

- **Client-side privilege escalation/admin spoofing:** Ignore client-supplied `role`, `isDemo`, `admin`, `ownerId`, and status fields. Derive actor and grants from the server session and database. Require a current role check on every admin request; do not rely on hidden buttons, PWA code, or frontend route guards.
- **User ID spoofing:** For `/me` and wallet self-service, derive user ID from the authenticated session. Where an endpoint accepts a target ID, authorize the relationship to that exact resource and return only permitted fields.
- **Team modification:** Lock/read the team and membership in the write transaction. Enforce captain-only changes, invitation receiver-only acceptance, single-team membership, max size, and transfer/leave invariants server-side. Use optimistic version checks or row locks for competing updates.
- **Tournament registration:** Revalidate status, format, deadline, capacity, roster membership, duplicate player/team entry, fee snapshot, and eligibility in one transaction. Lock the tournament row or use a capacity-safe atomic update so two requests cannot take the last slot.
- **Match results and room credentials:** Restrict result submission/review/publish transitions by role and match policy. Preserve submitted versions. Verify participant/result IDs belong to the match. Never return room credentials in public DTOs; reveal only to an authenticated eligible participant or authorized admin during the configured window.
- **Wallet balance/transaction tampering:** Never accept a balance, balance delta, transaction status, type, user ID, or ledger account from the browser as authoritative. API calculates all effects from trusted state and approved business rules. Restrict adjustments to a separately authorized, reasoned, audited admin workflow.
- **Duplicate/replay/double spending:** Require a high-entropy idempotency key for every financial command; store it with actor, request hash, and result under a unique constraint. Replays with identical payload return the stored outcome; same key with different payload returns conflict. Use row locks/version checks, unique ledger references, and serializable or appropriately locked transactions for balance-changing operations. Enforce no-negative-available-balance in the same transaction as ledger posting.
- **Password exposure:** Hash with Argon2id on the backend. Use generic login errors, rate limits, progressive delays, reset tokens that are random, short-lived, single-use and stored hashed, and redact secrets from logs. Never migrate the demo plaintext `password` field as a valid production credential; require reset/re-enrollment or a controlled secure migration that hashes before persistence.
- **Session theft/CSRF:** TLS only; `Secure`, `HttpOnly`, `SameSite` cookie; short idle and bounded absolute lifetime; rotate/revoke sessions; never put session tokens in localStorage or URLs. Add CSRF tokens/origin checks for cookie-authenticated writes and strict CORS. Avoid logging raw IPs unless justified and retention-controlled.
- **Validation/injection:** Schema-validate all inputs; use parameterized SQL; escape output; set request/body limits; rate limit login, invitations, registration, and sensitive mutations; verify state transitions and ownership against current database rows.
- **Audit:** Record actor, action, target, timestamp, request/correlation ID, outcome, and redacted before/after snapshots for privileged changes. Make records append-only and protect audit reads/retention from ordinary users and application roles.

## 7. Wallet Ledger and Atomicity

The wallet is server-authoritative. The displayed balance is a projection of server-owned ledger entries, not a client value. For each request:

1. Begin a database transaction; claim `(user_id, idempotency_key)` and compare the stored request hash on a replay.
2. Lock the wallet/account row (`SELECT ... FOR UPDATE`) or use a version-checked atomic update. Check wallet state, amount/currency, available funds, limits, and operation-specific authorization.
3. Insert the immutable transaction facts and initial transaction event.
4. For a pending withdrawal, move funds from available to reserved/hold accounts; do not treat pending as a completed external payout. For success/failure, append the appropriate transition event and ledger postings. A failure releases a hold; a reversal is a new compensating transaction.
5. Insert balanced ledger entries and update the cached wallet projection/version in the same transaction. Validate no negative available balance and per-currency ledger balance before commit.
6. Commit, then return the persisted transaction and authoritative wallet projection. On any failure, roll back the complete operation. Never call an external payment service inside a long-held database transaction; future provider calls need an outbox/state-machine design with idempotent callbacks.

No payment gateway, deposit collection, withdrawal execution, or real-money flow is included in this design step.

## 8. Proposed REST API Plan

All routes are proposed under `/api/v1`. Responses omit password hashes, session tokens, internal role data not needed by the caller, wallet secrets, and room credentials unless the route explicitly authorizes them. Write routes require server validation and authorization even if the frontend already checks.

| Method and endpoint | Authentication | Authorization | Purpose / response |
| --- | --- | --- | --- |
| `POST /auth/register` | Public | Rate-limited; server validates unique username/email | Create user and credential; return safe profile and session cookie. |
| `POST /auth/login` | Public | Rate-limited; server verifies password/status | Create/rotate session cookie; return safe profile. |
| `POST /auth/logout` | Session | Revoke current session; clear cookie | No sensitive payload. |
| `POST /auth/session/refresh` | Session | Rotate valid session only | Set rotated cookie; revoke prior token. |
| `GET /auth/me` | Session | Current user only | Safe current profile and minimal capabilities. |
| `GET /users/:userId` | Optional/session per privacy policy | Public profile fields only; owner/admin for private fields | Return sanitized profile. |
| `PATCH /users/me` | Session | Current user; field allowlist | Update editable profile fields; never role/status/balance. |
| `GET /tournaments` | Public | Published records only | Paginated/filterable list with derived availability. |
| `GET /tournaments/:tournamentId` | Public | Published tournament | Detail, rules, prize distribution, public match summary. |
| `POST /tournaments` | Session | Admin/authorized organizer | Create validated draft; return saved tournament. |
| `PATCH /tournaments/:tournamentId` | Session | Admin/organizer for that event | Update permitted fields/state transition; return updated event. |
| `POST /tournaments/:tournamentId/registrations` | Session | Self; team captain and eligible roster | Atomically validate capacity/eligibility and create registration; return registration status. |
| `GET /users/me/registrations` | Session | Current user | List own active/history registrations. |
| `DELETE /registrations/:registrationId` | Session | Registration owner/captain and cancellation policy | Cancel if allowed; return final state. |
| `GET /teams` | Optional/session | Public fields; private membership data scoped | Search/list teams with safe roster summary. |
| `POST /teams` | Session | Current user; not already in an active team | Create team and captain membership atomically. |
| `GET /teams/:teamId` | Optional/session | Public data; private invitation/member data scoped | Return team details and permitted roster. |
| `PATCH /teams/:teamId` | Session | Active team captain | Update name/tag/description/logo; return team. |
| `POST /teams/:teamId/invitations` | Session | Active captain | Invite eligible user; return pending invitation. |
| `POST /team-invitations/:invitationId/accept` | Session | Invitation receiver only | Accept atomically if team capacity and membership still valid. |
| `POST /team-invitations/:invitationId/decline` | Session | Invitation receiver only | Decline pending invitation. |
| `DELETE /teams/:teamId/members/:userId` | Session | Captain, with captain-transfer invariant | Remove member; return roster. |
| `POST /teams/:teamId/captain-transfer` | Session | Current captain; new captain is active member | Transfer captain role atomically. |
| `GET /matches` | Public | Public projection only | Paginated match list; never includes room credentials. |
| `GET /matches/:matchId` | Public/session | Public projection; participant-specific extras separately checked | Match detail and published result only. |
| `POST /matches` | Session | Admin/organizer | Create match for a valid tournament. |
| `PATCH /matches/:matchId` | Session | Admin/organizer | Change schedule/status/eligible registration selection; audited. |
| `GET /matches/:matchId/room-credentials` | Session | Authorized admin or eligible registered participant, within visibility window | Return credentials only after fresh resource authorization. |
| `POST /matches/:matchId/result-submissions` | Session | Authorized organizer/result operator | Submit a validated version with participant-bound rows. |
| `POST /result-submissions/:submissionId/publish` | Session | Reviewer/admin policy; optionally separate reviewer | Publish version and emit leaderboard/notification events. |
| `GET /leaderboard` | Public | Published results only | Paginated/filterable derived standings and scoring metadata. |
| `GET /wallet/me` | Session | Current user | Server-calculated wallet projection; no client balance input. |
| `GET /wallet/me/transactions` | Session | Current user | Paginated own transactions/events. |
| `POST /wallet/me/withdrawal-requests` | Session | Current user; policy/available-funds checks | Create an idempotent pending request/hold only; no payout integration in this phase. |
| `GET /notifications` | Session | Current user only | Paginated own notifications and unread count. |
| `PATCH /notifications/:notificationId/read` | Session | Notification owner only | Mark one notification read. |
| `POST /notifications/read-all` | Session | Current user only | Mark caller's notifications read. |
| `GET /admin/users` | Session | Admin role | Paginated moderation-safe user view. |
| `PATCH /admin/users/:userId/status` | Session | Admin role; cannot self-lock out without policy | Suspend/reactivate with audit record. |
| `GET /admin/activity` | Session | Admin role | Filtered, redacted audit log. |
| `GET /admin/wallet-transactions` | Session | Explicit finance/admin permission | Read-only transaction review; no arbitrary balance edit endpoint. |

Use cursor pagination for changing feeds, stable sorting, request IDs, structured error codes, and optimistic concurrency (`ETag`/version) where edits can race. Define OpenAPI before implementing clients.

## 9. localStorage Migration Plan

Migration is a later, explicit opt-in process; this document does not read, delete, or change browser storage.

| Current key/data | Backend destination and migration notes |
| --- | --- |
| `arena-x-users-v1` (requested checklist also names `arenaX_users`, which is absent in current code) | Map IDs through `legacy_id`; normalize username/email and split credentials into `user_credentials`. Do not import a browser-provided admin role. Because current passwords are plaintext, never upload them to logs or retain them; require secure password reset/re-enrollment or a reviewed one-time process that hashes in transit on the server. Treat demo account separately and do not seed it as production admin. |
| `arena-x-session-v1` | Do not migrate client sessions. Re-authenticate users and issue server sessions. `arena-x-notice-v1` and `arena-x-return-v1` are transient UI state and normally remain browser-only or are discarded after migration. |
| `arenaX_tournaments` | Upsert tournaments by validated legacy ID; map rules and prize distribution arrays to child tables; convert entry/prize amounts to minor units and local date/time strings to explicit UTC plus IANA timezone. Recalculate slot counts from registrations. |
| `arenaX_participants` | Map to registrations and `registration_members`; resolve team/user IDs, deduplicate copied username/full-name snapshots, preserve status/timestamps and legacy IDs. Reconcile `users.joinedTournaments` against registrations; registrations are authoritative. `arenaX_pendingTournament` is a transient navigation intent, not an enrollment. |
| `arenaX_teams` | Upsert teams; move embedded members to `team_members`; resolve owner to active captain membership. Recompute team stats from published results. |
| `arenaX_teamInvitations` | Map invitation IDs/team/sender/receiver/status/timestamps; normalize status to lowercase; validate users and teams exist. |
| `arenaX_matches` | Map match fields to `matches`; split room credentials into protected encrypted storage; turn registered arrays into `match_participants` based on valid registrations; split `results[]` into result submissions/entries. Reconcile legacy statuses before import and keep prior versions for auditing where practical. |
| Leaderboard | No current key to import. Rebuild from published result entries; compare against the frontend-derived leaderboard as a migration validation. |
| `arenaX_wallets` and user `walletBalance` | Never accept as authoritative without reconciliation. Import into a quarantined opening-balance/adjustment process only after ownership, currency, and transaction history are reviewed. Do not sum legacy wallet and user balances blindly. |
| `arenaX_transactions` | Map types/statuses/reference/amount; convert INR amounts to integer paise with explicit rounding review. Preserve legacy IDs; mark provenance as demo/imported. Do not represent demo records as verified external payments. |
| `arenaX_notifications` | Map user, message/type, related entity and read state; validate related references; deduplicate via a stable legacy ID/dedupe key. |
| `arenaX_admin_activity` | Map actor/action/target/description/timestamp to immutable audit rows; preserve provenance as client-generated demo history and do not treat it as tamper-proof evidence. |

Recommended migration sequence: inventory/export read-only; validate and report rejects; dry-run ID/reference mapping; reconcile wallet totals separately; require approval; import idempotently with a migration batch ID; verify row counts, foreign keys, active registrations, and ledger balances; switch API reads/writes behind a feature flag; retain the static demo as a separate environment until cutover is approved. Never delete localStorage as part of an unreviewed first login.

## 10. Database Technology Recommendation

| Option | Strengths | Tradeoffs for ARENA-X |
| --- | --- | --- |
| Managed PostgreSQL (Supabase or Neon) | Low-cost/free development tiers, SQL relationships, unique/FK/check constraints, ACID transactions, backups/managed operations, good local tooling and VS Code ecosystem. | Free-tier limits and provider-specific operational details; production backup/restore, connection pooling, region, support, and compliance need explicit review. |
| Firebase/Firestore | Fast setup, generous development experience, hosted auth/realtime primitives. | Document model makes relational team/registration/result constraints and multi-row wallet ledger transactions less natural; security rules and transaction limits require careful design. |
| Self-hosted PostgreSQL | Maximum operational control and portable SQL. | Requires patching, monitoring, backups, TLS, failover, secret management, and incident response; not the simplest first production deployment. |

**Recommendation:** TypeScript/Fastify API plus managed PostgreSQL (start by evaluating Supabase Postgres or Neon for development; keep all privileged reads/writes behind the API). PostgreSQL is the strongest fit for ARENA-X's relational membership, registration-capacity races, audit records, and atomic wallet ledger. Select a production provider only after checking backup/restore, pooling, region/data residency, access controls, and contractual/compliance needs. Do not install, configure, or connect a provider in this design step.

## 11. Development Phases

- **Step 18 - Backend project setup:** Create one backend service, TypeScript/Fastify baseline, environment configuration, health checks, database migrations, local development profile, API versioning, logging, and CI checks. Keep the current GitHub Pages demo working.
- **Step 19 - Authentication/API:** Implement registration/login/logout/session rotation, Argon2id password storage, cookies/CSRF, rate limits, profile APIs, and role/ownership middleware.
- **Step 20 - Tournament/team/match APIs:** Add normalized entities, validation, capacity-safe registrations, membership/invitations, match participants, protected room credentials, result submission/review/publish, and derived leaderboard.
- **Step 21 - Wallet/transaction backend:** Implement ledger tables, idempotency, balanced postings, atomic balance projections, pending holds, reversal flows, audit events, reconciliation jobs, and read-only admin views. No gateway until later.
- **Step 22 - Frontend localStorage migration:** Add an API adapter and staged migration/cutover for each domain. Retain a deliberate demo mode and feature-flag rollback; do not silently mix local and server authorities.
- **Step 23 - Production security:** Threat model and review, penetration testing, secrets/key rotation, backup/restore drills, monitoring/alerts, abuse controls, privacy/retention policy, and incident response.
- **Step 24 - Payment/KYC/compliance:** Only after legal/business approval, provider selection, jurisdiction/age review, KYC/AML and gaming/contest requirements, tax/refund/chargeback policies, and payment-provider security review. Implement provider webhooks idempotently; never handle raw card data directly.
- **Step 25 - Production QA:** Load/concurrency tests (including last-slot registration and duplicate wallet replay), reconciliation, migration rehearsal, accessibility, security tests, rollback and disaster-recovery exercises, and staged release.
- **Step 26 - Android APK/AAB:** Choose a supported packaging approach after the production API is stable; validate signing, secure deep links, session handling, privacy disclosures, and device-specific QA.
- **Step 27 - Play Store preparation:** Prepare listing/assets, content rating, privacy policy/data safety declarations, support contact, testing tracks, compliance evidence, and release/rollback plan.

## 12. Safety and Production Readiness

The current ARENA-X frontend remains a **localStorage demo**. Browser storage, client-side validation, frontend route guards, the static demo admin account, and client-created wallet transactions are not production security boundaries. The current demo stores passwords in plaintext in browser storage and can be edited by the user. Do not use it for real-money balances, deposits, withdrawals, paid entries, prizes, or production identity data.

ARENA-X is **not production-secure for real-money use** until a trusted backend enforces authentication and authorization, passwords are securely hashed, sessions are protected, a transactional database and auditable ledger are operational, payments and reconciliation are controlled, room secrets are protected, and applicable legal, gaming, privacy, tax, KYC/AML, and payment-provider requirements have been assessed and met. No payment gateway or backend functionality is implemented by this document.
