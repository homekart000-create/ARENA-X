import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { AuthRepository, AuthUser, NewUserInput, StoredCredentials } from '../auth/contracts.js';
import { hashSessionToken } from '../auth/session.js';
import { buildApp } from '../app.js';
import { parseEnvironment } from '../config/env.js';
import type {
  NewPayment,
  PaymentRecord,
  PaymentRepository,
  PaymentProvider,
  ProviderOrderRequest,
  VerifyPaymentInput,
  ProviderPaymentDetails,
  ProviderWebhookEvent,
  RecordWebhookResult
} from './contracts.js';
import { PaymentError, canTransitionPayment } from './contracts.js';
import { RazorpayPaymentProvider } from './provider.js';
import { MAX_PAYMENT_AMOUNT_MINOR, PaymentService } from './service.js';

const ORIGIN = 'http://localhost:5500';
const WEBHOOK_SECRET = 'payment-test-webhook-secret';

class TestAuthRepository implements AuthRepository {
  readonly user: AuthUser = {
    userId: randomUUID(), fullName: 'Payment Test', username: 'payment-test',
    email: 'payment@example.test', avatar: null, status: 'active', role: 'user',
    createdAt: new Date().toISOString()
  };
  readonly otherUser: AuthUser = {
    ...this.user,
    userId: randomUUID(),
    username: 'payment-other',
    email: 'payment-other@example.test'
  };
  readonly token = 'test-payment-session-token';
  readonly otherToken = 'test-payment-other-session';
  private readonly sessions = [
    { hash: hashSessionToken(this.token), user: this.user },
    { hash: hashSessionToken(this.otherToken), user: this.otherUser }
  ];

  async createUser(_input: NewUserInput): Promise<AuthUser> { return this.user; }
  async findByIdentifier(_identifier: string): Promise<StoredCredentials | null> { return null; }
  async createSession(_userId: string, _tokenHash: Buffer, _expiresAt: Date): Promise<void> {}
  async findSessionUser(tokenHash: Buffer): Promise<AuthUser | null> {
    return this.sessions.find((session) =>
      tokenHash.length === session.hash.length && timingSafeEqual(tokenHash, session.hash))?.user ?? null;
  }
  async revokeSession(_tokenHash: Buffer): Promise<void> {}
}

class MemoryPaymentRepository implements PaymentRepository {
  readonly payments = new Map<string, PaymentRecord>();
  readonly events = new Map<string, ProviderWebhookEvent>();
  readonly walletCredits = new Map<string, number>();
  walletCreditCount = 0;

  async createPayment(input: NewPayment): Promise<{ payment: PaymentRecord; replayed: boolean }> {
    const existing = [...this.payments.values()].find((payment) =>
      payment.userId === input.userId && payment.idempotencyKey === input.idempotencyKey);
    if (existing) {
      if (existing.amountMinor !== input.amountMinor || existing.provider !== input.provider) {
        throw new PaymentError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was used for a different payment request.');
      }
      return { payment: existing, replayed: true };
    }
    const now = new Date().toISOString();
    const payment: PaymentRecord = {
      paymentId: randomUUID(), userId: input.userId, provider: input.provider,
      providerOrderId: null, providerPaymentId: null, providerReferenceId: null,
      walletId: null, walletTransactionId: null, amountMinor: input.amountMinor,
      currency: input.currency, status: 'created', idempotencyKey: input.idempotencyKey,
      failureCode: null, reconciliationMetadata: {}, createdAt: now, updatedAt: now, completedAt: null
    };
    this.payments.set(payment.paymentId, payment);
    return { payment, replayed: false };
  }

