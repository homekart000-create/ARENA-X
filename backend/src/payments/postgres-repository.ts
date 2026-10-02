import { createHash, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { WalletError } from '../wallet/contracts.js';
import { WalletService } from '../wallet/service.js';
import type {
  NewPayment,
  PaymentRecord,
  PaymentRepository,
  PaymentStatus,
  ProviderPaymentDetails,
  ProviderWebhookEvent,
  RecordWebhookResult
} from './contracts.js';
import { PaymentError } from './contracts.js';

interface PaymentRow {
  id: string;
  user_id: string;
  provider: string;
  provider_order_id: string | null;
  provider_payment_id: string | null;
  provider_reference_id: string | null;
  wallet_id: string | null;
  wallet_transaction_id: string | null;
  amount_minor: string;
  currency: 'INR';
  status: PaymentStatus;
  idempotency_key: string;
  failure_code: string | null;
  reconciliation_metadata: Record<string, string | number | boolean | null>;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
  request_hash: Buffer;
}

function timestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toPayment(row: PaymentRow): PaymentRecord {
  const amountMinor = Number(row.amount_minor);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new PaymentError(503, 'PAYMENT_DATA_INVALID', 'Payment data is temporarily unavailable.');
  }
  return {
    paymentId: row.id,
    userId: row.user_id,
    provider: row.provider,
    providerOrderId: row.provider_order_id,
    providerPaymentId: row.provider_payment_id,
    providerReferenceId: row.provider_reference_id,
    walletId: row.wallet_id,
    walletTransactionId: row.wallet_transaction_id,
    amountMinor,
    currency: row.currency,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    failureCode: row.failure_code,
    reconciliationMetadata: row.reconciliation_metadata,
    createdAt: timestamp(row.created_at)!,
    updatedAt: timestamp(row.updated_at)!,
    completedAt: timestamp(row.completed_at)
  };
}

function requestHash(input: NewPayment): Buffer {
  return createHash('sha256')
    .update(JSON.stringify({
      userId: input.userId,
      provider: input.provider,
      amountMinor: input.amountMinor,
      currency: input.currency
    }))
    .digest();
}

function safeDatabaseError(error: unknown): Error {
  if (error instanceof PaymentError) return error;
  if (error instanceof WalletError) return error;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (error.code === '23505') return new PaymentError(409, 'PAYMENT_CONFLICT', 'Payment request conflicts with an existing record.');
    if (error.code === '23503' || error.code === '23514') return new PaymentError(409, 'PAYMENT_CONSTRAINT', 'Payment operation could not be applied.');
  }
  return new PaymentError(503, 'PAYMENT_STORAGE_UNAVAILABLE', 'Payment storage is temporarily unavailable.');
}

const paymentColumns = `
  id::text AS id, user_id::text AS user_id, provider, provider_order_id, provider_payment_id,
  provider_reference_id, wallet_id::text AS wallet_id, wallet_transaction_id::text AS wallet_transaction_id,
  amount_minor::text AS amount_minor, currency, status, idempotency_key, failure_code,
  reconciliation_metadata, created_at, updated_at, completed_at, request_hash`;

