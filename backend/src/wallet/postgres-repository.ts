import { timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { WalletError } from './contracts.js';
import type {
  WalletCommand,
  WalletCommandResult,
  WalletRepository,
  TransactionalWalletRepository,
  WalletTransactionFilter,
  WalletTransactionStatus,
  WalletTransactionView,
  WalletView,
  WithdrawalRequestView
} from './contracts.js';
import { walletRequestHash } from './service.js';

interface WalletRow {
  id: string;
  user_id: string;
  currency: 'INR';
  status: WalletView['status'];
  available_balance_minor: string;
  reserved_balance_minor: string;
  version: string;
  created_at: Date | string;
  updated_at: Date | string;
  total_deposited_minor: string;
  total_withdrawn_minor: string;
  total_winnings_minor: string;
}

interface TransactionRow {
  id: string;
  wallet_id: string;
  user_id: string;
  type: WalletTransactionView['type'];
  direction: WalletTransactionView['direction'];
  amount_minor: string;
  currency: 'INR';
  status: WalletTransactionStatus;
  description: string;
  reference_id: string | null;
  related_transaction_id: string | null;
  request_hash: Buffer;
  created_at: Date | string;
}

interface AccountRow {
  id: string;
  account_type: 'user_available' | 'user_reserved' | 'platform_clearing' | 'fee_revenue';
}

type Queryable = Pool | PoolClient;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function minorUnits(value: string): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new WalletError(503, 'WALLET_PRECISION_ERROR', 'Wallet amount is outside the supported integer range.');
  }
  return amount;
}

