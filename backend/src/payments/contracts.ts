export type PaymentStatus = 'created' | 'pending' | 'paid' | 'settled' | 'failed' | 'cancelled' | 'refunded';

export interface PaymentRecord {
  readonly paymentId: string;
  readonly userId: string;
  readonly provider: string;
  readonly providerOrderId: string | null;
  readonly providerPaymentId: string | null;
  readonly providerReferenceId: string | null;
  readonly walletId: string | null;
  readonly walletTransactionId: string | null;
  readonly amountMinor: number;
  readonly currency: 'INR';
  readonly status: PaymentStatus;
  readonly idempotencyKey: string;
  readonly failureCode: string | null;
  readonly reconciliationMetadata: Readonly<Record<string, string | number | boolean | null>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface NewPayment {
  readonly userId: string;
  readonly provider: string;
  readonly amountMinor: number;
  readonly currency: 'INR';
  readonly idempotencyKey: string;
}

export interface ProviderWebhookEvent {
  readonly provider: string;
  readonly providerEventId: string;
  readonly eventType: string;
  readonly providerOrderId: string | null;
  readonly providerPaymentId: string | null;
  readonly providerStatus: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly payloadHash: Buffer;
}

export interface RecordWebhookResult {
  readonly duplicate: boolean;
  readonly paymentId: string | null;
  readonly status: PaymentStatus | null;
}

export interface ProviderPaymentDetails {
  readonly providerOrderId: string;
  readonly providerPaymentId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: string;
  readonly providerReferenceId: string | null;
}

export interface PaymentRepository {
  createPayment(input: NewPayment): Promise<{ payment: PaymentRecord; replayed: boolean }>;
  ensureProviderOrder(paymentId: string, createProviderOrder: () => Promise<string>): Promise<PaymentRecord>;
  getPaymentForUser(paymentId: string, userId: string): Promise<PaymentRecord | null>;
  getPaymentByProviderOrder(providerOrderId: string): Promise<PaymentRecord | null>;
  verifyPayment(paymentId: string, details: ProviderPaymentDetails): Promise<PaymentRecord>;
  recordWebhookEvent(event: ProviderWebhookEvent, verifiedPayment?: ProviderPaymentDetails): Promise<RecordWebhookResult>;
}

export interface ProviderOrderRequest {
  readonly paymentId: string;
  readonly amountMinor: number;
  readonly currency: 'INR';
  readonly idempotencyKey: string;
}

export interface ProviderOrder {
  readonly providerOrderId: string;
}

export interface VerifyPaymentInput {
  readonly providerOrderId: string;
  readonly providerPaymentId: string;
  readonly signature: string;
}

export interface PaymentProvider {
  readonly name: string;
  readonly publicKeyId?: string;
  createOrder(input: ProviderOrderRequest): Promise<ProviderOrder>;
  verifyPayment(input: VerifyPaymentInput): boolean;
  fetchPayment(providerPaymentId: string): Promise<ProviderPaymentDetails>;
  verifyWebhook(rawBody: Buffer, signature: string | undefined): ProviderWebhookEvent;
}

export class PaymentError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = 'PaymentError';
  }
}

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  if (from === to) return true;
  if (from === 'created') return to === 'pending' || to === 'failed' || to === 'cancelled';
  if (from === 'pending') return to === 'paid' || to === 'failed' || to === 'cancelled';
  if (from === 'paid') return to === 'settled';
  if (from === 'settled') return to === 'refunded';
  return false;
}