  async ensureProviderOrder(paymentId: string, createOrder: () => Promise<string>): Promise<PaymentRecord> {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new PaymentError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
    if (payment.providerOrderId) return payment;
    if (payment.status !== 'created') {
      throw new PaymentError(409, 'PAYMENT_STATE_CONFLICT', 'Payment is not awaiting an order.');
    }
    let providerOrderId: string;
    try {
      providerOrderId = await createOrder();
    } catch {
      const failed: PaymentRecord = {
        ...payment, status: 'failed', failureCode: 'PROVIDER_ORDER_FAILED',
        completedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      this.payments.set(paymentId, failed);
      return failed;
    }
    const updated = { ...payment, providerOrderId, status: 'pending' as const, updatedAt: new Date().toISOString() };
    this.payments.set(paymentId, updated);
    return updated;
  }

  async getPaymentByProviderOrder(providerOrderId: string): Promise<PaymentRecord | null> {
    return [...this.payments.values()].find((payment) => payment.providerOrderId === providerOrderId) ?? null;
  }

  async verifyPayment(paymentId: string, details: ProviderPaymentDetails): Promise<PaymentRecord> {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new PaymentError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
    if (payment.providerOrderId !== details.providerOrderId || payment.amountMinor !== details.amountMinor
      || payment.currency !== details.currency) throw new PaymentError(409, 'PAYMENT_DETAILS_MISMATCH', 'Mismatch.');
    if (payment.status === 'settled' && payment.providerPaymentId === details.providerPaymentId) return payment;
    if (payment.status !== 'pending' || details.status !== 'captured') {
      throw new PaymentError(409, 'PAYMENT_STATE_CONFLICT', 'Payment cannot be verified.');
    }
    this.walletCreditCount += 1;
    this.walletCredits.set(payment.userId, (this.walletCredits.get(payment.userId) ?? 0) + details.amountMinor);
    const updated = {
      ...payment, providerPaymentId: details.providerPaymentId, providerReferenceId: details.providerReferenceId,
      walletId: `wallet-${payment.userId}`, walletTransactionId: randomUUID(),
      status: 'settled' as const, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    this.payments.set(paymentId, updated);
    return updated;
  }

  async getPaymentForUser(paymentId: string, userId: string): Promise<PaymentRecord | null> {
    const payment = this.payments.get(paymentId);
    return payment?.userId === userId ? payment : null;
  }

  async recordWebhookEvent(event: ProviderWebhookEvent, verifiedPayment?: ProviderPaymentDetails): Promise<RecordWebhookResult> {
    const key = `${event.provider}:${event.providerEventId}`;
    const existing = this.events.get(key);
    if (existing) {
      if (!existing.payloadHash.equals(event.payloadHash)) {
        throw new PaymentError(409, 'PROVIDER_EVENT_CONFLICT', 'Provider event identifier was reused with different content.');
      }
      return { duplicate: true, paymentId: null, status: null };
    }
    this.events.set(key, event);
    const payment = [...this.payments.values()].find((record) =>
      record.provider === event.provider && record.providerOrderId === event.providerOrderId);
    if (verifiedPayment && payment && payment.status !== 'settled') {
      this.walletCreditCount += 1;
      this.walletCredits.set(payment.userId, (this.walletCredits.get(payment.userId) ?? 0) + verifiedPayment.amountMinor);
      const updated = {
        ...payment, providerPaymentId: verifiedPayment.providerPaymentId,
        providerReferenceId: verifiedPayment.providerReferenceId,
        walletId: `wallet-${payment.userId}`, walletTransactionId: randomUUID(), status: 'settled' as const,
        completedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      this.payments.set(payment.paymentId, updated);
    }
    return {
      duplicate: false,
      paymentId: payment?.paymentId ?? null,
      status: payment ? this.payments.get(payment.paymentId)?.status ?? payment.status : null
    };
  }
}

class FakeSandboxProvider implements PaymentProvider {
  readonly name = 'razorpay';
  readonly publicKeyId = 'rzp_test_fakekey';
  details: ProviderPaymentDetails = {
    providerOrderId: 'order_test_1', providerPaymentId: 'pay_test_1',
    amountMinor: 500, currency: 'INR', status: 'captured', providerReferenceId: null
  };
  createOrderCalls = 0;
  orderCreationFailure = false;
  constructor(
    private readonly webhookSecret: string | null = WEBHOOK_SECRET,
    private readonly enabled = true
  ) {}

  async createOrder(_input: ProviderOrderRequest) {
    if (!this.enabled) throw new PaymentError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Sandbox unavailable.');
    this.createOrderCalls += 1;
    if (this.orderCreationFailure) throw new Error('provider transport error');
    return { providerOrderId: this.details.providerOrderId };
  }
  verifyPayment(input: VerifyPaymentInput) {
    return input.signature === 'a'.repeat(64);
  }
  async fetchPayment(_providerPaymentId: string) {
    return { ...this.details };
  }
  verifyWebhook(rawBody: Buffer, signature: string | undefined): ProviderWebhookEvent {
    if (!this.webhookSecret) throw new PaymentError(503, 'PAYMENT_WEBHOOK_UNAVAILABLE', 'Webhook unavailable.');
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest();
    const actual = signature && /^[a-fA-F0-9]{64}$/.test(signature) ? Buffer.from(signature, 'hex') : Buffer.alloc(0);
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) {
      throw new PaymentError(401, 'INVALID_PROVIDER_SIGNATURE', 'Invalid signature.');
    }
    const body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    const payload = body.payload as { payment: { entity: Record<string, unknown> } };
    const entity = payload.payment.entity;
    return {
      provider: this.name,
      providerEventId: String(body.id),
      eventType: String(body.event),
      providerOrderId: String(entity.order_id),
      providerPaymentId: String(entity.id),
      providerStatus: String(entity.status),
      amountMinor: Number(entity.amount),
      currency: String(entity.currency),
      payloadHash: createHash('sha256').update(rawBody).digest()
    };
  }
}

interface PaymentHarness {
  readonly app: FastifyInstance;
  readonly auth: TestAuthRepository;
  readonly repository: MemoryPaymentRepository;
  readonly service: PaymentService;
  readonly cookie: string;
  readonly otherCookie: string;
  readonly provider: FakeSandboxProvider;
}

async function createHarness(
  context: TestContext,
  webhookSecret: string | null = WEBHOOK_SECRET,
  providerEnabled = true
): Promise<PaymentHarness> {
  const auth = new TestAuthRepository();
  const repository = new MemoryPaymentRepository();
  const provider = new FakeSandboxProvider(webhookSecret, providerEnabled);
  const config = parseEnvironment({
    NODE_ENV: 'test',
    CORS_ORIGINS: ORIGIN,
    ...(webhookSecret ? { RAZORPAY_WEBHOOK_SECRET: webhookSecret } : {})
  });
  const app = buildApp(config, auth, undefined, undefined, repository, provider);
  context.after(async () => app.close());
  const service = new PaymentService(repository, provider);
  return {
    app, auth, repository, service, provider,
    cookie: `arena_x_session=${auth.token}`,
    otherCookie: `arena_x_session=${auth.otherToken}`
  };
}

function idempotency(value: string): string {
  return `payment-test-${value.padStart(12, '0')}`;
}

function signedWebhook(payload: unknown, secret = WEBHOOK_SECRET): { body: Buffer; signature: string } {
  const body = Buffer.from(JSON.stringify(payload));
  return {
    body,
    signature: createHmac('sha256', secret).update(body).digest('hex')
  };
}

test('payment order creation requires authentication and fails safely when provider is disabled', async (context) => {
  const harness = await createHarness(context, WEBHOOK_SECRET, false);
  const unauthenticated = await harness.app.inject({
    method: 'POST', url: '/api/payments/orders', headers: { origin: ORIGIN, 'idempotency-key': idempotency('unauth') },
    payload: { amountMinor: 500 }
  });
  const disabled = await harness.app.inject({
    method: 'POST', url: '/api/payments/orders',
    headers: { cookie: harness.cookie, origin: ORIGIN, 'idempotency-key': idempotency('disabled') },
    payload: { amountMinor: 500 }
  });
  const missingIdempotencyKey = await harness.app.inject({
    method: 'POST', url: '/api/payments/orders',
    headers: { cookie: harness.cookie, origin: ORIGIN },
    payload: { amountMinor: 500 }
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(missingIdempotencyKey.statusCode, 400);
  assert.equal(disabled.statusCode, 503);
  assert.equal(disabled.json().error.code, 'PAYMENT_PROVIDER_UNAVAILABLE');
  assert.equal([...harness.repository.payments.values()][0]?.status, 'failed');
  assert.equal([...harness.repository.payments.values()][0]?.userId, harness.auth.user.userId);
  assert.equal([...harness.repository.payments.values()][0]?.walletTransactionId, null);
});

test('sandbox order route returns safe checkout data and provider failures cannot trigger duplicate orders', async (context) => {
  const harness = await createHarness(context);
  const headers = { cookie: harness.cookie, origin: ORIGIN, 'idempotency-key': idempotency('route-order') };
  const created = await harness.app.inject({
    method: 'POST', url: '/api/payments/orders', headers, payload: { amountMinor: 1250 }
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().checkout.keyId, 'rzp_test_fakekey');
  assert.equal(created.json().checkout.amountMinor, 1250);
  assert.equal(created.json().payment.status, 'pending');
  assert.equal('userId' in created.json().payment, false);
  assert.equal('idempotencyKey' in created.json().payment, false);

  harness.provider.orderCreationFailure = true;
  const failed = await harness.app.inject({
    method: 'POST', url: '/api/payments/orders',
    headers: { ...headers, 'idempotency-key': idempotency('failed-order') }, payload: { amountMinor: 1250 }
  });
  assert.equal(failed.statusCode, 503);
  assert.equal([...harness.repository.payments.values()].find((payment) =>
    payment.idempotencyKey === idempotency('failed-order'))?.status, 'failed');
  const retry = await harness.app.inject({
    method: 'POST', url: '/api/payments/orders',
    headers: { ...headers, 'idempotency-key': idempotency('failed-order') }, payload: { amountMinor: 1250 }
  });
  assert.equal(retry.statusCode, 409);
  assert.equal(harness.provider.createOrderCalls, 2);
});

test('payment order rejects invalid amounts and client-supplied identity or status', async (context) => {
  const harness = await createHarness(context);
  for (const amountMinor of [0, -1, 1.5, MAX_PAYMENT_AMOUNT_MINOR + 1]) {
    const response = await harness.app.inject({
      method: 'POST', url: '/api/payments/orders',
      headers: { cookie: harness.cookie, origin: ORIGIN, 'idempotency-key': idempotency(`invalid-${String(amountMinor)}`) },
      payload: { amountMinor }
    });
    assert.equal(response.statusCode, 400);
  }
  const forged = await harness.app.inject({
    method: 'POST', url: '/api/payments/orders',
    headers: { cookie: harness.cookie, origin: ORIGIN, 'idempotency-key': idempotency('forged') },
    payload: { amountMinor: 100, currency: 'USD', userId: randomUUID(), status: 'paid' }
  });
  assert.equal(forged.statusCode, 400);
  assert.equal(harness.repository.payments.size, 0);
});

test('payment request idempotency replays one internal record and rejects changed amounts', async (context) => {
  const harness = await createHarness(context);
  const key = idempotency('repeat');
  const first = await harness.service.createOrder(harness.auth.user.userId, 500, key);
  const replay = await harness.service.createOrder(harness.auth.user.userId, 500, key);
  assert.equal(harness.repository.payments.size, 1);
  assert.equal(first.payment.paymentId, replay.payment.paymentId);
  assert.equal(first.checkout.orderId, replay.checkout.orderId);
  assert.equal(harness.provider.createOrderCalls, 1);
  await assert.rejects(harness.service.createOrder(harness.auth.user.userId, 501, key), (error: unknown) =>
    error instanceof PaymentError && error.code === 'IDEMPOTENCY_KEY_REUSED');
  for (const amount of [Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(harness.service.createOrder(harness.auth.user.userId, amount, idempotency(`not-finite-${String(amount)}`)),
      (error: unknown) => error instanceof PaymentError && error.code === 'INVALID_AMOUNT');
  }
});

test('payment lookup is user-scoped and does not expose idempotency details', async (context) => {
  const harness = await createHarness(context);
  const recordPromise = harness.repository.createPayment({
    userId: harness.auth.user.userId, provider: 'razorpay', amountMinor: 750,
    currency: 'INR', idempotencyKey: idempotency('lookup')
  });
  const { payment } = await recordPromise;
  const owner = await harness.app.inject({
    method: 'GET', url: `/api/payments/${payment.paymentId}`, headers: { cookie: harness.cookie }
  });
  const other = await harness.app.inject({
    method: 'GET', url: `/api/payments/${payment.paymentId}`, headers: { cookie: harness.otherCookie }
  });
  assert.equal(owner.statusCode, 200);
  assert.equal(owner.body.includes(idempotency('lookup')), false);
  assert.equal(other.statusCode, 404);
});

test('owner-only verification checks order, signature, provider amount and currency before paid state', async (context) => {
  const harness = await createHarness(context);
  const order = await harness.service.createOrder(harness.auth.user.userId, 500, idempotency('verify'));
  const body = {
    providerOrderId: order.checkout.orderId,
    providerPaymentId: 'pay_test_1',
    signature: 'a'.repeat(64)
  };
  const otherUser = await harness.app.inject({
    method: 'POST', url: `/api/payments/${order.payment.paymentId}/verify`,
    headers: { cookie: harness.otherCookie, origin: ORIGIN }, payload: body
  });
  assert.equal(otherUser.statusCode, 404);

  const badSignature = await harness.app.inject({
    method: 'POST', url: `/api/payments/${order.payment.paymentId}/verify`,
    headers: { cookie: harness.cookie, origin: ORIGIN }, payload: { ...body, signature: '0'.repeat(64) }
  });
  assert.equal(badSignature.statusCode, 401);

  const wrongOrder = await harness.app.inject({
    method: 'POST', url: `/api/payments/${order.payment.paymentId}/verify`,
    headers: { cookie: harness.cookie, origin: ORIGIN }, payload: { ...body, providerOrderId: 'order_other' }
  });
  assert.equal(wrongOrder.statusCode, 409);

  harness.provider.details = { ...harness.provider.details, providerPaymentId: 'pay_other' };
  const wrongPayment = await harness.app.inject({
    method: 'POST', url: `/api/payments/${order.payment.paymentId}/verify`,
    headers: { cookie: harness.cookie, origin: ORIGIN }, payload: body
  });
  assert.equal(wrongPayment.statusCode, 409);
  harness.provider.details = { ...harness.provider.details, providerPaymentId: 'pay_test_1' };

  harness.provider.details = { ...harness.provider.details, amountMinor: 501 };
  const wrongAmount = await harness.app.inject({
    method: 'POST', url: `/api/payments/${order.payment.paymentId}/verify`,
    headers: { cookie: harness.cookie, origin: ORIGIN }, payload: body
  });
  assert.equal(wrongAmount.statusCode, 409);
  assert.equal(wrongAmount.json().error.code, 'PAYMENT_DETAILS_MISMATCH');
  assert.equal((await harness.repository.getPaymentForUser(order.payment.paymentId, harness.auth.user.userId))?.status, 'pending');

  harness.provider.details = { ...harness.provider.details, amountMinor: 500, currency: 'USD' };
  const wrongCurrency = await harness.app.inject({
    method: 'POST', url: `/api/payments/${order.payment.paymentId}/verify`,
    headers: { cookie: harness.cookie, origin: ORIGIN }, payload: body
  });
  assert.equal(wrongCurrency.statusCode, 409);
  assert.equal((await harness.repository.getPaymentForUser(order.payment.paymentId, harness.auth.user.userId))?.walletTransactionId, null);
  assert.equal(harness.repository.walletCreditCount, 0);

  harness.provider.details = { ...harness.provider.details, currency: 'INR' };
  const verified = await harness.app.inject({
    method: 'POST', url: `/api/payments/${order.payment.paymentId}/verify`,
    headers: { cookie: harness.cookie, origin: ORIGIN }, payload: body
  });
  assert.equal(verified.statusCode, 200);
  assert.equal(verified.json().payment.status, 'settled');
  assert.equal(verified.json().settlement, 'credited');
  assert.equal(verified.json().payment.providerPaymentId, 'pay_test_1');
  assert.ok((await harness.repository.getPaymentForUser(order.payment.paymentId, harness.auth.user.userId))?.walletTransactionId);
  const replay = await harness.app.inject({
    method: 'POST', url: `/api/payments/${order.payment.paymentId}/verify`,
    headers: { cookie: harness.cookie, origin: ORIGIN }, payload: body
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().payment.status, 'settled');
  assert.equal(harness.repository.walletCreditCount, 1);
  assert.equal(harness.repository.walletCredits.get(harness.auth.user.userId), 500);
});

test('webhook signature is verified and duplicate provider event is idempotent', async (context) => {
  const harness = await createHarness(context);
  const internal = await harness.service.createOrder(harness.auth.user.userId, 900, idempotency('webhook'));
  const event = {
    id: 'evt_24a_once',
    event: 'payment.captured',
    payload: { payment: { entity: {
      id: harness.provider.details.providerPaymentId,
      order_id: internal.checkout.orderId,
      amount: 900, currency: 'INR', status: 'captured'
    } } }
  };
  harness.provider.details = { ...harness.provider.details, providerOrderId: internal.checkout.orderId, amountMinor: 900 };
  const signed = signedWebhook(event);
  const invalid = await harness.app.inject({
    method: 'POST', url: '/api/payments/webhooks/razorpay',
    headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'bad-signature' },
    payload: signed.body
  });
  assert.equal(invalid.statusCode, 401);

  const headers = { 'content-type': 'application/json', 'x-razorpay-signature': signed.signature };
  const unknownOrder = signedWebhook({
    ...event,
    id: 'evt_24a_unknown',
    payload: { payment: { entity: { id: 'pay_unknown', order_id: 'order_unknown', amount: 900, currency: 'INR', status: 'captured' } } }
  });
  const unknown = await harness.app.inject({
    method: 'POST',
    url: '/api/payments/webhooks/razorpay',
    headers: { ...headers, 'x-razorpay-signature': unknownOrder.signature },
    payload: unknownOrder.body
  });
  assert.equal(unknown.statusCode, 200);
  assert.equal(unknown.json().paymentId, null);

  const amountMismatch = signedWebhook({
    ...event,
    id: 'evt_24a_amount_mismatch',
    payload: { payment: { entity: {
      id: harness.provider.details.providerPaymentId,
      order_id: internal.checkout.orderId,
      amount: 901, currency: 'INR', status: 'captured'
    } } }
  });
  const mismatch = await harness.app.inject({
    method: 'POST',
    url: '/api/payments/webhooks/razorpay',
    headers: { ...headers, 'x-razorpay-signature': amountMismatch.signature },
    payload: amountMismatch.body
  });
  assert.equal(mismatch.statusCode, 409);

  const first = await harness.app.inject({ method: 'POST', url: '/api/payments/webhooks/razorpay', headers, payload: signed.body });
  const replay = await harness.app.inject({ method: 'POST', url: '/api/payments/webhooks/razorpay', headers, payload: signed.body });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().duplicate, false);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().duplicate, true);
  assert.equal(harness.repository.events.size, 2);
  assert.equal(harness.repository.payments.size, 1);
  assert.equal((await harness.repository.getPaymentForUser(internal.payment.paymentId, harness.auth.user.userId))?.status, 'settled');
  assert.ok((await harness.repository.getPaymentForUser(internal.payment.paymentId, harness.auth.user.userId))?.walletTransactionId);
  assert.equal(harness.repository.walletCreditCount, 1);
  assert.equal(harness.repository.walletCredits.get(harness.auth.user.userId), 900);
  const conflicting = signedWebhook({
    ...event,
    payload: { payment: { entity: { id: 'pay_changed', order_id: 'order_changed', amount: 901, currency: 'INR', status: 'captured' } } }
  });
  const reusedEventId = await harness.app.inject({
    method: 'POST',
    url: '/api/payments/webhooks/razorpay',
    headers: { 'content-type': 'application/json', 'x-razorpay-signature': conflicting.signature },
    payload: conflicting.body
  });
  assert.equal(reusedEventId.statusCode, 409);
});

test('webhook endpoint fails safely when provider secret is not configured', async (context) => {
  const harness = await createHarness(context, null);
  const response = await harness.app.inject({
    method: 'POST', url: '/api/payments/webhooks/razorpay',
    headers: { 'content-type': 'application/json', 'x-razorpay-signature': '0'.repeat(64) },
    payload: Buffer.from('{"id":"evt_missing","event":"payment.captured"}')
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.includes(WEBHOOK_SECRET), false);
  assert.equal(response.body.includes('RAZORPAY_WEBHOOK_SECRET'), false);
});

test('Razorpay adapter creates only test-key orders and fetches authoritative payment details', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const provider = new RazorpayPaymentProvider({
    mode: 'sandbox',
    keyId: 'rzp_test_fake',
    keySecret: 'provider-key-secret',
    webhookSecret: WEBHOOK_SECRET,
    fetcher: async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      const result = url.endsWith('/orders')
        ? { id: 'order_test_http', amount: body?.amount, currency: body?.currency }
        : { id: 'pay_test_http', order_id: 'order_test_http', amount: 500, currency: 'INR', status: 'captured' };
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const order = await provider.createOrder({
    paymentId: randomUUID(), amountMinor: 500, currency: 'INR', idempotencyKey: idempotency('adapter')
  });
  assert.equal(order.providerOrderId, 'order_test_http');
  const payment = await provider.fetchPayment('pay_test_http');
  assert.equal(payment.providerOrderId, order.providerOrderId);
  assert.equal(payment.amountMinor, 500);
  assert.equal(payment.currency, 'INR');
  assert.equal(payment.status, 'captured');
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.url, /^https:\/\/api\.razorpay\.com\/v1\/orders$/);
  assert.equal(calls[0]!.init.redirect, 'error');
  const signature = createHmac('sha256', 'provider-key-secret')
    .update(`${order.providerOrderId}|${payment.providerPaymentId}`)
    .digest('hex');
  assert.equal(provider.verifyPayment({
    providerOrderId: order.providerOrderId, providerPaymentId: payment.providerPaymentId, signature
  }), true);
  assert.equal(provider.verifyPayment({
    providerOrderId: order.providerOrderId, providerPaymentId: payment.providerPaymentId, signature: '0'.repeat(64)
  }), false);
  const event = signedWebhook({
    id: 'evt_adapter',
    event: 'payment.captured',
    payload: { payment: { entity: {
      id: payment.providerPaymentId, order_id: payment.providerOrderId,
      amount: payment.amountMinor, currency: payment.currency, status: payment.status
    } } }
  });
  assert.equal(provider.verifyWebhook(event.body, event.signature).providerEventId, 'evt_adapter');
  assert.throws(() => provider.verifyWebhook(event.body, '0'.repeat(64)),
    (error: unknown) => error instanceof PaymentError && error.code === 'INVALID_PROVIDER_SIGNATURE');

  const disabled = new RazorpayPaymentProvider({ mode: 'disabled' });
  await assert.rejects(disabled.createOrder({
    paymentId: randomUUID(), amountMinor: 100, currency: 'INR', idempotencyKey: idempotency('adapter-disabled')
  }), (error: unknown) => error instanceof PaymentError && error.code === 'PAYMENT_PROVIDER_UNAVAILABLE');
});

test('payment state machine rejects unsafe state transitions', () => {
  assert.equal(canTransitionPayment('created', 'pending'), true);
  assert.equal(canTransitionPayment('pending', 'paid'), true);
  assert.equal(canTransitionPayment('paid', 'settled'), true);
  assert.equal(canTransitionPayment('settled', 'refunded'), true);
  assert.equal(canTransitionPayment('created', 'paid'), false);
  assert.equal(canTransitionPayment('failed', 'paid'), false);
  assert.equal(canTransitionPayment('paid', 'refunded'), false);
  assert.equal(canTransitionPayment('refunded', 'pending'), false);
});

test('sandbox mode remains disabled without credentials and rejects non-test key IDs', () => {
  const incomplete = parseEnvironment({ NODE_ENV: 'test', CORS_ORIGINS: ORIGIN, RAZORPAY_MODE: 'sandbox' });
  assert.equal(incomplete.paymentsMode, 'disabled');
  assert.throws(() => parseEnvironment({
    NODE_ENV: 'test', CORS_ORIGINS: ORIGIN, RAZORPAY_MODE: 'sandbox',
    RAZORPAY_KEY_ID: 'rzp_live_notallowed', RAZORPAY_KEY_SECRET: 'placeholder',
    RAZORPAY_WEBHOOK_SECRET: 'placeholder'
  }), /RAZORPAY_KEY_ID must be a Razorpay test key/);
});
