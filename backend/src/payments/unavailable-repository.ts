import type { NewPayment, PaymentRecord, PaymentRepository, ProviderWebhookEvent, RecordWebhookResult } from './contracts.js';
import { PaymentError } from './contracts.js';

function unavailable(): never {
  throw new PaymentError(503, 'PAYMENT_STORAGE_UNAVAILABLE', 'Payment storage is temporarily unavailable.');
}

export class UnavailablePaymentRepository implements PaymentRepository {
  async createPayment(_input: NewPayment): Promise<{ payment: PaymentRecord; replayed: boolean }> { return unavailable(); }
  async ensureProviderOrder(_paymentId: string, _createProviderOrder: () => Promise<string>): Promise<PaymentRecord> { return unavailable(); }
  async attachVerifiedPayment(_paymentId: string, _providerPaymentId: string, _providerReferenceId?: string): Promise<void> { return unavailable(); }
  async getPaymentForUser(_paymentId: string, _userId: string): Promise<PaymentRecord | null> { return unavailable(); }
  async getPaymentByProviderOrder(_providerOrderId: string): Promise<PaymentRecord | null> { return unavailable(); }
  async verifyPayment(_paymentId: string, _details: import('./contracts.js').ProviderPaymentDetails): Promise<PaymentRecord> { return unavailable(); }
  async recordWebhookEvent(_event: ProviderWebhookEvent): Promise<RecordWebhookResult> { return unavailable(); }
}
