# Payments, Wallet, KYC and Payouts — Steps 24A–24D

## Current status

- **IMPLEMENTED (24A):** provider-neutral payment contracts, integer-paise payment records, database persistence, idempotency, webhook-event storage, authenticated API boundaries, and an explicit state machine.
- **IMPLEMENTED (24B):** isolated Razorpay sandbox adapter, safe order creation, owner-scoped payment verification, raw-body webhook signature verification, provider-side payment fact checks, and replay/conflict handling.
- **IMPLEMENTED (24C):** verified payment settlement into the immutable wallet ledger, atomic paid tournament entry-fee debit and registration, idempotent paid-registration retries, and a transactional cancellation refund path for the original payer.
- **IMPLEMENTED (24D):** KYC submission/admin review with database audit records, production KYC withdrawal gate and configurable amount bounds, withdrawal workflow/admin APIs, payout abstraction with an unavailable runtime adapter, idempotent payout attempts, reconciliation, HMAC webhook verification, and wallet-ledger settlement/release paths.
- **TESTED:** Step 24D KYC/payout tests exercise route authorization, ownership, transitions, replay/conflict handling, ambiguous results, and hold/settlement/release effects. The full regression and tooling results are recorded below.
- **NOT VERIFIED:** PostgreSQL is not configured in this environment, so migrations 006–007 and Postgres transaction/locking behavior have not been exercised against a live database. The configured runtime payout adapter is unavailable; no live payout was attempted.
- **DEFERRED:** frontend payment/withdrawal UI, live payout-provider integration, bank/UPI destination handling, tournament prize distribution, and later Step 24 phases.

Real-money charging remains disabled. The Razorpay adapter accepts only sandbox configuration with a test key ID. No production payment credentials are included. Paid tournament registration is enabled against the existing wallet ledger; it does not charge an external payment method.

Step 24D does not claim legal or regulatory compliance. KYC scope, provider selection, destination-account handling, retention, tax, AML, gaming, RBI, payment-provider, and jurisdiction-specific requirements still need external legal/provider verification before production use.

## Architecture and trust boundaries

The provider-neutral interface in `backend/src/payments/contracts.ts` normalizes order creation, checkout-signature verification, provider payment retrieval, and webhook verification. Provider-specific HTTP/HMAC behavior stays within the Razorpay adapter. User identity comes from the authenticated session; clients cannot choose the user, payment status, wallet credit amount, or provider verification result.

The payment repository locks the internal payment row, validates trusted provider facts, and posts a balanced wallet ledger credit through the same PostgreSQL client and transaction. It records the ledger wallet/transaction mapping and moves the payment to `settled` before commit. Any failure rolls back both the payment transition and ledger operation. The payment record never directly overwrites the wallet balance projection.

Tournament registration similarly locks the tournament, validates capacity and the mode-specific roster, debits the exact server-stored fee from the authenticated caller, and inserts the registration and its ledger references in the same transaction. Solo requires one authenticated player, Duo requires two team members, and Squad requires four; standalone teams are not universally capped at four. Free registration does not write to the wallet ledger.

## API endpoints

- `POST /api/payments/orders`: authenticated and exact-Origin checked; requires an idempotency key and an integer amount from 1 through 100,000,000 paise. User identity comes from the session and currency is fixed to INR. With sandbox credentials, creates or replays one internal payment and returns safe checkout/order data. Disabled/unavailable provider configuration fails safely; no payment success is fabricated.
- `GET /api/payments/:id`: authenticated and owner-scoped; returns a safe payment summary.
- `POST /api/payments/:id/verify`: authenticated, owner-scoped, and exact-Origin checked. The server verifies checkout signature, fetches authoritative Razorpay facts, and requires matching order ID, payment ID, amount, INR currency, and captured status. The successful response reports settlement as credited only after the ledger transaction commits.
- `POST /api/payments/webhooks/razorpay`: provider-signature authenticated, not session authenticated. It verifies HMAC-SHA256 over the exact raw request bytes, validates event fields, obtains authoritative provider payment details for successful capture events, and commits the event, payment settlement, and ledger credit atomically.
- Existing tournament registration and cancellation endpoints perform paid-entry debit/refund processing only on the backend. Registration identity is derived from the session; request fields cannot specify a payer or fee.

The API does not expose provider or webhook secrets, raw provider error bodies, internal database details, idempotency keys, or reconciliation metadata.

