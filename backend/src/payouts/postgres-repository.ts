import { timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { WalletCommand } from '../wallet/contracts.js';
import { walletRequestHash } from '../wallet/service.js';
import { PayoutError } from './contracts.js';
import type {
  PayoutListFilter,
  PayoutRepository,
  PayoutResult,
  PayoutStatus,
  PayoutWebhookEvent,
  PayoutAttempt,
  PreparedPayout,
  WithdrawalAuditEvent,
  WithdrawalDetail,
  WithdrawalStatus,
  WithdrawalSummary
} from './contracts.js';

interface WithdrawalRow {
  readonly withdrawal_request_id: string;
  readonly user_id: string;
  readonly amount_minor: string;
  readonly status: WithdrawalStatus;
  readonly transaction_id: string;
  readonly current_transaction_id: string;
  readonly currency: 'INR';
  readonly review_reason: string | null;
  readonly reviewed_by_user_id: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface AttemptRow {
  readonly id: string;
  readonly attempt_number: number;
  readonly provider: string;
  readonly provider_reference_id: string | null;
  readonly status: PayoutStatus;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly idempotency_key: string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapSummary(row: WithdrawalRow): WithdrawalSummary {
  return {
    withdrawalRequestId: row.withdrawal_request_id,
    userId: row.user_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    transactionId: row.transaction_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

const baseSelect = `SELECT w.withdrawal_request_id::text AS withdrawal_request_id, w.user_id::text AS user_id,
  r.amount_minor::text AS amount_minor, r.currency, w.status, r.transaction_id::text AS transaction_id,
  w.current_transaction_id::text AS current_transaction_id, w.review_reason,
  w.reviewed_by_user_id::text AS reviewed_by_user_id, w.created_at, w.updated_at
  FROM withdrawal_workflows w JOIN withdrawal_requests r ON r.id=w.withdrawal_request_id`;

function safeDatabaseError(error: unknown): PayoutError {
  if (error instanceof PayoutError) return error;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (error.code === '23505') return new PayoutError(409, 'PAYOUT_REFERENCE_CONFLICT', 'Payout details conflict with an existing provider record.');
    if (error.code === '23503' || error.code === '23514') return new PayoutError(409, 'INVALID_WITHDRAWAL_TRANSITION', 'The withdrawal operation conflicts with its current state.');
  }
  return new PayoutError(503, 'PAYOUT_STORAGE_UNAVAILABLE', 'Withdrawal storage is temporarily unavailable.');
}

export class PostgresPayoutRepository implements PayoutRepository {
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

  private async loadDetail(db: Pool | PoolClient, withdrawalRequestId: string): Promise<WithdrawalDetail> {
    const selected = await db.query<WithdrawalRow>(`${baseSelect} WHERE w.withdrawal_request_id=$1`, [withdrawalRequestId]);
    const row = selected.rows[0];
    if (!row) throw new PayoutError(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal request not found.');
    const [attemptRows, eventRows] = await Promise.all([
      db.query<AttemptRow>(`SELECT id::text AS id, attempt_number, provider, provider_reference_id, status, created_at, updated_at, idempotency_key
        FROM payout_attempts WHERE withdrawal_request_id=$1 ORDER BY attempt_number`, [withdrawalRequestId]),
      db.query<{ actor_user_id: string | null; from_status: WithdrawalStatus | null; to_status: WithdrawalStatus; action: string; reason: string | null; created_at: Date | string }>(
        `SELECT actor_user_id::text AS actor_user_id, from_status, to_status, action, reason, created_at
         FROM withdrawal_workflow_events WHERE withdrawal_request_id=$1 ORDER BY created_at, id`, [withdrawalRequestId])
    ]);
    const attempts: PayoutAttempt[] = attemptRows.rows.map((attempt) => ({
      payoutAttemptId: attempt.id,
      attemptNumber: attempt.attempt_number,
      provider: attempt.provider,
      providerReferenceId: attempt.provider_reference_id,
      status: attempt.status,
      createdAt: iso(attempt.created_at),
      updatedAt: iso(attempt.updated_at)
    }));
    const events: WithdrawalAuditEvent[] = eventRows.rows.map((event) => ({
      actorUserId: event.actor_user_id ?? 'system',
      fromStatus: event.from_status,
      toStatus: event.to_status,
      action: event.action,
      reason: event.reason,
      createdAt: iso(event.created_at)
    }));
    return {
      ...mapSummary(row),
      reviewReason: row.review_reason,
      reviewedByUserId: row.reviewed_by_user_id,
      attempts,
      events
    };
  }

  private async lockWorkflow(client: PoolClient, withdrawalRequestId: string): Promise<WithdrawalRow> {
    const result = await client.query<WithdrawalRow>(`${baseSelect}
      WHERE w.withdrawal_request_id=$1 FOR UPDATE OF w, r`, [withdrawalRequestId]);
    const row = result.rows[0];
    if (!row) throw new PayoutError(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal request not found.');
    return row;
  }

  private async lockWalletThenWorkflow(client: PoolClient, withdrawalRequestId: string): Promise<WithdrawalRow> {
    const owner = await client.query<{ user_id: string }>(
      'SELECT user_id::text AS user_id FROM withdrawal_requests WHERE id=$1', [withdrawalRequestId]);
    const userId = owner.rows[0]?.user_id;
    if (!userId) throw new PayoutError(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal request not found.');
    await this.lockWalletAndAccounts(client, userId);
    return this.lockWorkflow(client, withdrawalRequestId);
  }

  private async insertEvent(
    client: PoolClient,
    withdrawalRequestId: string,
    actorUserId: string | null,
    fromStatus: WithdrawalStatus | null,
    toStatus: WithdrawalStatus,
    action: string,
    reason: string | null
  ): Promise<void> {
    await client.query(`INSERT INTO withdrawal_workflow_events
      (withdrawal_request_id, actor_user_id, from_status, to_status, action, reason)
      VALUES ($1,$2,$3,$4,$5,$6)`, [withdrawalRequestId, actorUserId, fromStatus, toStatus, action, reason]);
  }

  async list(filter: PayoutListFilter = {}): Promise<readonly WithdrawalSummary[]> {
    try {
      const result = await this.pool.query<WithdrawalRow>(`${baseSelect}
        WHERE ($1::text IS NULL OR w.status=$1)
        ORDER BY w.created_at DESC, w.withdrawal_request_id DESC LIMIT $2 OFFSET $3`,
      [filter.status ?? null, filter.limit ?? 25, filter.offset ?? 0]);
      return result.rows.map(mapSummary);
    } catch (error) {
      throw safeDatabaseError(error);
    }
  }

  async listForUser(userId: string, filter: PayoutListFilter = {}): Promise<readonly WithdrawalSummary[]> {
    try {
      const result = await this.pool.query<WithdrawalRow>(`${baseSelect}
        WHERE w.user_id=$1 AND ($2::text IS NULL OR w.status=$2)
        ORDER BY w.created_at DESC, w.withdrawal_request_id DESC LIMIT $3 OFFSET $4`,
      [userId, filter.status ?? null, filter.limit ?? 25, filter.offset ?? 0]);
      return result.rows.map(mapSummary);
    } catch (error) {
      throw safeDatabaseError(error);
    }
  }

  async get(withdrawalRequestId: string): Promise<WithdrawalDetail | null> {
    try {
      const row = await this.pool.query(`${baseSelect} WHERE w.withdrawal_request_id=$1`, [withdrawalRequestId]);
      if (!row.rows[0]) return null;
      return await this.loadDetail(this.pool, withdrawalRequestId);
    } catch (error) {
      throw safeDatabaseError(error);
    }
  }

  async getForUser(withdrawalRequestId: string, userId: string): Promise<WithdrawalDetail | null> {
    try {
      const row = await this.pool.query(`${baseSelect} WHERE w.withdrawal_request_id=$1 AND w.user_id=$2`, [withdrawalRequestId, userId]);
      if (!row.rows[0]) return null;
      return await this.loadDetail(this.pool, withdrawalRequestId);
    } catch (error) {
      throw safeDatabaseError(error);
    }
  }

  async approve(withdrawalRequestId: string, adminUserId: string, reason: string | null): Promise<WithdrawalDetail> {
    return this.transaction(async (client) => {
      const current = await this.lockWorkflow(client, withdrawalRequestId);
      if (current.status !== 'pending') throw new PayoutError(409, 'INVALID_WITHDRAWAL_TRANSITION', 'Only pending withdrawals can be approved.');
      await client.query(`UPDATE withdrawal_workflows SET status='approved', reviewed_by_user_id=$1,
        review_reason=$2, updated_at=now() WHERE withdrawal_request_id=$3`, [adminUserId, reason, withdrawalRequestId]);
      await client.query(`INSERT INTO wallet_transaction_events
        (transaction_id,event_type,from_status,to_status,actor_user_id,reason)
        VALUES ($1,'approved','pending','approved',$2,$3)`, [current.current_transaction_id, adminUserId, reason]);
      await this.insertEvent(client, withdrawalRequestId, adminUserId, 'pending', 'approved', 'approved', reason);
      return this.loadDetail(client, withdrawalRequestId);
    });
  }

  private async lockWalletAndAccounts(client: PoolClient, userId: string) {
    const walletResult = await client.query<{ id: string; available_balance_minor: string; reserved_balance_minor: string; currency: 'INR'; status: string }>(
      `SELECT id::text AS id, available_balance_minor::text, reserved_balance_minor::text, currency, status
       FROM wallets WHERE user_id=$1 FOR UPDATE`, [userId]);
    const wallet = walletResult.rows[0];
    if (!wallet || wallet.status !== 'active') throw new PayoutError(403, 'WALLET_RESTRICTED', 'This wallet is not available for withdrawal.');
    const accountResult = await client.query<{ id: string; account_type: string }>(
      `SELECT id::text AS id, account_type FROM ledger_accounts
       WHERE (wallet_id=(SELECT id FROM wallets WHERE user_id=$1) AND account_type IN ('user_available','user_reserved'))
          OR (wallet_id IS NULL AND account_type='platform_clearing' AND currency='INR')`, [userId]);
    const getAccount = (type: string) => accountResult.rows.find((account) => account.account_type === type)?.id;
    const available = getAccount('user_available');
    const reserved = getAccount('user_reserved');
    const clearing = getAccount('platform_clearing');
    if (!available || !reserved || !clearing) throw new PayoutError(503, 'LEDGER_UNAVAILABLE', 'Wallet ledger accounts are unavailable.');
    return { wallet, available, reserved, clearing };
  }

  private async releaseHold(client: PoolClient, row: WithdrawalRow, actorUserId: string, status: 'failed' | 'rejected' | 'cancelled', reason: string): Promise<void> {
    const accounts = await this.lockWalletAndAccounts(client, row.user_id);
    const amount = Number(row.amount_minor);
    const projection = await client.query(`UPDATE wallets SET available_balance_minor=available_balance_minor+$2,
      reserved_balance_minor=reserved_balance_minor-$2, version=version+1, updated_at=now()
      WHERE id=$1 AND reserved_balance_minor >= $2`, [accounts.wallet.id, amount]);
    if (projection.rowCount !== 1) throw new PayoutError(409, 'RESERVED_BALANCE_MISMATCH', 'The withdrawal reservation could not be released safely.');
    await client.query(`INSERT INTO wallet_ledger_entries (transaction_id,account_id,amount_minor,currency,entry_kind)
      VALUES ($1,$2,$3,'INR','release'),($1,$4,$5,'INR','release')`,
    [row.current_transaction_id, accounts.available, amount, accounts.reserved, -amount]);
    const priorResult = await client.query<{ to_status: string }>(`SELECT to_status FROM wallet_transaction_events
      WHERE transaction_id=$1 ORDER BY occurred_at DESC, id DESC LIMIT 1`, [row.current_transaction_id]);
    const prior = priorResult.rows[0]?.to_status ?? 'pending';
    await client.query(`INSERT INTO wallet_transaction_events (transaction_id,event_type,from_status,to_status,actor_user_id,reason)
      VALUES ($1,$2,$3,$2,$4,$5)`, [row.current_transaction_id, status, prior, actorUserId, reason]);
  }

  async reject(withdrawalRequestId: string, adminUserId: string, reason: string): Promise<WithdrawalDetail> {
    return this.transaction(async (client) => {
      const current = await this.lockWalletThenWorkflow(client, withdrawalRequestId);
      if (current.status !== 'pending') throw new PayoutError(409, 'INVALID_WITHDRAWAL_TRANSITION', 'Only pending withdrawals can be rejected.');
      await this.releaseHold(client, current, adminUserId, 'rejected', reason);
      await client.query(`UPDATE withdrawal_workflows SET status='rejected', reviewed_by_user_id=$1,
        review_reason=$2, updated_at=now(), completed_at=now() WHERE withdrawal_request_id=$3`,
      [adminUserId, reason, withdrawalRequestId]);
      await this.insertEvent(client, withdrawalRequestId, adminUserId, 'pending', 'rejected', 'rejected', reason);
      return this.loadDetail(client, withdrawalRequestId);
    });
  }

  async cancel(withdrawalRequestId: string, userId: string): Promise<WithdrawalDetail> {
    return this.transaction(async (client) => {
      await this.lockWalletAndAccounts(client, userId);
      const current = await this.lockWorkflow(client, withdrawalRequestId);
      if (current.user_id !== userId) throw new PayoutError(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal request not found.');
      if (current.status !== 'pending' && current.status !== 'approved') {
        throw new PayoutError(409, 'INVALID_WITHDRAWAL_TRANSITION', 'Only pending or approved withdrawals can be cancelled.');
      }
      await this.releaseHold(client, current, userId, 'cancelled', 'Cancelled by the account owner');
      await client.query(`UPDATE withdrawal_workflows SET status='cancelled', updated_at=now(), completed_at=now()
        WHERE withdrawal_request_id=$1`, [withdrawalRequestId]);
      await this.insertEvent(client, withdrawalRequestId, userId, current.status, 'cancelled', 'cancelled', 'Cancelled by the account owner');
      return this.loadDetail(client, withdrawalRequestId);
    });
  }

  private async createRetryHold(client: PoolClient, row: WithdrawalRow, adminUserId: string, attemptNumber: number): Promise<string> {
    const accounts = await this.lockWalletAndAccounts(client, row.user_id);
    const amount = Number(row.amount_minor);
    if (Number(accounts.wallet.available_balance_minor) < amount) {
      throw new PayoutError(409, 'INSUFFICIENT_FUNDS', 'Available wallet balance is insufficient to retry this withdrawal.');
    }
    const key = `withdrawal-retry:${row.withdrawal_request_id}:${attemptNumber}`;
    const command: WalletCommand = {
      userId: row.user_id, type: 'withdrawal', direction: 'debit', amountMinor: amount,
      idempotencyKey: key, relatedTransactionId: row.transaction_id,
      actorUserId: adminUserId, description: `Withdrawal retry ${attemptNumber}`, metadata: { withdrawalRequestId: row.withdrawal_request_id, retry: attemptNumber }
    };
    const hash = walletRequestHash(command);
    const created = await client.query<{ id: string }>(`INSERT INTO wallet_transactions
      (wallet_id,user_id,type,direction,amount_minor,currency,idempotency_key,request_hash,
       related_transaction_id,actor_user_id,description,metadata)
      VALUES ($1,$2,'withdrawal','debit',$3,'INR',$4,$5,$6,$7,$8,$9) RETURNING id::text AS id`,
    [accounts.wallet.id, row.user_id, amount, key, hash, row.transaction_id, adminUserId, command.description, command.metadata]);
    const transactionId = created.rows[0]?.id;
    if (!transactionId) throw new PayoutError(503, 'PAYOUT_STORAGE_UNAVAILABLE', 'Withdrawal retry could not be created.');
    await client.query(`INSERT INTO wallet_transaction_events (transaction_id,event_type,to_status,actor_user_id)
      VALUES ($1,'created','pending',$2)`, [transactionId, adminUserId]);
    await client.query(`UPDATE wallets SET available_balance_minor=available_balance_minor-$2,
      reserved_balance_minor=reserved_balance_minor+$2, version=version+1, updated_at=now() WHERE id=$1`,
    [accounts.wallet.id, amount]);
    await client.query(`INSERT INTO wallet_ledger_entries (transaction_id,account_id,amount_minor,currency,entry_kind)
      VALUES ($1,$2,$3,'INR','hold'),($1,$4,$5,'INR','hold')`,
    [transactionId, accounts.available, -amount, accounts.reserved, amount]);
    return transactionId;
  }

  async preparePayout(withdrawalRequestId: string, adminUserId: string, provider: string): Promise<PreparedPayout> {
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(provider)) throw new PayoutError(400, 'INVALID_PAYOUT_PROVIDER', 'Payout provider is invalid.');
    return this.transaction(async (client) => {
      const current = await this.lockWalletThenWorkflow(client, withdrawalRequestId);
      if (current.status !== 'approved' && current.status !== 'failed') {
        throw new PayoutError(409, 'INVALID_WITHDRAWAL_TRANSITION', 'Only approved or definitively failed withdrawals can be retried.');
      }
      const attemptNumber = Number((await client.query<{ attempt_count: number }>(
        'SELECT attempt_count FROM withdrawal_workflows WHERE withdrawal_request_id=$1', [withdrawalRequestId]
      )).rows[0]?.attempt_count ?? 0) + 1;
      let transactionId = current.current_transaction_id;
      if (current.status === 'failed') transactionId = await this.createRetryHold(client, current, adminUserId, attemptNumber);
      await client.query(`UPDATE withdrawal_workflows SET status='processing', current_transaction_id=$1,
        attempt_count=$2, updated_at=now(), review_reason=NULL WHERE withdrawal_request_id=$3`,
      [transactionId, attemptNumber, withdrawalRequestId]);
      await this.insertEvent(client, withdrawalRequestId, adminUserId, current.status, 'processing',
        current.status === 'failed' ? 'retried' : 'processing', null);
      const idempotencyKey = `arena-withdrawal:${withdrawalRequestId}:${attemptNumber}`;
      const inserted = await client.query<{ id: string }>(`INSERT INTO payout_attempts
        (withdrawal_request_id,attempt_number,provider,idempotency_key,status)
        VALUES ($1,$2,$3,$4,'processing') RETURNING id::text AS id`,
      [withdrawalRequestId, attemptNumber, provider, idempotencyKey]);
      const payoutAttemptId = inserted.rows[0]?.id;
      if (!payoutAttemptId) throw new PayoutError(503, 'PAYOUT_STORAGE_UNAVAILABLE', 'Payout attempt could not be created.');
      return {
        payoutAttemptId, withdrawalRequestId, userId: current.user_id,
        amountMinor: Number(current.amount_minor), currency: current.currency,
        attemptNumber, idempotencyKey, provider
      };
    });
  }

  private async readPrepared(client: PoolClient, attemptId: string): Promise<PreparedPayout | null> {
    const result = await client.query<{ id: string; withdrawal_request_id: string; user_id: string; amount_minor: string; currency: 'INR'; attempt_number: number; idempotency_key: string; provider: string }>(
      `SELECT p.id::text AS id, p.withdrawal_request_id::text AS withdrawal_request_id, r.user_id::text AS user_id,
        r.amount_minor::text AS amount_minor, r.currency, p.attempt_number, p.idempotency_key, p.provider
       FROM payout_attempts p JOIN withdrawal_requests r ON r.id=p.withdrawal_request_id WHERE p.id=$1`,
      [attemptId]);
    const row = result.rows[0];
    return row ? {
      payoutAttemptId: row.id, withdrawalRequestId: row.withdrawal_request_id, userId: row.user_id,
      amountMinor: Number(row.amount_minor), currency: row.currency, attemptNumber: row.attempt_number,
      idempotencyKey: row.idempotency_key, provider: row.provider
    } : null;
  }

  private async applyResult(
    client: PoolClient,
    prepared: PreparedPayout,
    result: PayoutResult,
    actorUserId: string | null,
    action: 'created' | 'reconciled' | 'provider_event'
  ): Promise<void> {
    if ((result.amountMinor !== undefined && result.amountMinor !== prepared.amountMinor)
      || (result.currency !== undefined && result.currency !== prepared.currency)
      || ((result.status === 'paid' || result.status === 'failed')
        && (result.amountMinor !== prepared.amountMinor || result.currency !== prepared.currency))) {
      result = {
        status: 'unknown',
        ...(result.providerReferenceId ? { providerReferenceId: result.providerReferenceId } : {})
      };
    }
    const workflow = await this.lockWalletThenWorkflow(client, prepared.withdrawalRequestId);
    const attemptResult = await client.query<{ status: PayoutStatus; provider_reference_id: string | null; provider: string }>(
      `SELECT status, provider_reference_id, provider FROM payout_attempts WHERE id=$1 FOR UPDATE`, [prepared.payoutAttemptId]);
    const attempt = attemptResult.rows[0];
    if (!attempt || attempt.provider !== prepared.provider) throw new PayoutError(404, 'PAYOUT_ATTEMPT_NOT_FOUND', 'Payout attempt not found.');
    if (workflow.status !== 'processing') {
      throw new PayoutError(409, 'INVALID_WITHDRAWAL_TRANSITION', 'This withdrawal is no longer processing.');
    }
    const providerReferenceId = result.providerReferenceId ?? attempt.provider_reference_id;
    const now = new Date();
    if (result.status === 'paid' || result.status === 'failed') {
      if (attempt.status === 'paid' || attempt.status === 'failed') {
        throw new PayoutError(409, 'TERMINAL_PAYOUT_ATTEMPT', 'This payout attempt is already terminal.');
      }
      if (result.status === 'paid') {
        const accounts = await this.lockWalletAndAccounts(client, workflow.user_id);
        const amount = Number(workflow.amount_minor);
        const projection = await client.query(`UPDATE wallets SET reserved_balance_minor=reserved_balance_minor-$2,
          version=version+1, updated_at=now() WHERE id=$1 AND reserved_balance_minor >= $2`,
        [accounts.wallet.id, amount]);
        if (projection.rowCount !== 1) throw new PayoutError(409, 'RESERVED_BALANCE_MISMATCH', 'The payout reservation could not be settled safely.');
        await client.query(`INSERT INTO wallet_ledger_entries (transaction_id,account_id,amount_minor,currency,entry_kind)
          VALUES ($1,$2,$3,'INR','settlement'),($1,$4,$5,'INR','settlement')`,
        [workflow.current_transaction_id, accounts.reserved, -amount, accounts.clearing, amount]);
        const priorResult = await client.query<{ to_status: string }>(`SELECT to_status FROM wallet_transaction_events
          WHERE transaction_id=$1 ORDER BY occurred_at DESC, id DESC LIMIT 1`, [workflow.current_transaction_id]);
        await client.query(`INSERT INTO wallet_transaction_events
          (transaction_id,event_type,from_status,to_status,actor_user_id,reason)
          VALUES ($1,'completed',$2,'completed',$3,'Payout confirmed')`,
        [workflow.current_transaction_id, priorResult.rows[0]?.to_status ?? 'pending', actorUserId]);
      } else {
        await this.releaseHold(client, workflow, actorUserId ?? workflow.user_id, 'failed', 'Payout provider confirmed failure');
      }
      await client.query(`UPDATE withdrawal_workflows SET status=$1, review_reason=$2,
        updated_at=now(), completed_at=now() WHERE withdrawal_request_id=$3`,
      [result.status, result.status === 'failed' ? 'Payout provider confirmed failure' : null, prepared.withdrawalRequestId]);
      await this.insertEvent(client, prepared.withdrawalRequestId, actorUserId, 'processing', result.status,
        result.status === 'paid' ? 'paid' : 'failed', result.status === 'failed' ? 'Payout provider confirmed failure' : null);
    } else {
      await this.insertEvent(client, prepared.withdrawalRequestId, actorUserId, 'processing', 'processing',
        action === 'provider_event' ? 'provider_event' : action === 'reconciled' ? 'reconciled' : 'processing',
        result.status === 'unknown' ? 'Provider outcome is ambiguous; reconciliation is required.' : null);
    }
    await client.query(`UPDATE payout_attempts SET status=$1, provider_reference_id=$2,
      updated_at=now(), last_reconciled_at=CASE WHEN $3 THEN now() ELSE last_reconciled_at END WHERE id=$4`,
    [result.status === 'unknown' ? 'unknown' : result.status, providerReferenceId, action === 'reconciled', prepared.payoutAttemptId]);
  }

  async recordPayoutResult(prepared: PreparedPayout, result: PayoutResult, actorUserId: string, action: 'created' | 'reconciled'): Promise<WithdrawalDetail> {
    return this.transaction(async (client) => {
      await this.applyResult(client, prepared, result, actorUserId, action);
      return this.loadDetail(client, prepared.withdrawalRequestId);
    });
  }

  async prepareReconciliation(withdrawalRequestId: string, adminUserId: string): Promise<PreparedPayout> {
    return this.transaction(async (client) => {
      const workflow = await this.lockWorkflow(client, withdrawalRequestId);
      if (workflow.status !== 'processing') throw new PayoutError(409, 'INVALID_WITHDRAWAL_TRANSITION', 'Only processing withdrawals can be reconciled.');
      const selected = await client.query<{ id: string }>(`SELECT id::text AS id FROM payout_attempts
        WHERE withdrawal_request_id=$1 AND status IN ('processing','unknown')
        ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`, [withdrawalRequestId]);
      const attemptId = selected.rows[0]?.id;
      if (!attemptId) throw new PayoutError(404, 'PAYOUT_ATTEMPT_NOT_FOUND', 'No active payout attempt can be reconciled.');
      const prepared = await this.readPrepared(client, attemptId);
      if (!prepared) throw new PayoutError(404, 'PAYOUT_ATTEMPT_NOT_FOUND', 'Payout attempt not found.');
      await client.query('UPDATE payout_attempts SET last_reconciled_at=now(), updated_at=now() WHERE id=$1', [attemptId]);
      await this.insertEvent(client, withdrawalRequestId, adminUserId, 'processing', 'processing', 'reconciled', 'Reconciliation requested.');
      return prepared;
    });
  }

  async recordWebhookEvent(event: PayoutWebhookEvent): Promise<{ readonly duplicate: boolean; readonly withdrawalRequestId: string | null }> {
    return this.transaction(async (client) => {
      const attemptResult = event.providerReferenceId
        ? await client.query<{ id: string; withdrawal_request_id: string }>(
          `SELECT id::text AS id, withdrawal_request_id::text AS withdrawal_request_id FROM payout_attempts
           WHERE provider=$1 AND provider_reference_id=$2`,
          [event.provider, event.providerReferenceId])
        : { rows: [] as Array<{ id: string; withdrawal_request_id: string }> };
      const linked = attemptResult.rows[0];
      const inserted = await client.query<{ id: string }>(`INSERT INTO payout_provider_events
        (provider,provider_event_id,payout_attempt_id,event_type,provider_reference_id,provider_status,amount_minor,currency,payload_sha256)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (provider,provider_event_id) DO NOTHING
        RETURNING id::text AS id`,
      [event.provider, event.providerEventId, linked?.id ?? null, event.eventType, event.providerReferenceId,
        event.providerStatus, event.amountMinor, event.currency, event.payloadHash]);
      if (!inserted.rows[0]) {
        const prior = await client.query<{ payload_sha256: Buffer }>(
          'SELECT payload_sha256 FROM payout_provider_events WHERE provider=$1 AND provider_event_id=$2 FOR UPDATE',
          [event.provider, event.providerEventId]);
        const digest = prior.rows[0]?.payload_sha256;
        if (!digest || digest.length !== event.payloadHash.length || !timingSafeEqual(digest, event.payloadHash)) {
          throw new PayoutError(409, 'PAYOUT_EVENT_ID_CONFLICT', 'Payout event ID was reused with different content.');
        }
        return { duplicate: true, withdrawalRequestId: linked?.withdrawal_request_id ?? null };
      }
      if (!linked) return { duplicate: false, withdrawalRequestId: null };
      const prepared = await this.readPrepared(client, linked.id);
      if (!prepared) return { duplicate: false, withdrawalRequestId: linked.withdrawal_request_id };
      const workflow = await this.lockWalletThenWorkflow(client, linked.withdrawal_request_id);
      if (workflow.status !== 'processing') return { duplicate: false, withdrawalRequestId: linked.withdrawal_request_id };
      const currentAttempt = await client.query<{ id: string; status: PayoutStatus }>(
        `SELECT id::text AS id, status FROM payout_attempts WHERE withdrawal_request_id=$1
         ORDER BY attempt_number DESC LIMIT 1`, [linked.withdrawal_request_id]);
      if (currentAttempt.rows[0]?.id !== linked.id || currentAttempt.rows[0]?.status === 'paid' || currentAttempt.rows[0]?.status === 'failed') {
        return { duplicate: false, withdrawalRequestId: linked.withdrawal_request_id };
      }
      if ((event.providerStatus === 'paid' || event.providerStatus === 'failed')
        && (event.amountMinor !== Number(workflow.amount_minor) || event.currency !== workflow.currency)) {
        await this.insertEvent(client, linked.withdrawal_request_id, null, 'processing', 'processing',
          'provider_event', 'Provider amount or currency did not match the withdrawal; reconciliation is required.');
        return { duplicate: false, withdrawalRequestId: linked.withdrawal_request_id };
      }
      const result: PayoutResult = {
        status: event.providerStatus,
        ...(event.providerReferenceId ? { providerReferenceId: event.providerReferenceId } : {})
      };
      await this.applyResult(client, prepared, result, null, 'provider_event');
      return { duplicate: false, withdrawalRequestId: linked.withdrawal_request_id };
    });
  }
}
