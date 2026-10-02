import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  PaymentProvider,
  ProviderOrder,
  ProviderOrderRequest,
  ProviderPaymentDetails,
  ProviderWebhookEvent,
  VerifyPaymentInput
} from './contracts.js';
import { PaymentError } from './contracts.js';

const RAZORPAY_API = 'https://api.razorpay.com/v1';
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;

export interface RazorpayProviderOptions {
  readonly mode: 'disabled' | 'sandbox';
  readonly keyId?: string;
  readonly keySecret?: string;
  readonly webhookSecret?: string;
  readonly fetcher?: typeof fetch;
}

function safeHexEqual(expected: Buffer, actualHex: string | undefined): boolean {
  if (!actualHex || !/^[a-fA-F0-9]{64}$/.test(actualHex)) return false;
  const actual = Buffer.from(actualHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}

function optionalString(value: unknown, maxLength = 128): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeProviderFailure(): PaymentError {
  return new PaymentError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Payment provider is temporarily unavailable.');
}

export class RazorpayPaymentProvider implements PaymentProvider {
  readonly name = 'razorpay';
  readonly publicKeyId?: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: RazorpayProviderOptions) {
    this.fetcher = options.fetcher ?? fetch;
    if (options.mode === 'sandbox' && options.keyId) this.publicKeyId = options.keyId;
  }

  async createOrder(input: ProviderOrderRequest): Promise<ProviderOrder> {
    const response = await this.request('/orders', {
      method: 'POST',
      body: JSON.stringify({
        amount: input.amountMinor,
        currency: input.currency,
        receipt: input.paymentId,
        notes: { arena_payment_id: input.paymentId }
      })
    });
    const providerOrderId = optionalString(response.id);
    const amount = Number(response.amount);
    if (!providerOrderId || amount !== input.amountMinor || response.currency !== input.currency) {
      throw safeProviderFailure();
    }
    return { providerOrderId };
  }

  verifyPayment(input: VerifyPaymentInput): boolean {
    if (this.options.mode !== 'sandbox' || !this.options.keySecret || !input.providerOrderId || !input.providerPaymentId) return false;
    const expected = createHmac('sha256', this.options.keySecret)
      .update(`${input.providerOrderId}|${input.providerPaymentId}`)
      .digest();
    return safeHexEqual(expected, input.signature);
  }

  async fetchPayment(providerPaymentId: string): Promise<ProviderPaymentDetails> {
    const response = await this.request(`/payments/${encodeURIComponent(providerPaymentId)}`, { method: 'GET' });
    const providerOrderId = optionalString(response.order_id);
    const paymentId = optionalString(response.id);
    const amountMinor = Number(response.amount);
    const currency = optionalString(response.currency);
    const status = optionalString(response.status, 64);
    if (!providerOrderId || paymentId !== providerPaymentId || !Number.isSafeInteger(amountMinor)
      || amountMinor <= 0 || !currency || !status) throw safeProviderFailure();
    return {
      providerOrderId,
      providerPaymentId: paymentId,
      amountMinor,
      currency,
      status,
      providerReferenceId: optionalString(response.invoice_id)
    };
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined): ProviderWebhookEvent {
    if (!this.options.webhookSecret) {
      throw new PaymentError(503, 'PAYMENT_WEBHOOK_UNAVAILABLE', 'Payment webhook processing is not configured.');
    }
    const expected = createHmac('sha256', this.options.webhookSecret).update(rawBody).digest();
    if (!safeHexEqual(expected, signature)) {
      throw new PaymentError(401, 'INVALID_PROVIDER_SIGNATURE', 'Payment webhook signature is invalid.');
    }

    let payload: Record<string, unknown>;
    try {
      payload = objectValue(JSON.parse(rawBody.toString('utf8')));
    } catch {
      throw new PaymentError(400, 'INVALID_PROVIDER_EVENT', 'Payment webhook payload is invalid.');
    }
    const providerEventId = optionalString(payload.id);
    const eventType = optionalString(payload.event);
    const payloadObject = objectValue(payload.payload);
    const payment = objectValue(objectValue(payloadObject.payment).entity);
    const order = objectValue(objectValue(payloadObject.order).entity);
    const amount = payment.amount ?? order.amount;
    const amountMinor = amount === undefined ? null : Number(amount);
    const currency = optionalString(payment.currency) ?? optionalString(order.currency);
    const providerStatus = optionalString(payment.status, 64) ?? optionalString(order.status, 64);
    if (!providerEventId || !eventType
      || (amountMinor !== null && (!Number.isSafeInteger(amountMinor) || amountMinor < 0))
      || (currency !== null && !/^[A-Z]{3}$/.test(currency))) {
      throw new PaymentError(400, 'INVALID_PROVIDER_EVENT', 'Payment webhook payload is invalid.');
    }
    return {
      provider: this.name,
      providerEventId,
      eventType,
      providerOrderId: optionalString(payment.order_id) ?? optionalString(order.id),
      providerPaymentId: optionalString(payment.id),
      providerStatus,
      amountMinor,
      currency,
      payloadHash: createHash('sha256').update(rawBody).digest()
    };
  }

  private async request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    if (this.options.mode !== 'sandbox' || !this.options.keyId || !this.options.keySecret) {
      throw new PaymentError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Sandbox payment provider is not configured.');
    }
    let response: Response;
    try {
      response = await this.fetcher(`${RAZORPAY_API}${path}`, {
        ...init,
        headers: {
          authorization: `Basic ${Buffer.from(`${this.options.keyId}:${this.options.keySecret}`).toString('base64')}`,
          'content-type': 'application/json',
          ...(init.headers ?? {})
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000)
      });
      const text = await response.text();
      if (!response.ok || Buffer.byteLength(text, 'utf8') > MAX_PROVIDER_RESPONSE_BYTES) throw safeProviderFailure();
      const parsed: unknown = JSON.parse(text);
      const result = objectValue(parsed);
      if (Object.keys(result).length === 0) throw safeProviderFailure();
      return result;
    } catch (error) {
      if (error instanceof PaymentError) throw error;
      throw safeProviderFailure();
    }
  }
}
