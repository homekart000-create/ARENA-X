import type { KycStatus } from '../kyc/contracts.js';

export type WithdrawalStatus = 'pending' | 'approved' | 'processing' | 'paid' | 'failed' | 'rejected' | 'cancelled';
export type PayoutStatus = 'processing' | 'unknown' | 'paid' | 'failed';

export interface WithdrawalSummary {
  readonly withdrawalRequestId: string;
  readonly userId: string;
  readonly amountMinor: number;
  readonly currency: 'INR';
  readonly status: WithdrawalStatus;
  readonly transactionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WithdrawalAuditEvent {
  readonly actorUserId: string;
  readonly fromStatus: WithdrawalStatus | null;
  readonly toStatus: WithdrawalStatus;
  readonly action: string;
  readonly reason: string | null;
  readonly createdAt: string;
}

export interface PayoutAttempt {
  readonly payoutAttemptId: string;
  readonly attemptNumber: number;
  readonly provider: string;
  readonly providerReferenceId: string | null;
  readonly status: PayoutStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WithdrawalDetail extends WithdrawalSummary {
  readonly reviewReason: string | null;
  readonly reviewedByUserId: string | null;
  readonly attempts: readonly PayoutAttempt[];
  readonly events: readonly WithdrawalAuditEvent[];
}

export interface PayoutListFilter {
  readonly limit?: number;
  readonly offset?: number;
  readonly status?: WithdrawalStatus;
}

export interface PreparedPayout {
  readonly payoutAttemptId: string;
  readonly withdrawalRequestId: string;
  readonly userId: string;
  readonly amountMinor: number;
  readonly currency: 'INR';
  readonly attemptNumber: number;
  readonly idempotencyKey: string;
  readonly provider: string;
}

export interface PayoutResult {
  readonly status: PayoutStatus;
  readonly providerReferenceId?: string;
  readonly amountMinor?: number;
  readonly currency?: string;
}

export interface PayoutWebhookEvent {
  readonly provider: string;
  readonly providerEventId: string;
  readonly eventType: string;
  readonly providerReferenceId: string | null;
  readonly providerStatus: PayoutStatus;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly payloadHash: Buffer;
}

export interface PayoutRepository {
  list(filter?: PayoutListFilter): Promise<readonly WithdrawalSummary[]>;
  listForUser(userId: string, filter?: PayoutListFilter): Promise<readonly WithdrawalSummary[]>;
  get(withdrawalRequestId: string): Promise<WithdrawalDetail | null>;
  getForUser(withdrawalRequestId: string, userId: string): Promise<WithdrawalDetail | null>;
  approve(withdrawalRequestId: string, adminUserId: string, reason: string | null): Promise<WithdrawalDetail>;
  reject(withdrawalRequestId: string, adminUserId: string, reason: string): Promise<WithdrawalDetail>;
  cancel(withdrawalRequestId: string, userId: string): Promise<WithdrawalDetail>;
  preparePayout(withdrawalRequestId: string, adminUserId: string, provider: string): Promise<PreparedPayout>;
  recordPayoutResult(prepared: PreparedPayout, result: PayoutResult, actorUserId: string, action: 'created' | 'reconciled'): Promise<WithdrawalDetail>;
  prepareReconciliation(withdrawalRequestId: string, adminUserId: string): Promise<PreparedPayout>;
  recordWebhookEvent(event: PayoutWebhookEvent): Promise<{ readonly duplicate: boolean; readonly withdrawalRequestId: string | null }>;
}

export class PayoutError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = 'PayoutError';
  }
}

export interface PayoutRequest {
  readonly payoutAttemptId: string;
  readonly withdrawalRequestId: string;
  readonly userId: string;
  readonly amountMinor: number;
  readonly currency: 'INR';
  readonly idempotencyKey: string;
}

export interface PayoutProviderEvent {
  readonly providerEventId: string;
  readonly eventType: string;
  readonly providerReferenceId: string | null;
  readonly status: PayoutStatus;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly payloadHash: Buffer;
}

export interface PayoutProvider {
  readonly name: string;
  readonly available: boolean;
  createPayout(request: PayoutRequest): Promise<PayoutResult>;
  getStatus(payoutReferenceId: string): Promise<PayoutResult>;
  reconcile(request: PayoutRequest, payoutReferenceId: string | null): Promise<PayoutResult>;
  verifyWebhook(rawBody: Buffer, signature: string | undefined): Promise<PayoutProviderEvent>;
}

export interface UserKycStatusReader {
  getStatus(userId: string): Promise<KycStatus | 'unverified'>;
}
