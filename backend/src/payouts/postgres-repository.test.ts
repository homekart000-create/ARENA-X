import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { PayoutError } from './contracts.js';
import { PostgresPayoutRepository } from './postgres-repository.js';
import type { PreparedPayout, WithdrawalStatus } from './contracts.js';

function createDatabase(options: { readonly failProjection?: boolean; readonly failProviderReference?: boolean } = {}) {
  const withdrawalId = randomUUID();
  const userId = randomUUID();
  const transactionId = randomUUID();
  const payoutAttemptId = randomUUID();
  const timestamps = new Date('2026-10-02T12:00:00.000Z');
  const workflow = {
    withdrawal_request_id: withdrawalId, user_id: userId, amount_minor: '500', currency: 'INR' as const,
    status: 'processing' as WithdrawalStatus, transaction_id: transactionId, current_transaction_id: transactionId,
    review_reason: null, reviewed_by_user_id: randomUUID(), created_at: timestamps, updated_at: timestamps
  };
  const attempt = {
    id: payoutAttemptId, attempt_number: 1, provider: 'test-provider', provider_reference_id: null as string | null,
    status: 'processing' as const, created_at: timestamps, updated_at: timestamps,
    idempotency_key: `arena-withdrawal:${withdrawalId}:1`
  };
  const database = {
    workflowStatus: 'processing' as WithdrawalStatus,
    walletAvailable: 1000,
    walletReserved: 500,
    transactionStatus: 'approved',
    ledgerEntries: [] as unknown[][],
    workflowEvents: [] as unknown[][],
    transactionEvents: [] as unknown[][],
    queries: [] as string[],
    committed: false,
    rolledBack: false
  };
  let snapshot: typeof database | null = null;

  const client = {
    async query(sql: string, values: readonly unknown[] = []) {
      database.queries.push(sql);
      if (sql === 'BEGIN') {
        snapshot = {
          ...database,
          ledgerEntries: [...database.ledgerEntries],
          workflowEvents: [...database.workflowEvents],
          transactionEvents: [...database.transactionEvents]
        };
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'COMMIT') {
        database.committed = true;
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'ROLLBACK') {
        if (snapshot) {
          database.workflowStatus = snapshot.workflowStatus;
          database.walletAvailable = snapshot.walletAvailable;
          database.walletReserved = snapshot.walletReserved;
          database.transactionStatus = snapshot.transactionStatus;
          database.ledgerEntries = [...snapshot.ledgerEntries];
          database.workflowEvents = [...snapshot.workflowEvents];
          database.transactionEvents = [...snapshot.transactionEvents];
        }
        database.rolledBack = true;
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT user_id::text AS user_id FROM withdrawal_requests')) {
        return { rows: [{ user_id: userId }], rowCount: 1 };
      }
      if (sql.includes('FROM wallets WHERE user_id=$1 FOR UPDATE')) {
        return { rows: [{
          id: 'wallet-test', available_balance_minor: String(database.walletAvailable),
          reserved_balance_minor: String(database.walletReserved), currency: 'INR', status: 'active'
        }], rowCount: 1 };
      }
      if (sql.includes('FROM ledger_accounts')) {
        return { rows: [
          { id: 'account-available', account_type: 'user_available' },
          { id: 'account-reserved', account_type: 'user_reserved' },
          { id: 'account-clearing', account_type: 'platform_clearing' }
        ], rowCount: 3 };
      }
      if (sql.includes('FROM withdrawal_workflows w JOIN withdrawal_requests r')) {
        workflow.status = database.workflowStatus;
        const locked = sql.includes('FOR UPDATE OF w, r');
        return { rows: [{ ...workflow }], rowCount: 1, ...(locked ? {} : {}) };
      }
      if (sql.includes('SELECT status, provider_reference_id, provider FROM payout_attempts')) {
        return { rows: [{
          status: attempt.status, provider_reference_id: attempt.provider_reference_id, provider: attempt.provider
        }], rowCount: 1 };
      }
      if (sql.includes('SELECT to_status FROM wallet_transaction_events')) {
        return { rows: [{ to_status: database.transactionStatus }], rowCount: 1 };
      }
      if (sql.includes('UPDATE wallets SET reserved_balance_minor=reserved_balance_minor-$2')) {
        if (options.failProjection || database.walletReserved < Number(values[1])) return { rows: [], rowCount: 0 };
        database.walletReserved -= Number(values[1]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE wallets SET available_balance_minor=available_balance_minor+$2')) {
        if (database.walletReserved < Number(values[1])) return { rows: [], rowCount: 0 };
        database.walletAvailable += Number(values[1]);
        database.walletReserved -= Number(values[1]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO wallet_ledger_entries')) {
        database.ledgerEntries.push([...values]);
        return { rows: [], rowCount: 2 };
      }
      if (sql.startsWith('INSERT INTO wallet_transaction_events')) {
        database.transactionEvents.push([...values]);
        database.transactionStatus = sql.includes("VALUES ($1,'completed'") ? 'completed' : String(values[1]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE withdrawal_workflows SET status=$1')) {
        database.workflowStatus = String(values[0]) as WithdrawalStatus;
        workflow.status = database.workflowStatus;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO withdrawal_workflow_events')) {
        database.workflowEvents.push([...values]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE payout_attempts SET status=$1')) {
        if (options.failProviderReference) throw { code: '23505' };
        attempt.status = String(values[0]) as typeof attempt.status;
        attempt.provider_reference_id = typeof values[1] === 'string' ? values[1] : null;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM payout_attempts WHERE withdrawal_request_id=$1 ORDER BY attempt_number')) {
        return { rows: [{ ...attempt }], rowCount: 1 };
      }
      if (sql.includes('FROM withdrawal_workflow_events WHERE withdrawal_request_id=$1')) {
        return { rows: [{
          actor_user_id: userId, from_status: 'processing', to_status: database.workflowStatus,
          action: database.workflowStatus, reason: null, created_at: timestamps
        }], rowCount: 1 };
      }
      throw new Error(`Unexpected payout repository SQL: ${sql}`);
    },
    release() {}
  } as unknown as PoolClient;
  const pool = { async connect() { return client; } } as unknown as Pool;
  const prepared: PreparedPayout = {
    payoutAttemptId, withdrawalRequestId: withdrawalId, userId, amountMinor: 500,
    currency: 'INR', attemptNumber: 1, idempotencyKey: attempt.idempotency_key, provider: attempt.provider
  };
  return { repository: new PostgresPayoutRepository(pool), database, prepared };
}

test('Postgres payout settlement posts reserved-to-clearing ledger entries atomically', async () => {
  const { repository, database, prepared } = createDatabase();
  const withdrawal = await repository.recordPayoutResult(prepared, {
    status: 'paid', providerReferenceId: 'provider-ref-1', amountMinor: 500, currency: 'INR'
  }, randomUUID(), 'created');
  assert.equal(withdrawal.status, 'paid');
  assert.equal(database.walletAvailable, 1000);
  assert.equal(database.walletReserved, 0);
  assert.equal(database.workflowStatus, 'paid');
  assert.equal(database.transactionStatus, 'completed');
  assert.equal(database.ledgerEntries.length, 1);
  assert.deepEqual(database.ledgerEntries[0]?.slice(1), ['account-reserved', -500, 'account-clearing', 500]);
  assert.equal(database.committed, true);
  assert.equal(database.rolledBack, false);
});

test('Postgres failed payout releases reserved funds, while projection failure rolls back', async () => {
  const released = createDatabase();
  const failed = await released.repository.recordPayoutResult(released.prepared, {
    status: 'failed', providerReferenceId: 'provider-ref-failed', amountMinor: 500, currency: 'INR'
  }, randomUUID(), 'created');
  assert.equal(failed.status, 'failed');
  assert.equal(released.database.walletAvailable, 1500);
  assert.equal(released.database.walletReserved, 0);
  assert.equal(released.database.ledgerEntries.length, 1);
  assert.equal(released.database.ledgerEntries[0]?.[4], -500);
  assert.equal(released.database.queries.some((sql) => sql.includes("'release'")), true);
  assert.equal(released.database.committed, true);

  const rolledBack = createDatabase({ failProjection: true });
  await assert.rejects(rolledBack.repository.recordPayoutResult(rolledBack.prepared, {
    status: 'paid', providerReferenceId: 'provider-ref-rollback', amountMinor: 500, currency: 'INR'
  }, randomUUID(), 'created'), (error: unknown) => error instanceof PayoutError && error.code === 'RESERVED_BALANCE_MISMATCH');
  assert.equal(rolledBack.database.walletReserved, 500);
  assert.equal(rolledBack.database.workflowStatus, 'processing');
  assert.equal(rolledBack.database.committed, false);
  assert.equal(rolledBack.database.rolledBack, true);
});

test('Postgres provider-reference uniqueness conflict rolls back ledger settlement', async () => {
  const { repository, database, prepared } = createDatabase({ failProviderReference: true });
  await assert.rejects(repository.recordPayoutResult(prepared, {
    status: 'paid', providerReferenceId: 'already-linked', amountMinor: 500, currency: 'INR'
  }, randomUUID(), 'created'), (error: unknown) => error instanceof PayoutError && error.code === 'PAYOUT_REFERENCE_CONFLICT');
  assert.equal(database.walletReserved, 500);
  assert.equal(database.workflowStatus, 'processing');
  assert.equal(database.ledgerEntries.length, 0);
  assert.equal(database.committed, false);
  assert.equal(database.rolledBack, true);
});