## Provider and sandbox configuration

`backend/.env.example` contains blank placeholders:

```dotenv
RAZORPAY_MODE=disabled
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
```

`RAZORPAY_MODE` accepts only `disabled` or `sandbox`. Sandbox mode requires all three values and a test key ID beginning `rzp_test_`; a non-test key ID is rejected. Missing configuration disables provider calls. Secrets must be supplied through a deployment secret manager, never committed.

The adapter uses HTTPS to the fixed Razorpay API host, Basic authentication, redirect rejection, a request timeout, bounded response size, and safe errors. No provider SDK or additional dependency was needed.

## Database model and migration

- `backend/migrations/004_create_payments.cjs` creates payment records and normalized provider webhook events. It enforces integer-paise/INR amounts, per-user idempotency keys, unique provider references, owner/currency-constrained wallet transaction mapping, event uniqueness, and legal status transitions.
- `backend/migrations/005_atomic_wallet_settlement.cjs` adds the `settled` state and its required wallet-ledger mapping, updates the status transition constraint, and adds paid-registration payer, wallet, entry-fee transaction, and refund transaction references with foreign keys, uniqueness, and amount/refund checks.
- The payment-to-wallet reference is an audit link, not an alternate source of balance. Wallet changes are written only through the existing immutable, balanced ledger transaction.
- The migration is additive, but has **NOT VERIFIED** status against a live database; no migration was applied during this phase.

## Payment state machine

Application logic and database constraints enforce:

| Current state | Allowed next states |
| --- | --- |
| `created` | `pending`, `failed`, `cancelled` |
| `pending` | `paid`, `failed`, `cancelled` |
| `paid` | `settled` |
| `settled` | `refunded` |
| `failed`, `cancelled`, `refunded` | none |

`paid` represents provider verification within the settlement transaction; it is not spendable wallet value. `settled` is persisted together with the associated wallet transaction after successful ledger posting. In normal operation the intermediate `paid` state is not externally visible before commit. Only trusted server-side verification or a validated capture webhook can initiate this transition; there is no client status mutation endpoint.

Provider order creation failure is recorded as terminal `failed` to avoid blind retries of an uncertain external order. A new attempt requires a new idempotency key.

## Idempotency and replay protection

- Payment order creation uses a unique `(user_id, idempotency_key)` and server-generated request hash. Identical requests reuse the payment/order; changed requests conflict.
- Payment verification and successful webhook processing lock the payment row. The wallet credit uses deterministic `payment-credit:<payment-id>` idempotency and is committed with the payment mapping/state transition. Repeated verification cannot create another ledger credit.
- Webhooks require a valid HMAC over raw bytes. `(provider, provider_event_id)` is unique. Exact duplicates are harmless; reusing an event ID with different payload digest conflicts. Capture events are checked against internal order, payment ID, amount, currency, and captured status.
- Tournament registration locks the tournament while checking capacity and writing the exact fee debit and registration. An existing matching registration is returned on retry without another debit. Changed team/roster shape is rejected.
- Paid cancellation credits the original payer using a deterministic registration refund key and relates the refund to the original fee transaction. The refund ledger row and cancelled registration/refund reference are committed together. Repeating cancellation after commit does not refund again.
- Provider/network failure can still leave an externally created order whose response was lost before durable association. The internal UUID is sent as provider receipt/reference. Production requires provider-side idempotency guarantees and operational reconciliation.

## Step 24D — KYC, withdrawals and payout foundation

### KYC data and status control

KYC stores a minimum profile (legal name, optional date of birth/country, provider reference metadata) and does not accept document contents. The user endpoints derive ownership exclusively from the authenticated session:

- `GET /api/kyc` reports the caller's own profile or a synthetic `unverified` state.
- `POST /api/kyc` and `PATCH /api/kyc` submit/update only profile fields. Client-supplied status, reviewer, verification decision, and provider reference are rejected.
- `GET /api/admin/kyc`, `GET /api/admin/kyc/:userId`, and `GET /api/admin/kyc/:userId/audit` require an authenticated admin role. List responses omit legal name/date of birth/provider reference; detail and audit are no-store.
- `POST /api/admin/kyc/:userId/review` is admin-only, exact-Origin checked, rate-limited, and requires a reason for rejection. Reviewer ID/time and action/reason are persisted transactionally with an append-only audit event.

The application and migration enforce:

