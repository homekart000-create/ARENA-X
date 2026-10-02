import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { CompetitionError } from './contracts.js';
import { PostgresCompetitionRepository } from './postgres-repository.js';
import { WalletError } from '../wallet/contracts.js';
import type {
  TransactionalWalletRepository,
  WalletCommand,
  WalletCommandResult,
  WalletTransactionFilter,
  WalletView,
  WithdrawalRequestView
} from '../wallet/contracts.js';
import { WalletService } from '../wallet/service.js';

interface RegistrationDb {
  readonly commands: string[];
  readonly stagedLedgerRows: string[];
  readonly committedLedgerRows: string[];
  failRegistrationInsert: boolean;
}

function createPool(entryFeeMinor: string, db: RegistrationDb): Pool {
  const client = {
    async query(sql: string, values: readonly unknown[] = []) {
      db.commands.push(sql);
      if (sql === 'BEGIN') return { rows: [], rowCount: 0 };
      if (sql === 'COMMIT') {
        db.committedLedgerRows.push(...db.stagedLedgerRows);
        db.stagedLedgerRows.length = 0;
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'ROLLBACK') {
        db.stagedLedgerRows.length = 0;
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM tournaments WHERE id = $1 FOR UPDATE')) {
        return {
          rows: [{
            id: values[0],
            participation_type: 'Solo',
            status: 'upcoming',
            max_slots: 10,
            registration_deadline: new Date(Date.now() + 60_000),
            entry_fee_minor: entryFeeMinor
          }],
          rowCount: 1
        };
      }
      if (sql.includes('JOIN registration_members rm ON rm.registration_id=r.id')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('count(*)::text AS count FROM tournament_registrations')) {
        return { rows: [{ count: '0' }], rowCount: 1 };
      }
      if (sql.includes('SELECT 1 FROM registration_members rm')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('INSERT INTO wallet_transactions')) {
        const id = randomUUID();
        db.stagedLedgerRows.push(id);
        return { rows: [{ id }], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO tournament_registrations')) {
        if (db.failRegistrationInsert) throw new Error('simulated registration insert failure');
        return { rows: [{ registered_at: new Date() }], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO registration_members')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query in paid-registration test: ${sql}`);
    },
    release() {}
  } as unknown as PoolClient;

  return {
    async connect() { return client; }
  } as unknown as Pool;
}

class TestWalletRepository implements TransactionalWalletRepository {
  readonly commands: WalletCommand[] = [];
  failWith: Error | null = null;

  async getWallet(_userId: string): Promise<WalletView> { throw new Error('Unexpected wallet read.'); }
  async listTransactions(_userId: string, _filter: WalletTransactionFilter) { return []; }
  async postTransaction(_command: WalletCommand): Promise<WalletCommandResult> { throw new Error('Expected shared transaction.'); }
  async requestWithdrawal(_command: WalletCommand): Promise<WithdrawalRequestView> { throw new Error('Unexpected withdrawal.'); }

  async postTransactionWithinTransaction(client: PoolClient, command: WalletCommand): Promise<WalletCommandResult> {
    if (this.failWith) throw this.failWith;
    this.commands.push(command);
    const inserted = await client.query<{ id: string }>(
      'INSERT INTO wallet_transactions (idempotency_key) VALUES ($1) RETURNING id',
      [command.idempotencyKey]
    );
    const transactionId = inserted.rows[0]!.id;
    const wallet: WalletView = {
      walletId: 'wallet-test', userId: command.userId, currency: 'INR', status: 'active',
      availableBalanceMinor: 875, reservedBalanceMinor: 0, totalDepositedMinor: 0,
      totalWithdrawnMinor: 0, totalWinningsMinor: 0, version: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    return {
      wallet,
      transaction: {
        transactionId, walletId: wallet.walletId, userId: command.userId,
        type: command.type, direction: command.direction, amountMinor: command.amountMinor,
        currency: 'INR', status: 'completed', description: command.description ?? '',
        referenceId: command.referenceId ?? null,
        relatedTransactionId: command.relatedTransactionId ?? null,
        createdAt: new Date().toISOString()
      },
      replayed: false
    };
  }
}

function createDb(entryFeeMinor: string, failRegistrationInsert = false) {
  const db: RegistrationDb = {
    commands: [], stagedLedgerRows: [], committedLedgerRows: [], failRegistrationInsert
  };
  const walletRepository = new TestWalletRepository();
  const repository = new PostgresCompetitionRepository(
    createPool(entryFeeMinor, db),
    new WalletService(walletRepository)
  );
  return { db, walletRepository, repository };
}

function createCancellationDb(payerUserId: string) {
  const db = {
    commands: [] as string[],
    stagedLedgerRows: [] as string[],
    committedLedgerRows: [] as string[],
    active: true
  };
  const client = {
    async query(sql: string, values: readonly unknown[] = []) {
      db.commands.push(sql);
      if (sql === 'BEGIN') return { rows: [], rowCount: 0 };
      if (sql === 'COMMIT') {
        db.committedLedgerRows.push(...db.stagedLedgerRows);
        db.stagedLedgerRows.length = 0;
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'ROLLBACK') {
        db.stagedLedgerRows.length = 0;
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM tournament_registrations r') && sql.includes('JOIN registration_members rm')) {
        return {
          rows: db.active ? [{
            id: 'registration-test',
            entry_fee_minor: '125',
            entry_fee_payer_user_id: payerUserId,
            entry_fee_wallet_id: 'wallet-test',
            entry_fee_transaction_id: 'entry-fee-test'
          }] : [],
          rowCount: db.active ? 1 : 0
        };
      }
      if (sql.startsWith('INSERT INTO wallet_transactions')) {
        const id = randomUUID();
        db.stagedLedgerRows.push(id);
        return { rows: [{ id }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE tournament_registrations SET status=')) {
        db.active = false;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE registration_members SET left_at=')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query in cancellation test: ${sql}`);
    },
    release() {}
  } as unknown as PoolClient;
  const pool = { async connect() { return client; } } as unknown as Pool;
  const walletRepository = new TestWalletRepository();
  const repository = new PostgresCompetitionRepository(pool, new WalletService(walletRepository));
  return { db, walletRepository, repository };
}

test('paid registration posts the exact entry fee and registration in the same database transaction', async () => {
  const { db, walletRepository, repository } = createDb('125');
  const registration = await repository.registerForTournament(randomUUID(), randomUUID());

  assert.equal(registration.status, 'registered');
  assert.equal(registration.replayed, false);
  assert.equal(walletRepository.commands.length, 1);
  assert.equal(walletRepository.commands[0]?.type, 'entry_fee');
  assert.equal(walletRepository.commands[0]?.direction, 'debit');
  assert.equal(walletRepository.commands[0]?.amountMinor, 125);
  assert.equal(walletRepository.commands[0]?.referenceId, `tournament-entry:${registration.registrationId}`);
  assert.equal(db.commands[0], 'BEGIN');
  assert.ok(db.commands.includes('COMMIT'));
  assert.equal(db.committedLedgerRows.length, 1);
  assert.ok(db.commands.some((sql) => sql.startsWith('INSERT INTO tournament_registrations')));
});

test('registration failure rolls back its staged entry-fee ledger write', async () => {
  const { db, repository } = createDb('125', true);

  await assert.rejects(
    repository.registerForTournament(randomUUID(), randomUUID()),
    (error: unknown) => error instanceof CompetitionError && error.statusCode === 503
  );
  assert.ok(db.commands.includes('ROLLBACK'));
  assert.equal(db.commands.includes('COMMIT'), false);
  assert.equal(db.stagedLedgerRows.length, 0);
  assert.equal(db.committedLedgerRows.length, 0);
});

test('insufficient wallet funds fail paid registration and free entry never calls the wallet writer', async () => {
  const paid = createDb('125');
  paid.walletRepository.failWith = new WalletError(409, 'INSUFFICIENT_FUNDS', 'Available wallet balance is insufficient.');
  await assert.rejects(
    paid.repository.registerForTournament(randomUUID(), randomUUID()),
    (error: unknown) => error instanceof WalletError && error.code === 'INSUFFICIENT_FUNDS'
  );
  assert.equal(paid.db.commands.includes('ROLLBACK'), true);
  assert.equal(paid.db.commands.some((sql) => sql.startsWith('INSERT INTO tournament_registrations')), false);

  const free = createDb('0');
  const registration = await free.repository.registerForTournament(randomUUID(), randomUUID());
  assert.equal(registration.status, 'registered');
  assert.equal(free.walletRepository.commands.length, 0);
  assert.equal(free.db.committedLedgerRows.length, 0);
});

test('paid cancellation refunds the original payer once and commits the refund with cancellation', async () => {
  const payerUserId = randomUUID();
  const cancellingUserId = randomUUID();
  const { db, walletRepository, repository } = createCancellationDb(payerUserId);

  assert.equal(await repository.cancelTournamentRegistration(randomUUID(), cancellingUserId), true);
  assert.equal(await repository.cancelTournamentRegistration(randomUUID(), cancellingUserId), false);
  assert.equal(walletRepository.commands.length, 1);
  assert.equal(walletRepository.commands[0]?.userId, payerUserId);
  assert.equal(walletRepository.commands[0]?.actorUserId, cancellingUserId);
  assert.equal(walletRepository.commands[0]?.type, 'refund');
  assert.equal(walletRepository.commands[0]?.direction, 'credit');
  assert.equal(walletRepository.commands[0]?.amountMinor, 125);
  assert.equal(walletRepository.commands[0]?.relatedTransactionId, 'entry-fee-test');
  assert.equal(db.committedLedgerRows.length, 1);
  assert.equal(db.commands.filter((sql) => sql.startsWith('UPDATE tournament_registrations SET status=')).length, 1);
  assert.equal(db.commands.filter((sql) => sql === 'COMMIT').length, 2);
});