function mapWallet(row: WalletRow): WalletView {
  return {
    walletId: row.id,
    userId: row.user_id,
    currency: row.currency,
    status: row.status,
    availableBalanceMinor: minorUnits(row.available_balance_minor),
    reservedBalanceMinor: minorUnits(row.reserved_balance_minor),
    totalDepositedMinor: minorUnits(row.total_deposited_minor),
    totalWithdrawnMinor: minorUnits(row.total_withdrawn_minor),
    totalWinningsMinor: minorUnits(row.total_winnings_minor),
    version: minorUnits(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapTransaction(row: TransactionRow): WalletTransactionView {
  return {
    transactionId: row.id,
    walletId: row.wallet_id,
    userId: row.user_id,
    type: row.type,
    direction: row.direction,
    amountMinor: minorUnits(row.amount_minor),
    currency: row.currency,
    status: row.status,
    description: row.description,
    referenceId: row.reference_id,
    relatedTransactionId: row.related_transaction_id,
    createdAt: iso(row.created_at)
  };
}

function safeDatabaseError(error: unknown): WalletError {
  if (error instanceof WalletError) return error;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (error.code === '23505') return new WalletError(409, 'DUPLICATE_TRANSACTION', 'The transaction conflicts with an existing reference.');
    if (error.code === '23503' || error.code === '23514') return new WalletError(409, 'LEDGER_CONSTRAINT', 'The wallet operation could not be applied.');
  }
  return new WalletError(503, 'SERVICE_UNAVAILABLE', 'Wallet storage is temporarily unavailable.');
}

const walletSelect = `
  SELECT w.id::text AS id, w.user_id::text AS user_id, w.currency, w.status,
    w.available_balance_minor::text, w.reserved_balance_minor::text, w.version::text,
    w.created_at, w.updated_at,
    COALESCE(sum(t.amount_minor) FILTER (WHERE t.type='deposit' AND t.direction='credit' AND latest.to_status='completed'),0)::text AS total_deposited_minor,
    COALESCE(sum(t.amount_minor) FILTER (WHERE t.type='withdrawal' AND t.direction='debit' AND latest.to_status='completed'),0)::text AS total_withdrawn_minor,
    COALESCE(sum(t.amount_minor) FILTER (WHERE t.type='winning' AND t.direction='credit' AND latest.to_status='completed'),0)::text AS total_winnings_minor
  FROM wallets w
  LEFT JOIN wallet_transactions t ON t.wallet_id=w.id
  LEFT JOIN LATERAL (
    SELECT e.to_status FROM wallet_transaction_events e
    WHERE e.transaction_id=t.id ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1
  ) latest ON true`;

export class PostgresWalletRepository implements TransactionalWalletRepository {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw safeDatabaseError(error);
    }
    try {
      await client.query('BEGIN');
      const value = await action(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original operation error.
      }
      throw safeDatabaseError(error);
    } finally {
      client.release();
    }
  }

  private async lockWallet(client: PoolClient, userId: string): Promise<WalletRow> {
    await client.query('INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    const result = await client.query<WalletRow>(
      `SELECT w.id::text AS id, w.user_id::text AS user_id, w.currency, w.status,
        w.available_balance_minor::text, w.reserved_balance_minor::text, w.version::text,
        w.created_at, w.updated_at, '0' AS total_deposited_minor,
        '0' AS total_withdrawn_minor, '0' AS total_winnings_minor
       FROM wallets w WHERE w.user_id=$1 FOR UPDATE`,
      [userId]
    );
    const wallet = result.rows[0];
    if (!wallet) throw new WalletError(404, 'WALLET_NOT_FOUND', 'Wallet not found.');
    if (wallet.status !== 'active') throw new WalletError(403, 'WALLET_RESTRICTED', 'This wallet is not available for transactions.');
    return wallet;
  }

  private async readWallet(db: Queryable, userId: string): Promise<WalletView> {
    const result = await db.query<WalletRow>(
      `${walletSelect} WHERE w.user_id=$1 GROUP BY w.id`,
      [userId]
    );
    const wallet = result.rows[0];
    if (!wallet) throw new WalletError(404, 'WALLET_NOT_FOUND', 'Wallet not found.');
    return mapWallet(wallet);
  }

  private async readTransaction(db: Queryable, id: string): Promise<TransactionRow> {
    const result = await db.query<TransactionRow>(
      `SELECT t.id::text AS id, t.wallet_id::text AS wallet_id, t.user_id::text AS user_id,
        t.type, t.direction, t.amount_minor::text, t.currency,
        COALESCE(latest.to_status, 'pending') AS status, t.description, t.reference_id,
        t.related_transaction_id::text AS related_transaction_id, t.request_hash, t.created_at
       FROM wallet_transactions t
       LEFT JOIN LATERAL (
         SELECT e.to_status FROM wallet_transaction_events e
         WHERE e.transaction_id=t.id ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1
       ) latest ON true
       WHERE t.id=$1`,
      [id]
    );
    const transaction = result.rows[0];
    if (!transaction) throw new WalletError(503, 'SERVICE_UNAVAILABLE', 'Wallet transaction could not be loaded.');
    return transaction;
  }

  private async findIdempotent(client: PoolClient, command: WalletCommand, hash: Buffer): Promise<TransactionRow | null> {
    const result = await client.query<TransactionRow>(
      `SELECT t.id::text AS id, t.wallet_id::text AS wallet_id, t.user_id::text AS user_id,
        t.type, t.direction, t.amount_minor::text, t.currency,
        COALESCE(latest.to_status, 'pending') AS status, t.description, t.reference_id,
        t.related_transaction_id::text AS related_transaction_id, t.request_hash, t.created_at
       FROM wallet_transactions t
       LEFT JOIN LATERAL (
         SELECT e.to_status FROM wallet_transaction_events e
         WHERE e.transaction_id=t.id ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1
       ) latest ON true
       WHERE t.user_id=$1 AND t.idempotency_key=$2
       FOR UPDATE OF t`,
      [command.userId, command.idempotencyKey]
    );
    const existing = result.rows[0];
    if (!existing) return null;
    if (existing.request_hash.length !== hash.length || !timingSafeEqual(existing.request_hash, hash)) {
      throw new WalletError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was used for a different request.');
    }
    return existing;
  }

  private async getAccounts(client: PoolClient, walletId: string, needsReserved: boolean): Promise<{ available: string; reserved?: string; clearing: string }> {
    const result = await client.query<AccountRow>(
      `SELECT id::text AS id, account_type FROM ledger_accounts
       WHERE (wallet_id=$1 AND account_type IN ('user_available','user_reserved'))
          OR (wallet_id IS NULL AND account_type='platform_clearing' AND currency='INR')`,
      [walletId]
    );
    const available = result.rows.find((account) => account.account_type === 'user_available')?.id;
    const reserved = result.rows.find((account) => account.account_type === 'user_reserved')?.id;
    const clearing = result.rows.find((account) => account.account_type === 'platform_clearing')?.id;
    if (!available || !clearing || (needsReserved && !reserved)) throw new WalletError(503, 'LEDGER_UNAVAILABLE', 'Wallet ledger accounts are unavailable.');
    return { available, clearing, ...(reserved ? { reserved } : {}) };
  }

  private async insertTransaction(client: PoolClient, walletId: string, command: WalletCommand, hash: Buffer, status: 'pending' | 'completed'): Promise<string> {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO wallet_transactions (
        wallet_id,user_id,type,direction,amount_minor,currency,idempotency_key,request_hash,
        reference_id,related_transaction_id,actor_user_id,description,metadata
      ) VALUES ($1,$2,$3,$4,$5,'INR',$6,$7,$8,$9,$10,$11,$12)
      RETURNING id::text AS id`,
      [walletId, command.userId, command.type, command.direction, command.amountMinor, command.idempotencyKey, hash, command.referenceId ?? null, command.relatedTransactionId ?? null, command.actorUserId ?? command.userId, command.description ?? '', command.metadata ?? {}]
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new WalletError(503, 'SERVICE_UNAVAILABLE', 'Wallet transaction could not be created.');
    await client.query(
      `INSERT INTO wallet_transaction_events (transaction_id,event_type,to_status,actor_user_id)
       VALUES ($1,'created',$2,$3)`,
      [id, status, command.actorUserId ?? command.userId]
    );
    return id;
  }

  private async updateProjection(client: PoolClient, walletId: string, amountMinor: number, direction: 'credit' | 'debit', reserve: boolean): Promise<void> {
    const availableDelta = direction === 'credit' ? amountMinor : -amountMinor;
    const reservedDelta = reserve ? amountMinor : 0;
    const result = await client.query(
      `UPDATE wallets SET available_balance_minor=available_balance_minor+$2,
        reserved_balance_minor=reserved_balance_minor+$3, version=version+1, updated_at=now()
       WHERE id=$1 AND available_balance_minor+$2 >= 0 AND reserved_balance_minor+$3 >= 0`,
      [walletId, availableDelta, reservedDelta]
    );
    if (result.rowCount !== 1) throw new WalletError(409, 'INSUFFICIENT_FUNDS', 'Available wallet balance is insufficient.');
  }

  private async insertEntries(client: PoolClient, transactionId: string, currency: string, postings: readonly { accountId: string; amountMinor: number; kind: 'credit' | 'debit' | 'hold' }[]): Promise<void> {
    for (const posting of postings) {
      await client.query(
        `INSERT INTO wallet_ledger_entries (transaction_id,account_id,amount_minor,currency,entry_kind)
         VALUES ($1,$2,$3,$4,$5)`,
        [transactionId, posting.accountId, posting.amountMinor, currency, posting.kind]
      );
    }
  }

  async getWallet(userId: string): Promise<WalletView> {
    try {
      await this.pool.query('INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
      return await this.readWallet(this.pool, userId);
    } catch (error) {
      throw safeDatabaseError(error);
    }
  }

  async listTransactions(userId: string, filter: WalletTransactionFilter): Promise<readonly WalletTransactionView[]> {
    try {
      const result = await this.pool.query<TransactionRow>(
        `SELECT t.id::text AS id, t.wallet_id::text AS wallet_id, t.user_id::text AS user_id,
          t.type, t.direction, t.amount_minor::text, t.currency,
          COALESCE(latest.to_status, 'pending') AS status, t.description, t.reference_id,
          t.related_transaction_id::text AS related_transaction_id, t.request_hash, t.created_at
         FROM wallet_transactions t
         LEFT JOIN LATERAL (
           SELECT e.to_status FROM wallet_transaction_events e
           WHERE e.transaction_id=t.id ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1
         ) latest ON true
         WHERE t.user_id=$1 AND ($2::text IS NULL OR t.type=$2)
           AND ($3::text IS NULL OR latest.to_status=$3)
         ORDER BY t.created_at DESC, t.id DESC LIMIT $4 OFFSET $5`,
        [userId, filter.type ?? null, filter.status ?? null, filter.limit, filter.offset]
      );
      return result.rows.map((row) => mapTransaction(row));
    } catch (error) {
      throw safeDatabaseError(error);
    }
  }

  async postTransaction(command: WalletCommand): Promise<WalletCommandResult> {
    return this.transaction((client) => this.postTransactionWithinTransaction(client, command));
  }

  async postTransactionWithinTransaction(client: PoolClient, command: WalletCommand): Promise<WalletCommandResult> {
    const wallet = await this.lockWallet(client, command.userId);
    const hash = walletRequestHash(command);
    const existing = await this.findIdempotent(client, command, hash);
    if (existing) {
      return { wallet: await this.readWallet(client, command.userId), transaction: mapTransaction(existing), replayed: true };
    }
    if (command.direction === 'debit' && Number(wallet.available_balance_minor) < command.amountMinor) {
      throw new WalletError(409, 'INSUFFICIENT_FUNDS', 'Available wallet balance is insufficient.');
    }

    const accounts = await this.getAccounts(client, wallet.id, false);
    const transactionId = await this.insertTransaction(client, wallet.id, command, hash, 'completed');
    await this.updateProjection(client, wallet.id, command.amountMinor, command.direction, false);
    const amount = command.direction === 'credit' ? command.amountMinor : -command.amountMinor;
    const opposite = -amount;
    await this.insertEntries(client, transactionId, wallet.currency, [
      { accountId: accounts.available, amountMinor: amount, kind: command.direction },
      { accountId: accounts.clearing, amountMinor: opposite, kind: command.direction }
    ]);
    return {
      wallet: await this.readWallet(client, command.userId),
      transaction: mapTransaction(await this.readTransaction(client, transactionId)),
      replayed: false
    };
  }

  async requestWithdrawal(command: WalletCommand, requireVerifiedKyc = false): Promise<WithdrawalRequestView> {
    return this.transaction(async (client) => {
      if (requireVerifiedKyc) {
        const kyc = await client.query<{ status: string }>(
          'SELECT status FROM kyc_profiles WHERE user_id=$1 FOR SHARE',
          [command.userId]
        );
        if (kyc.rows[0]?.status !== 'verified') {
          throw new WalletError(403, 'KYC_REQUIRED', 'Withdrawal is unavailable until KYC has been verified.');
        }
      }
      const wallet = await this.lockWallet(client, command.userId);
      const hash = walletRequestHash(command);
      const existing = await this.findIdempotent(client, command, hash);
      if (existing) {
        const withdrawal = await client.query<{ id: string }>('SELECT id::text AS id FROM withdrawal_requests WHERE transaction_id=$1', [existing.id]);
        const withdrawalRequestId = withdrawal.rows[0]?.id;
        if (!withdrawalRequestId) throw new WalletError(503, 'SERVICE_UNAVAILABLE', 'Withdrawal request could not be loaded.');
        return {
          withdrawalRequestId,
          transaction: mapTransaction(existing),
          wallet: await this.readWallet(client, command.userId),
          replayed: true
        };
      }
      const activeWithdrawal = await client.query(
        `SELECT 1 FROM withdrawal_workflows
         WHERE user_id=$1 AND status IN ('pending','approved','processing') LIMIT 1`,
        [command.userId]
      );
      if (activeWithdrawal.rowCount) {
        throw new WalletError(409, 'WITHDRAWAL_ALREADY_ACTIVE', 'A withdrawal request is already being reviewed or processed.');
      }
      if (Number(wallet.available_balance_minor) < command.amountMinor) throw new WalletError(409, 'INSUFFICIENT_FUNDS', 'Available wallet balance is insufficient.');
      const accounts = await this.getAccounts(client, wallet.id, true);
      const reservedAccount = accounts.reserved;
      if (!reservedAccount) throw new WalletError(503, 'LEDGER_UNAVAILABLE', 'Wallet reserve account is unavailable.');
      const transactionId = await this.insertTransaction(client, wallet.id, command, hash, 'pending');
      await this.updateProjection(client, wallet.id, command.amountMinor, 'debit', true);
      await this.insertEntries(client, transactionId, wallet.currency, [
        { accountId: accounts.available, amountMinor: -command.amountMinor, kind: 'hold' },
        { accountId: reservedAccount, amountMinor: command.amountMinor, kind: 'hold' }
      ]);
      const request = await client.query<{ id: string }>(
        `INSERT INTO withdrawal_requests (transaction_id,wallet_id,user_id,amount_minor,currency)
         VALUES ($1,$2,$3,$4,$5) RETURNING id::text AS id`,
        [transactionId, wallet.id, command.userId, command.amountMinor, wallet.currency]
      );
      const requestId = request.rows[0]?.id;
      if (!requestId) throw new WalletError(503, 'SERVICE_UNAVAILABLE', 'Withdrawal request could not be created.');
      await client.query(`INSERT INTO withdrawal_workflows
        (withdrawal_request_id,user_id,current_transaction_id,status)
        VALUES ($1,$2,$3,'pending')`, [requestId, command.userId, transactionId]);
      await client.query(`INSERT INTO withdrawal_workflow_events
        (withdrawal_request_id,actor_user_id,from_status,to_status,action)
        VALUES ($1,$2,NULL,'pending','requested')`, [requestId, command.userId]);
      return {
        withdrawalRequestId: requestId,
        transaction: mapTransaction(await this.readTransaction(client, transactionId)),
        wallet: await this.readWallet(client, command.userId),
        replayed: false
      };
    });
  }
}