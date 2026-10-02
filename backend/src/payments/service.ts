import type { PaymentProvider, PaymentRecord, PaymentRepository, VerifyPaymentInput } from './contracts.js';
import { PaymentError, canTransitionPayment } from './contracts.js';

export const MAX_PAYMENT_AMOUNT_MINOR = 100_000_000;

export class PaymentService {
  constructor(
    private readonly repository: PaymentRepository,
    private readonly provider: PaymentProvider
  ) {}

  async createOrder(
    userId: string,
    amountMinor: number,
    idempotencyKey: string
  ): Promise<{ payment: PaymentRecord; checkout: { provider: string; keyId: string; orderId: string; amountMinor: number; currency: 'INR' } }> {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > MAX_PAYMENT_AMOUNT_MINOR) {
      throw new PaymentError(400, 'INVALID_AMOUNT', 'Amount must be positive whole paise and within the allowed limit.');
    }
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
      throw new PaymentError(400, 'INVALID_IDEMPOTENCY_KEY', 'A valid idempotency key is required.');
    }
    const { payment } = await this.repository.createPayment({
      userId,
      provider: this.provider.name,
      amountMinor,
      currency: 'INR',
      idempotencyKey
    });
    const ready = await this.repository.ensureProviderOrder(payment.paymentId, async () => {
      const order = await this.provider.createOrder({
        paymentId: payment.paymentId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        idempotencyKey
      });
      return order.providerOrderId;
    });
    if (!ready.providerOrderId || !this.provider.publicKeyId) {
      throw new PaymentError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Sandbox payment provider is temporarily unavailable.');
    }
    return {
      payment: ready,
      checkout: {
        provider: this.provider.name,
        keyId: this.provider.publicKeyId,
        orderId: ready.providerOrderId,
        amountMinor: ready.amountMinor,
        currency: ready.currency
      }
    };
  }

  getPayment(paymentId: string, userId: string): Promise<PaymentRecord | null> {
    return this.repository.getPaymentForUser(paymentId, userId);
  }

  async verifyPayment(paymentId: string, userId: string, input: VerifyPaymentInput): Promise<PaymentRecord> {
    const payment = await this.repository.getPaymentForUser(paymentId, userId);
    if (!payment) throw new PaymentError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
    if (!payment.providerOrderId || payment.providerOrderId !== input.providerOrderId) {
      throw new PaymentError(409, 'PAYMENT_ORDER_MISMATCH', 'Payment details do not match this order.');
    }
    if (!this.provider.verifyPayment(input)) {
      throw new PaymentError(401, 'INVALID_PAYMENT_SIGNATURE', 'Payment verification failed.');
    }
    const verified = await this.provider.fetchPayment(input.providerPaymentId);
    if (verified.providerPaymentId !== input.providerPaymentId
      || verified.providerOrderId !== payment.providerOrderId
      || verified.amountMinor !== payment.amountMinor
      || verified.currency !== payment.currency
      || verified.status !== 'captured') {
      throw new PaymentError(409, 'PAYMENT_DETAILS_MISMATCH', 'Provider payment does not match the expected order.');
    }
    return this.repository.verifyPayment(payment.paymentId, verified);
  }

  async processWebhook(rawBody: Buffer, signature: string | undefined) {
    const event = this.provider.verifyWebhook(rawBody, signature);
    if (event.eventType !== 'payment.captured' || !event.providerOrderId || !event.providerPaymentId) {
      return { received: true as const, ...await this.repository.recordWebhookEvent(event) };
    }
    const payment = await this.repository.getPaymentByProviderOrder(event.providerOrderId);
    if (!payment) return { received: true as const, ...await this.repository.recordWebhookEvent(event) };
    const verified = await this.provider.fetchPayment(event.providerPaymentId);
    if (verified.providerOrderId !== payment.providerOrderId
      || verified.providerPaymentId !== event.providerPaymentId
      || verified.amountMinor !== payment.amountMinor
      || verified.currency !== payment.currency
      || verified.status !== 'captured'
      || (event.amountMinor !== null && event.amountMinor !== verified.amountMinor)
      || (event.currency !== null && event.currency !== verified.currency)) {
      throw new PaymentError(409, 'PAYMENT_DETAILS_MISMATCH', 'Provider payment does not match the expected order.');
    }
    const result = await this.repository.recordWebhookEvent(event, verified);
    return { received: true as const, ...result };
  }
}

export function isAllowedProviderTransition(from: PaymentRecord['status'], to: PaymentRecord['status']): boolean {
  return canTransitionPayment(from, to);
}
