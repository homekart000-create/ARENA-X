# Payments — Steps 24A–24C

## Current status

- **IMPLEMENTED (24A):** provider-neutral payment contracts, integer-paise payment records, database persistence, idempotency, webhook-event storage, authenticated API boundaries, and an explicit state machine.
- **IMPLEMENTED (24B):** isolated Razorpay sandbox adapter, safe order creation, owner-scoped payment verification, raw-body webhook signature verification, provider-side payment fact checks, and replay/conflict handling.
- **IMPLEMENTED (24C):** verified payment settlement into the immutable wallet ledger, atomic paid tournament entry-fee debit and registration, idempotent paid-registration retries, and a transactional cancellation refund path for the original payer.
- **TESTED:** backend suite: **93 passed**; frontend auth: **14 passed**; competition: **15 passed**; wallet: **9 passed**. Typecheck, backend build, JavaScript syntax checks, `git diff --check`, and backend `npm audit` are verified for this worktree.
- **NOT VERIFIED:** no live PostgreSQL database is configured. The 24C migration/repository transaction SQL and row-lock behavior have scripted tests but have not been integration-tested against PostgreSQL. No Razorpay sandbox credentials are configured, so no live sandbox order, payment, or webhook was exercised.
- **DEFERRED:** frontend payment checkout, production payment activation, KYC, withdrawals/payout settlement, bank/UPI settlement, tournament prize distribution, and later Step 24 phases.

Real-money charging remains disabled. The Razorpay adapter accepts only sandbox configuration with a test key ID. No production payment credentials are included. Paid tournament registration is enabled against the existing wallet ledger; it does not charge an external payment method.

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

## Frontend and wallet status

- **IMPLEMENTED:** paid tournament registration preflights the authenticated backend wallet endpoint and displays the available integer-paise balance and insufficient/unavailable states. This is informational only; the backend transaction remains authoritative and can still reject a stale balance.
- **IMPLEMENTED:** after paid registration or cancellation, the frontend refreshes wallet state from the backend. The wallet UI does not create payments or locally adjust the balance.
- **DEFERRED:** no frontend Razorpay checkout was added. The UI does not present a fake payment-success flow or treat client callback data as authoritative.
- **DEFERRED:** prize/winnings distribution and paid tournament external charging remain outside 24C. Tournament entry fees are wallet debits; they are not proof of an external provider charge.

## Verification record

**TESTED:** 93 backend tests pass, including provider, wallet, paid registration, payment settlement, rollback, replay, insufficient-funds, free-entry, and cancellation-refund cases. The scripted PostgreSQL repository tests assert that ledger writes and their domain state changes share a transaction and are rolled back together; they are not a substitute for live PostgreSQL concurrency testing.

**TESTED:** frontend regression suites pass: auth **14**, competition **15**, wallet **9**. Backend TypeScript typecheck and build pass. Modified JavaScript/migration syntax checks and `git diff --check` pass. Backend `npm audit` reports **0 vulnerabilities**.

**NOT VERIFIED:** live Razorpay sandbox order/payment/webhook flow (sandbox credentials absent); migration/repository operation against PostgreSQL (database configuration absent); multi-process/database concurrency behavior in a deployed environment.

## Remaining phases and deployment dependencies

- **DEFERRED — 24D/24E:** not started; no later Step 24 work is included here.
- **DEFERRED:** production payment activation, KYC, withdrawals/payout settlement, bank/UPI settlement, and tournament winnings distribution.
- **DEPLOYMENT-DEPENDENT / NOT VERIFIED:** production provider configuration, webhook registration, HTTPS/proxy setup, database migration execution, monitoring, reconciliation operations, and legal/security approval.
