import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { PayoutError } from './contracts.js';
import type { PayoutProvider, PayoutProviderEvent, PayoutRequest, PayoutResult } from './contracts.js';

function safeHexEqual(expected: Buffer, actualHex: string | undefined): boolean {
  if (!actualHex || !/^[a-fA-F0-9]{64}$/.test(actualHex)) return false;
  const actual = Buffer.from(actualHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export class UnavailablePayoutProvider implements PayoutProvider {
  readonly name = 'unavailable';
  readonly available = false;

  async createPayout(_request: PayoutRequest): Promise<PayoutResult> {
    throw new PayoutError(503, 'PAYOUT_PROVIDER_UNAVAILABLE', 'Payout provider is not configured.');
  }

  async getStatus(_payoutReferenceId: string): Promise<PayoutResult> {
    throw new PayoutError(503, 'PAYOUT_PROVIDER_UNAVAILABLE', 'Payout provider is not configured.');
  }

  async reconcile(_request: PayoutRequest, _payoutReferenceId: string | null): Promise<PayoutResult> {
    throw new PayoutError(503, 'PAYOUT_PROVIDER_UNAVAILABLE', 'Payout provider is not configured.');
  }

  async verifyWebhook(_rawBody: Buffer, _signature: string | undefined): Promise<PayoutProviderEvent> {
    throw new PayoutError(503, 'PAYOUT_PROVIDER_UNAVAILABLE', 'Payout webhook processing is not configured.');
  }
}

export class HmacPayoutProvider implements PayoutProvider {
  readonly available = true;

  constructor(
    readonly name: string,
    private readonly webhookSecret: string,
    private readonly create: (request: PayoutRequest) => Promise<PayoutResult>,
    private readonly status: (reference: string) => Promise<PayoutResult>,
    private readonly reconcileRequest: (request: PayoutRequest, reference: string | null) => Promise<PayoutResult>
  ) {
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(name)) {
      throw new PayoutError(400, 'INVALID_PAYOUT_PROVIDER', 'Payout provider name is invalid.');
    }
    if (!webhookSecret) {
      throw new PayoutError(503, 'PAYOUT_WEBHOOK_UNAVAILABLE', 'Payout webhook verification is not configured.');
    }
  }

  createPayout(request: PayoutRequest): Promise<PayoutResult> {
    return this.create(request);
  }

  getStatus(payoutReferenceId: string): Promise<PayoutResult> {
    return this.status(payoutReferenceId);
  }

  reconcile(request: PayoutRequest, payoutReferenceId: string | null): Promise<PayoutResult> {
    return this.reconcileRequest(request, payoutReferenceId);
  }

  async verifyWebhook(rawBody: Buffer, signature: string | undefined): Promise<PayoutProviderEvent> {
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest();
    if (!safeHexEqual(expected, signature)) {
      throw new PayoutError(401, 'INVALID_PAYOUT_SIGNATURE', 'Payout webhook signature is invalid.');
    }
    let payload: Record<string, unknown>;
    try {
      payload = objectValue(JSON.parse(rawBody.toString('utf8')));
    } catch {
      throw new PayoutError(400, 'INVALID_PAYOUT_EVENT', 'Payout webhook payload is invalid.');
    }
    const eventId = payload.id;
    const eventType = payload.event;
    const entity = objectValue(objectValue(payload.payload).payout);
    const payout = objectValue(entity.entity);
    const status = payout.status;
    const reference = payout.id;
    const amountMinor = payout.amount === undefined ? null : Number(payout.amount);
    const currency = typeof payout.currency === 'string' ? payout.currency : null;
    const payoutStatus = ['processing', 'unknown', 'paid', 'failed']
      .find((candidate): candidate is PayoutProviderEvent['status'] => candidate === status);
    if (typeof eventId !== 'string' || eventId.length < 1 || eventId.length > 128
      || typeof eventType !== 'string' || eventType.length < 1 || eventType.length > 128
      || !payoutStatus
      || (reference !== undefined && (typeof reference !== 'string' || reference.length > 128))
      || (amountMinor !== null && (!Number.isSafeInteger(amountMinor) || amountMinor < 0))
      || (currency !== null && !/^[A-Z]{3}$/.test(currency))) {
      throw new PayoutError(400, 'INVALID_PAYOUT_EVENT', 'Payout webhook payload is invalid.');
    }
    return {
      providerEventId: eventId,
      eventType,
      providerReferenceId: typeof reference === 'string' ? reference : null,
      status: payoutStatus,
      amountMinor,
      currency,
      payloadHash: createHash('sha256').update(rawBody).digest()
    };
  }
}