| Current state | Allowed next states |
| --- | --- |
| `unverified` | `pending` |
| `pending` | `verified`, `rejected` |
| `verified` | `suspended` |
| `rejected` | `pending` |
| `suspended` | `verified`, `pending` |

Users cannot approve themselves or edit a verified/suspended record. Rejected users may submit a new application; this returns the state to `pending`. `unverified` is represented without requiring an empty database row.

### Withdrawal eligibility and wallet behavior

`POST /api/wallet/withdrawal-requests` remains authenticated, exact-Origin checked, and idempotent. The backend validates integer paise, configured inclusive minimum/maximum, current session/account status, active wallet status, available balance, and (when enabled) a persisted `verified` KYC status. Production defaults to KYC-required and refuses `WITHDRAWAL_KYC_REQUIRED=false`. Replays of the same idempotency key/payload return the existing request; changed payloads conflict. Only one pending/approved/processing withdrawal per wallet may be open.

The initial withdrawal keeps the existing wallet-ledger hold behavior: available decreases and reserved increases in one transaction; a balanced `hold` posting is appended. A paid payout appends balanced reserved-to-clearing `settlement` entries and reduces reserved projection. A provider-confirmed failed payout, admin rejection, or owner cancellation appends `release` entries and returns reserved value to available. A retry after confirmed failure creates a new internal wallet transaction and hold; it checks current available balance. No wallet balance is overwritten or changed outside the existing transactional ledger path.

Owner-only routes expose the caller's withdrawal list/detail and permit cancellation only while pending or approved. Detail lookup is owner-filtered and returns 404 for another user's ID.

### Withdrawal workflow and admin endpoints

`GET /api/admin/withdrawals`, `GET /api/admin/withdrawals/:withdrawalRequestId`, and the following mutations require admin authorization:

- `POST .../:withdrawalRequestId/approve` — pending to approved.
- `POST .../:withdrawalRequestId/reject` — pending to rejected, requires reason, releases the hold.
- `POST .../:withdrawalRequestId/retry` — starts an approved payout, or retries a definitively failed attempt with a new hold/attempt number.
- `POST .../:withdrawalRequestId/reconcile` — queries an in-flight provider attempt; it never creates another payout.

All mutations require exact allowed Origin, are rate-limited, and write append-only workflow audit events with the actor, action, state, and relevant reason. The database and service enforce:

| Current state | Allowed next states |
| --- | --- |
| `pending` | `approved`, `rejected`, `cancelled` |
| `approved` | `processing`, `rejected`, `cancelled` |
| `processing` | `paid`, `failed` |
| `failed` | `processing` (explicit retry only; fresh hold and payout attempt) |
| `paid`, `rejected`, `cancelled` | none |

An owner can cancel a pending/approved withdrawal. A processing payout cannot be cancelled until provider outcome is resolved. Failed is retryable only through the admin retry action; each attempt has its own persisted idempotency key. Paid/rejected/cancelled are terminal.

### Payout abstraction, ambiguity and webhooks

The provider-neutral `PayoutProvider` contract defines create, status lookup, reconciliation, and signed webhook verification. `HmacPayoutProvider` accepts provider-specific callback implementations and verifies HMAC-SHA256 over exact raw bytes with timing-safe comparison. No provider API or provider behavior is invented here. Server startup always uses `UnavailablePayoutProvider`; no payout credentials or live adapter are configured. Admin approve/review can proceed, but payout retry/reconciliation/webhook operations return an explicit unavailable response rather than success.

Before any external create call, a stable attempt row is committed using the internal withdrawal ID, attempt number, and provider idempotency key. Repeated admin calls cannot create another attempt while processing. If create/reconcile throws or its result is ambiguous, the attempt is marked `unknown`, the withdrawal remains `processing`, funds remain reserved, and only reconciliation may continue it. A new payout call is permitted only after a definitive failure, with a new attempt key. Provider references are unique per provider. Terminal success/failure requires provider amount/currency to match the internal INR request; mismatches remain in reconciliation. This is safe only when a future provider honors the supplied idempotency key and offers authoritative status lookup.

`POST /api/payouts/webhooks/:provider` accepts raw JSON only, checks the configured provider adapter's HMAC, persists an event digest under unique `(provider, provider_event_id)`, and processes it idempotently. Same-ID/same-digest replay is harmless; same ID/different digest conflicts. An out-of-order event for a superseded/terminal attempt is recorded but cannot alter the current withdrawal. Terminal events with mismatched amount/currency are recorded for reconciliation without releasing or settling the hold. The endpoint is not usable with the current unavailable runtime adapter.

