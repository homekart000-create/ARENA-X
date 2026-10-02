import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { WalletError } from './contracts.js';
import { PostgresWalletRepository } from './postgres-repository.js';
import type { WalletCommand } from './contracts.js';

function createDatabase(kycStatus: string | null) {
  const queries: string[] = [];
  let released = false;
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('FROM kyc_profiles')) {
        return { rows: kycStatus ? [{ status: kycStatus }] : [], rowCount: kycStatus ? 1 : 0 };
      }
      if (sql.startsWith('INSERT INTO wallets')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM wallets w WHERE w.user_id=$1 FOR UPDATE')) {
        return {
          rows: [{
            id: 'wallet-test', user_id: 'user-test', currency: 'INR', status: 'active',
            available_balance_minor: '0', reserved_balance_minor: '0', version: '0',
            created_at: new Date(0), updated_at: new Date(0),
            total_deposited_minor: '0', total_withdrawn_minor: '0', total_winnings_minor: '0'
          }],
          rowCount: 1
        };
      }
      if (sql.includes('WHERE t.user_id=$1 AND t.idempotency_key=$2')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM withdrawal_workflows')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected SQL in scripted KYC withdrawal test: ${sql}`);
    },
    release() { released = true; }
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { repository: new PostgresWalletRepository(pool), queries, isReleased: () => released };
}

const command: WalletCommand = {
  userId: 'user-test',
  type: 'withdrawal',
  direction: 'debit',
  amountMinor: 100,
  idempotencyKey: 'wallet-withdrawal-kyc-race-test'
};

test('withdrawal rejects non-verified KYC under a row lock before wallet reservation', async () => {
  const database = createDatabase('suspended');

  await assert.rejects(
    database.repository.requestWithdrawal(command, true),
    (error: unknown) => error instanceof WalletError && error.code === 'KYC_REQUIRED'
  );

  assert.equal(database.queries[1], 'SELECT status FROM kyc_profiles WHERE user_id=$1 FOR SHARE');
  assert.equal(database.queries.includes('INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING'), false);
  assert.equal(database.queries.includes('ROLLBACK'), true);
  assert.equal(database.isReleased(), true);
});

test('verified KYC is locked before wallet state is read inside the withdrawal transaction', async () => {
  const database = createDatabase('verified');

  await assert.rejects(
    database.repository.requestWithdrawal(command, true),
    (error: unknown) => error instanceof WalletError && error.code === 'INSUFFICIENT_FUNDS'
  );

  const kycLock = database.queries.findIndex((sql) => sql.includes('FROM kyc_profiles'));
  const walletLock = database.queries.findIndex((sql) => sql.includes('FROM wallets w WHERE w.user_id=$1 FOR UPDATE'));
  assert.ok(kycLock > 0);
  assert.ok(walletLock > kycLock);
  assert.equal(database.queries.includes('ROLLBACK'), true);
  assert.equal(database.isReleased(), true);
});
