# Frontend Wallet Migration: Step 22C

The wallet page reads the current user's balance and transaction history from `GET /api/wallet` and `GET /api/wallet/transactions`, using the shared credentialed `js/api.js` client. Amounts remain integer paise in application state and are formatted for INR display without floating-point arithmetic. Legacy `arenaX_wallets` and `arenaX_transactions` browser records are not read, imported, deleted, or updated.

Withdrawal requests use `POST /api/wallet/withdrawal-requests` with only `amountMinor` in the body and a generated `Idempotency-Key` header. The authenticated backend session determines ownership. After acceptance, wallet and transaction data are reloaded from the backend. The API reserves the requested amount; it does not initiate a bank/UPI transfer or settlement.

Real deposits are unavailable because Step 21 has no public deposit/payment endpoint. The UI disables Add Money and does not simulate credits. The public tournament registration contract also has no atomic entry-fee settlement operation, so frontend registration is disabled for tournaments with a non-zero entry fee. Free registration remains on the existing authenticated competition API.

The admin backend has no cross-user wallet summary or transaction-history endpoint. Admin wallet totals and the transaction table therefore show an explicit unavailable state rather than deriving data from localStorage. No admin wallet mutation capability is exposed.

The backend currently returns up to 100 transactions per request; the wallet page requests the first 100 and retains its existing type filters. `DATABASE_URL` and a configured/deployed backend are required to validate live PostgreSQL behavior. Contract tests use mocked frontend responses and the backend's existing tests.
