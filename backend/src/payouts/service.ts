import { PayoutError } from './contracts.js';
import type {
  PayoutListFilter,
  PayoutProvider,
  PayoutProviderEvent,
  PayoutRepository,
  PayoutResult,
  PayoutWebhookEvent,
  WithdrawalDetail
} from './contracts.js';

function safeResult(result: PayoutResult, amountMinor: number, currency: string): PayoutResult {
  if (!['processing', 'unknown', 'paid', 'failed'].includes(result.status)) {
    return { status: 'unknown' };
  }
  if (result.providerReferenceId !== undefined
    && (result.providerReferenceId.length < 1 || result.providerReferenceId.length > 128)) {
    return { status: 'unknown' };
  }
  if (result.status === 'paid' && !result.providerReferenceId) {
    return { status: 'unknown' };
  }
  if ((result.amountMinor !== undefined && result.amountMinor !== amountMinor)
    || (result.currency !== undefined && result.currency !== currency)) {
    return {
      status: 'unknown',
      ...(result.providerReferenceId ? { providerReferenceId: result.providerReferenceId } : {})
    };
  }
  if ((result.status === 'paid' || result.status === 'failed')
    && (result.amountMinor !== amountMinor || result.currency !== currency)) {
    return {
      status: 'unknown',
      ...(result.providerReferenceId ? { providerReferenceId: result.providerReferenceId } : {})
    };
  }
  return result;
}

export class PayoutService {
  constructor(private readonly repository: PayoutRepository, private readonly provider: PayoutProvider) {}

  list(filter: PayoutListFilter = {}) {
    return this.repository.list(filter);
  }

  get(withdrawalRequestId: string) {
    return this.repository.get(withdrawalRequestId);
  }

  listForUser(userId: string, filter: PayoutListFilter = {}) {
    return this.repository.listForUser(userId, filter);
  }

  getForUser(withdrawalRequestId: string, userId: string) {
    return this.repository.getForUser(withdrawalRequestId, userId);
  }

  approve(withdrawalRequestId: string, adminUserId: string, reason: string | null): Promise<WithdrawalDetail> {
    return this.repository.approve(withdrawalRequestId, adminUserId, reason);
  }

  reject(withdrawalRequestId: string, adminUserId: string, reason: string): Promise<WithdrawalDetail> {
    return this.repository.reject(withdrawalRequestId, adminUserId, reason);
  }

  cancel(withdrawalRequestId: string, userId: string): Promise<WithdrawalDetail> {
    return this.repository.cancel(withdrawalRequestId, userId);
  }

  async retry(withdrawalRequestId: string, adminUserId: string): Promise<WithdrawalDetail> {
    if (!this.provider.available) {
      throw new PayoutError(503, 'PAYOUT_PROVIDER_UNAVAILABLE', 'Payout provider is not configured.');
    }
    const prepared = await this.repository.preparePayout(withdrawalRequestId, adminUserId, this.provider.name);
    const request = {
      payoutAttemptId: prepared.payoutAttemptId,
      withdrawalRequestId: prepared.withdrawalRequestId,
      userId: prepared.userId,
      amountMinor: prepared.amountMinor,
      currency: prepared.currency,
      idempotencyKey: prepared.idempotencyKey
    };
    let result: PayoutResult;
    try {
      result = safeResult(await this.provider.createPayout(request), prepared.amountMinor, prepared.currency);
    } catch {
      result = { status: 'unknown' };
    }
    return this.repository.recordPayoutResult(prepared, result, adminUserId, 'created');
  }

  async reconcile(withdrawalRequestId: string, adminUserId: string): Promise<WithdrawalDetail> {
    if (!this.provider.available) {
      throw new PayoutError(503, 'PAYOUT_PROVIDER_UNAVAILABLE', 'Payout provider is not configured.');
    }
    const prepared = await this.repository.prepareReconciliation(withdrawalRequestId, adminUserId);
    const detail = await this.repository.get(withdrawalRequestId);
    const attempt = detail?.attempts.find((item) => item.payoutAttemptId === prepared.payoutAttemptId);
    let result: PayoutResult;
    try {
      result = safeResult(await this.provider.reconcile({
        payoutAttemptId: prepared.payoutAttemptId,
        withdrawalRequestId: prepared.withdrawalRequestId,
        userId: prepared.userId,
        amountMinor: prepared.amountMinor,
        currency: prepared.currency,
        idempotencyKey: prepared.idempotencyKey
      }, attempt?.providerReferenceId ?? null), prepared.amountMinor, prepared.currency);
    } catch {
      result = { status: 'unknown', ...(attempt?.providerReferenceId ? { providerReferenceId: attempt.providerReferenceId } : {}) };
    }
    return this.repository.recordPayoutResult(prepared, result, adminUserId, 'reconciled');
  }

  async handleWebhook(event: PayoutProviderEvent): Promise<{ readonly duplicate: boolean; readonly withdrawalRequestId: string | null }> {
    const input: PayoutWebhookEvent = {
      provider: this.provider.name,
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      providerReferenceId: event.providerReferenceId,
      providerStatus: event.status,
      amountMinor: event.amountMinor,
      currency: event.currency,
      payloadHash: event.payloadHash
    };
    return this.repository.recordWebhookEvent(input);
  }
}
