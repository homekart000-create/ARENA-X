import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import type { PaymentRecord, ProviderPaymentDetails } from './contracts.js';
import { PaymentError } from './contracts.js';
import { PostgresPaymentRepository } from './postgres-repository.js';
import type {
  TransactionalWalletRepository,
  WalletCommand,
  WalletCommandResult,
  WalletTransactionFilter,
  WalletView,
  WithdrawalRequestView
} from '../wallet/contracts.js';
import { WalletService } from '../wallet/service.js';

function makePayment(status: PaymentRecord['status'] = 'pending'): Record<string, unknown> {
  const paymentId = randomUUID();
  return {
    id: paymentId,
    user_id: randomUUID(),
    provider: 'razorpay',
    provider_order_id: 'order_test_atomic',
    provider_payment_id: status === 'pending' ? null : 'pay_test_atomic',
    provider_reference_id: null,
    wallet_id: null,
    wallet_transaction_id: null,
    amount_minor: '1250',
    currency: 'INR',
    status,
    idempotency_key: 'payment-test-atomic-key',
    failure_code: null,
    reconciliation_metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    completed_at: null,
    request_hash: Buffer.alloc(32)
  };
}

class SettlementWalletRepository implements TransactionalWalletRepository {
  readonly commands: WalletCommand[] = [];

  async getWallet(_userId: string): Promise<WalletView> { throw new Error('Unexpected wallet read.'); }
  async listTransactions(_userId: string, _filter: WalletTransactionFilter) { return []; }
  async postTransaction(_command: WalletCommand): Promise<WalletCommandResult> { throw new Error('Expected shared transaction.'); }
  async requestWithdrawal(_command: WalletCommand): Promise<WithdrawalRequestView> { throw new Error('Unexpected withdrawal.'); }

  async postTransactionWithinTransaction(client: PoolClient, command: WalletCommand): Promise<WalletCommandResult> {
    this.commands.push(command);
    const result = await client.query<{ id: string }>(
      'INSERT INTO wallet_transactions (idempotency_key) VALUES ($1) RETURNING id::text AS id',
      [command.idempotencyKey]
    );
    const wallet: WalletView = {
      walletId: 'wallet-settlement', userId: command.userId, currency: 'INR', status: 'active',
      availableBalanceMinor: 1250, reservedBalanceMinor: 0, totalDepositedMinor: 1250,
      totalWithdrawnMinor: 0, totalWinningsMinor: 0, version: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    return {
      wallet,
      transaction: {
        transactionId: result.rows[0]!.id, walletId: wallet.walletId, userId: command.userId,
        type: command.type, direction: command.direction, amountMinor: command.amountMinor,
        currency: 'INR', status: 'completed', description: command.description ?? '',
        referenceId: command.referenceId ?? null, relatedTransactionId: command.relatedTransactionId ?? null,
        createdAt: new Date().toISOString()
      },
      replayed: false
    };
  }
}

function createSettlementRepository(failSettlementUpdate = false) {
  const row = makePayment();
  const database = {
    commands: [] as string[],
    stagedLedgerIds: [] as string[],
    committedLedgerIds: [] as string[],
    failSettlementUpdate,
    snapshot: null as Record<string, unknown> | null
  };
  const client = {
    async query(sql: string, values: readonly unknown[] = []) {
      database.commands.push(sql);
      if (sql === 'BEGIN') {
        database.snapshot = { ...row };
        database.stagedLedgerIds.length = 0;
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'COMMIT') {
        database.committedLedgerIds.push(...database.stagedLedgerIds);
        database.stagedLedgerIds.length = 0;
        database.snapshot = null;
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'ROLLBACK') {
        if (database.snapshot) Object.assign(row, database.snapshot);
        database.stagedLedgerIds.length = 0;
        database.snapshot = null;
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT') && sql.includes('FROM payments WHERE id=$1 FOR UPDATE')) {
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE payments SET wallet_id')) {
        if (database.failSettlementUpdate) throw new Error('simulated payment update failure');
        Object.assign(row, {
          wallet_id: values[1],
          wallet_transaction_id: values[2],
          status: 'settled',
          completed_at: new Date(),
          updated_at: new Date()
        });
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (sql.includes("SET provider_payment_id=")) {
        Object.assign(row, {
          provider_payment_id: values[1],
          provider_reference_id: values[2],
          status: 'paid',
          updated_at: new Date()
        });
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO wallet_transactions')) {
        const id = randomUUID();
        database.stagedLedgerIds.push(id);
        return { rows: [{ id }], rowCount: 1 };
      }
      throw new Error(`Unexpected query in payment settlement test: ${sql}`);
    },
    release() {}
  } as unknown as PoolClient;
  const pool = { async connect() { return client; } } as unknown as Pool;
  const walletRepository = new SettlementWalletRepository();
  const repository = new PostgresPaymentRepository(pool, new WalletService(walletRepository));
  return { database, paymentId: String(row.id), row, walletRepository, repository };
}

const details: ProviderPaymentDetails = {
  providerOrderId: 'order_test_atomic',
  providerPaymentId: 'pay_test_atomic',
  amountMinor: 1250,
  currency: 'INR',
  status: 'captured',
  providerReferenceId: null
};

test('verified payment and wallet credit settle once inside one PostgreSQL transaction', async () => {
  const { database, paymentId, walletRepository, repository } = createSettlementRepository();
  const first = await repository.verifyPayment(paymentId, details);
  const replay = await repository.verifyPayment(paymentId, details);
  assert.equal(first.status, 'settled');
  assert.ok(first.walletTransactionId);
  assert.equal(replay.walletTransactionId, first.walletTransactionId);
  assert.equal(walletRepository.commands.length, 1);
  assert.equal(walletRepository.commands[0]?.type, 'deposit');
  assert.equal(walletRepository.commands[0]?.amountMinor, details.amountMinor);
  assert.equal(walletRepository.commands[0]?.idempotencyKey, `payment-credit:${paymentId}`);
  assert.equal(database.committedLedgerIds.length, 1);
  assert.equal(database.commands.filter((sql) => sql === 'BEGIN').length, 2);
  assert.equal(database.commands.filter((sql) => sql === 'COMMIT').length, 2);
});

test('payment settlement rolls back the ledger credit when the payment mapping update fails', async () => {
  const { database, paymentId, row, repository } = createSettlementRepository(true);
  await assert.rejects(
    repository.verifyPayment(paymentId, details),
    (error: unknown) => error instanceof PaymentError && error.statusCode === 503
  );
  assert.equal(database.commands.includes('ROLLBACK'), true);
  assert.equal(database.commands.includes('COMMIT'), false);
  assert.equal(database.committedLedgerIds.length, 0);
  assert.equal(database.stagedLedgerIds.length, 0);
  assert.equal(row.status, 'pending');
});

test('payment amount and currency must match the locked internal record', async () => {
  const { paymentId, walletRepository, repository } = createSettlementRepository();
  await assert.rejects(
    repository.verifyPayment(paymentId, { ...details, amountMinor: 1251 }),
    (error: unknown) => error instanceof PaymentError && error.code === 'PAYMENT_DETAILS_MISMATCH'
  );
  await assert.rejects(
    repository.verifyPayment(paymentId, { ...details, currency: 'USD' }),
    (error: unknown) => error instanceof PaymentError && error.code === 'PAYMENT_DETAILS_MISMATCH'
  );
  assert.equal(walletRepository.commands.length, 0);
});