### Configuration, limits and deployment state

`backend/.env.example` documents `WITHDRAWAL_KYC_REQUIRED`, `MINIMUM_WITHDRAWAL_MINOR`, `MAXIMUM_WITHDRAWAL_MINOR`, and `PAYOUT_MODE=disabled`. Amount limits are integer paise; the maximum cannot exceed the existing 100,000,000-paise wallet cap. Production forces KYC on; malformed limits, booleans, and non-disabled payout modes fail startup. There is no payout webhook secret in the example because no runtime payout adapter/webhook secret is configured.

Rate limits use the existing process-local Fastify limiter: KYC submit/update 3 per 15 minutes; withdrawal create and owner cancel 5 per 15 minutes; KYC review and approve/reject 10 per 15 minutes; payout retry 5 per 15 minutes; payout reconcile 10 per 15 minutes; payout webhook ingress 120 per minute. Multi-instance deployments need a shared limiter store before relying on aggregate limits.

Migration `006_create_kyc_tables.cjs` adds KYC profiles and decisions. Migration `007_withdrawal_payout_workflows.cjs` adds KYC transition/audit protections, backfills existing withdrawal requests, and adds workflow, payout-attempt, and provider-event tables, uniqueness/ownership constraints, and database transition triggers. Neither migration has been run in this environment; run them only against a reviewed target database and verify operational backup/rollback policy first.

No statements here establish compliance with Indian gaming, KYC, AML, tax, RBI, payment-provider, data-protection, or other laws. Product eligibility, document minimization, retention/deletion, age/identity rules, payout destination controls, limits, tax reporting, sanctions screening, and provider contracts require qualified external verification and configuration.

## Frontend and wallet status

- **IMPLEMENTED:** paid tournament registration preflights the authenticated backend wallet endpoint and displays the available integer-paise balance and insufficient/unavailable states. This is informational only; the backend transaction remains authoritative and can still reject a stale balance.
- **IMPLEMENTED:** after paid registration or cancellation, the frontend refreshes wallet state from the backend. The wallet UI does not create payments or locally adjust the balance.
- **DEFERRED:** no frontend Razorpay checkout was added. The UI does not present a fake payment-success flow or treat client callback data as authoritative.
- **DEFERRED:** prize/winnings distribution and paid tournament external charging remain outside 24C. Tournament entry fees are wallet debits; they are not proof of an external provider charge.

## Verification record

**TESTED:** 109 backend tests pass, including auth, competition, wallet, paid registration, payment settlement, KYC review/ownership, withdrawal state and ledger effects, payout idempotency/replay/reconciliation, rollback, insufficient-funds, and cancellation-refund cases. The scripted PostgreSQL repository tests assert that ledger writes and their domain state changes share a transaction and are rolled back together; they are not a substitute for live PostgreSQL concurrency testing.

**TESTED:** frontend regression suites pass: auth **14**, competition **15**, wallet **9** (**38 total**). Backend TypeScript typecheck and production build pass. JavaScript/migration syntax checks pass for **18 files**; `git diff --check` passes. Backend `npm audit` reports **0 vulnerabilities**.

**NOT VERIFIED:** live Razorpay sandbox order/payment/webhook flow (sandbox credentials absent); migrations 006–007 and repository operation against PostgreSQL (`DATABASE_URL` is not configured); multi-process/database concurrency behavior in a deployed environment. No live payout-provider integration or payout capability is configured or claimed.

## Remaining phases and deployment dependencies

- **COMPLETE — 24D:** KYC review, withdrawal lifecycle, ledger reservation/settlement/release, and the provider-neutral payout foundation are implemented. The runtime payout adapter is unavailable; live payouts are not supported.
- **NOT STARTED — 24E:** no later Step 24 work is included here.
- **DEFERRED:** live payout-provider integration and payout destination onboarding, frontend KYC/withdrawal UI, production payment activation, bank/UPI settlement, and tournament winnings distribution.
- **DEPLOYMENT-DEPENDENT / NOT VERIFIED:** production provider configuration, webhook registration, HTTPS/proxy setup, database migration execution, monitoring, reconciliation operations, and legal/security approval.