export class PostgresPaymentRepository implements PaymentRepository {
  constructor(
    private readonly pool: Pool,
    private readonly walletService?: WalletService
  ) {}

  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw safeDatabaseError(error);
    }
    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Keep the original safe payment error.
      }
      throw safeDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async createPayment(input: NewPayment): Promise<{ payment: PaymentRecord; replayed: boolean }> {
    return this.transaction(async (client) => {
      const hash = requestHash(input);
      const inserted = await client.query<PaymentRow>(
        `INSERT INTO payments (user_id, provider, amount_minor, currency, idempotency_key, request_hash)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id, idempotency_key) DO NOTHING
         RETURNING ${paymentColumns}`,
        [input.userId, input.provider, input.amountMinor, input.currency, input.idempotencyKey, hash]
      );
      const row = inserted.rows[0] ?? (await client.query<PaymentRow>(
        `SELECT ${paymentColumns} FROM payments
         WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE`,
        [input.userId, input.idempotencyKey]
      )).rows[0];
      if (!row) throw new PaymentError(503, 'PAYMENT_STORAGE_UNAVAILABLE', 'Payment storage is temporarily unavailable.');
      if (row.request_hash.length !== hash.length || !timingSafeEqual(row.request_hash, hash)) {
        throw new PaymentError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was used for a different payment request.');
      }
      return { payment: toPayment(row), replayed: inserted.rows.length === 0 };
    });
  }

  async ensureProviderOrder(paymentId: string, createProviderOrder: () => Promise<string>): Promise<PaymentRecord> {
    return this.transaction(async (client) => {
      const result = await client.query<PaymentRow>(
        `SELECT ${paymentColumns} FROM payments WHERE id=$1 FOR UPDATE`,
        [paymentId]
      );
      const row = result.rows[0];
      if (!row) throw new PaymentError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
      if (row.provider_order_id) return toPayment(row);
      if (row.status !== 'created') throw new PaymentError(409, 'PAYMENT_STATE_CONFLICT', 'Payment is not awaiting an order.');
      let providerOrderId: string;
      try {
        providerOrderId = await createProviderOrder();
      } catch {
        const failed = await client.query<PaymentRow>(
          `UPDATE payments SET status='failed', failure_code='PROVIDER_ORDER_FAILED',
             completed_at=now(), updated_at=now()
           WHERE id=$1 AND status='created' AND provider_order_id IS NULL
           RETURNING ${paymentColumns}`,
          [paymentId]
        );
        if (!failed.rows[0]) throw new PaymentError(409, 'PAYMENT_STATE_CONFLICT', 'Payment order could not be created.');
        return toPayment(failed.rows[0]);
      }
      if (!providerOrderId || providerOrderId.length > 128) {
        throw new PaymentError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Payment provider is temporarily unavailable.');
      }
      const updated = await client.query<PaymentRow>(
        `UPDATE payments SET provider_order_id=$2, status='pending', updated_at=now()
         WHERE id=$1 AND status='created' AND provider_order_id IS NULL
         RETURNING ${paymentColumns}`,
        [paymentId, providerOrderId]
      );
      if (!updated.rows[0]) throw new PaymentError(409, 'PAYMENT_STATE_CONFLICT', 'Payment order could not be attached.');
      return toPayment(updated.rows[0]);
    });
  }

  async getPaymentByProviderOrder(providerOrderId: string): Promise<PaymentRecord | null> {
    try {
      const result = await this.pool.query<PaymentRow>(
        `SELECT ${paymentColumns} FROM payments WHERE provider_order_id=$1`,
        [providerOrderId]
      );
      return result.rows[0] ? toPayment(result.rows[0]) : null;
    } catch (error) {
      throw safeDatabaseError(error);
    }
  }

  async verifyPayment(paymentId: string, details: ProviderPaymentDetails): Promise<PaymentRecord> {
    return this.transaction(async (client) => {
      const result = await client.query<PaymentRow>(
        `SELECT ${paymentColumns} FROM payments WHERE id=$1 FOR UPDATE`,
        [paymentId]
      );
      const payment = result.rows[0];
      if (!payment) throw new PaymentError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
      if (payment.provider_order_id !== details.providerOrderId
        || payment.amount_minor !== String(details.amountMinor)
        || payment.currency !== details.currency
        || details.status !== 'captured') {
        throw new PaymentError(409, 'PAYMENT_DETAILS_MISMATCH', 'Provider payment does not match the expected order.');
      }
      return this.settleVerifiedPayment(client, payment, details);
    });
  }

  private async settleVerifiedPayment(
    client: PoolClient,
    payment: PaymentRow,
    details: ProviderPaymentDetails
  ): Promise<PaymentRecord> {
    if (payment.status === 'settled' && payment.provider_payment_id === details.providerPaymentId
      && payment.wallet_transaction_id && payment.wallet_id) {
      return toPayment(payment);
    }
    if (payment.status === 'pending') {
      const verified = await client.query<PaymentRow>(
        `UPDATE payments SET provider_payment_id=$2, provider_reference_id=$3,
           status='paid', updated_at=now()
         WHERE id=$1 AND status='pending' AND provider_order_id=$4
           AND (provider_payment_id IS NULL OR provider_payment_id=$2)
         RETURNING ${paymentColumns}`,
        [payment.id, details.providerPaymentId, details.providerReferenceId, details.providerOrderId]
      );
      const verifiedRow = verified.rows[0];
      if (!verifiedRow) throw new PaymentError(409, 'PAYMENT_STATE_CONFLICT', 'Payment could not be verified.');
      payment = verifiedRow;
    } else if (payment.status !== 'paid' || payment.provider_payment_id !== details.providerPaymentId) {
      throw new PaymentError(409, 'PAYMENT_STATE_CONFLICT', 'Payment cannot be settled in its current state.');
    }
    if (!this.walletService) {
      throw new PaymentError(503, 'WALLET_SETTLEMENT_UNAVAILABLE', 'Wallet settlement is temporarily unavailable.');
    }
    const credit = await this.walletService.creditWithinTransaction(
      client,
      payment.user_id,
      'deposit',
      {
        amountMinor: details.amountMinor,
        idempotencyKey: `payment-credit:${payment.id}`,
        referenceId: `payment-credit:${payment.id}`,
        description: `Verified payment ${payment.id}`,
        metadata: {
          paymentId: payment.id,
          providerOrderId: details.providerOrderId,
          providerPaymentId: details.providerPaymentId
        }
      },
      payment.user_id
    );
    const settled = await client.query<PaymentRow>(
      `UPDATE payments SET wallet_id=$2, wallet_transaction_id=$3, status='settled',
         completed_at=now(), updated_at=now()
       WHERE id=$1 AND status='paid' AND provider_payment_id=$4
         AND wallet_transaction_id IS NULL
       RETURNING ${paymentColumns}`,
      [payment.id, credit.wallet.walletId, credit.transaction.transactionId, details.providerPaymentId]
    );
    if (!settled.rows[0]) throw new PaymentError(409, 'PAYMENT_STATE_CONFLICT', 'Payment settlement could not be completed.');
    return toPayment(settled.rows[0]);
  }

  async getPaymentForUser(paymentId: string, userId: string): Promise<PaymentRecord | null> {
    try {
      const result = await this.pool.query<PaymentRow>(
        `SELECT ${paymentColumns} FROM payments WHERE id=$1 AND user_id=$2`,
        [paymentId, userId]
      );
      return result.rows[0] ? toPayment(result.rows[0]) : null;
    } catch (error) {
      throw safeDatabaseError(error);
    }
  }

  async recordWebhookEvent(event: ProviderWebhookEvent, verifiedPayment?: ProviderPaymentDetails): Promise<RecordWebhookResult> {
    return this.transaction(async (client) => {
      let payment: PaymentRow | undefined;
      if (verifiedPayment) {
        const locked = await client.query<PaymentRow>(
          `SELECT ${paymentColumns} FROM payments
           WHERE provider=$1 AND provider_order_id=$2 FOR UPDATE`,
          [event.provider, verifiedPayment.providerOrderId]
        );
        payment = locked.rows[0];
        if (!payment
          || event.providerOrderId !== verifiedPayment.providerOrderId
          || event.providerPaymentId !== verifiedPayment.providerPaymentId
          || payment.amount_minor !== String(verifiedPayment.amountMinor)
          || payment.currency !== verifiedPayment.currency
          || verifiedPayment.status !== 'captured'
          || (event.amountMinor !== null && event.amountMinor !== verifiedPayment.amountMinor)
          || (event.currency !== null && event.currency !== verifiedPayment.currency)) {
          throw new PaymentError(409, 'PAYMENT_DETAILS_MISMATCH', 'Provider payment does not match the expected order.');
        }
        if (payment.status !== 'pending' && payment.status !== 'paid'
          && !(payment.status === 'settled' && payment.provider_payment_id === verifiedPayment.providerPaymentId
            && payment.wallet_transaction_id !== null)) {
          throw new PaymentError(409, 'PAYMENT_STATE_CONFLICT', 'Payment cannot be updated in its current state.');
        }
      }
      const inserted = await client.query<{ id: string; payment_id: string | null }>(
        `INSERT INTO payment_provider_events
          (provider, provider_event_id, payment_id, provider_order_id, provider_payment_id,
           event_type, provider_status, amount_minor, currency, payload_sha256)
         VALUES (
           $1,$2,
           (SELECT id FROM payments WHERE provider=$1 AND provider_order_id=$3),
           $3,$4,$5,$6,$7,$8,$9
         )
         ON CONFLICT (provider, provider_event_id) DO NOTHING
         RETURNING id::text AS id, payment_id::text AS payment_id`,
        [event.provider, event.providerEventId, event.providerOrderId, event.providerPaymentId,
          event.eventType, event.providerStatus, event.amountMinor, event.currency, event.payloadHash]
      );
      if (inserted.rows[0]) {
        if (verifiedPayment && payment) {
          const settled = await this.settleVerifiedPayment(client, payment, verifiedPayment);
          return { duplicate: false, paymentId: payment.id, status: settled.status };
        }
        return { duplicate: false, paymentId: inserted.rows[0].payment_id, status: payment?.status ?? null };
      }
      const existing = await client.query<{ payload_sha256: Buffer; payment_id: string | null }>(
        `SELECT payload_sha256, payment_id::text AS payment_id
         FROM payment_provider_events WHERE provider=$1 AND provider_event_id=$2 FOR UPDATE`,
        [event.provider, event.providerEventId]
      );
      const row = existing.rows[0];
      if (!row) throw new PaymentError(503, 'PAYMENT_STORAGE_UNAVAILABLE', 'Payment storage is temporarily unavailable.');
      if (row.payload_sha256.length !== event.payloadHash.length || !timingSafeEqual(row.payload_sha256, event.payloadHash)) {
        throw new PaymentError(409, 'PROVIDER_EVENT_CONFLICT', 'Provider event identifier was reused with different content.');
      }
      return { duplicate: true, paymentId: row.payment_id, status: payment?.status ?? null };
    });
  }
}
