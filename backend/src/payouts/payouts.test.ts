import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { AuthRepository, AuthUser, NewUserInput, StoredCredentials } from '../auth/contracts.js';
import { hashSessionToken } from '../auth/session.js';
import { buildApp } from '../app.js';
import { parseEnvironment } from '../config/env.js';
import { PayoutError } from './contracts.js';
import type {
  PayoutAttempt,
  PayoutListFilter,
  PayoutProviderEvent,
  PayoutRepository,
  PayoutResult,
  PayoutWebhookEvent,
  PreparedPayout,
  WithdrawalAuditEvent,
  WithdrawalDetail,
  WithdrawalStatus,
  WithdrawalSummary
} from './contracts.js';
import { HmacPayoutProvider, UnavailablePayoutProvider } from './provider.js';
import type { PayoutProvider, PayoutRequest } from './contracts.js';
import { PayoutService } from './service.js';

const ORIGIN = 'http://localhost:5500';

class StatefulPayoutRepository implements PayoutRepository {
  readonly withdrawalRequestId = randomUUID();
  readonly userId = randomUUID();
  readonly originalTransactionId = randomUUID();
  availableMinor = 1500;
  reservedMinor = 500;
  private currentStatus: WithdrawalStatus = 'pending';
  private attempts: PayoutAttempt[] = [];
  private events: WithdrawalAuditEvent[] = [];
  private readonly prepared = new Map<string, PreparedPayout>();
  private readonly eventDigests = new Map<string, Buffer>();

  private detail(): WithdrawalDetail {
    return {
      withdrawalRequestId: this.withdrawalRequestId,
      userId: this.userId,
      amountMinor: 500,
      currency: 'INR',
      status: this.currentStatus,
      transactionId: this.originalTransactionId,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date().toISOString(),
      reviewReason: null,
      reviewedByUserId: null,
      attempts: this.attempts.map((attempt) => ({ ...attempt })),
      events: this.events.map((event) => ({ ...event }))
    };
  }

  private event(actorUserId: string | null, fromStatus: WithdrawalStatus | null, toStatus: WithdrawalStatus, action: string, reason: string | null = null) {
    this.events.push({
      actorUserId: actorUserId ?? 'provider',
      fromStatus,
      toStatus,
      action,
      reason,
      createdAt: new Date().toISOString()
    });
  }

  async list(filter: PayoutListFilter = {}): Promise<readonly WithdrawalSummary[]> {
    const detail = this.detail();
    return filter.status && filter.status !== detail.status ? [] : [detail];
  }
  async listForUser(userId: string, filter: PayoutListFilter = {}): Promise<readonly WithdrawalSummary[]> {
    return userId === this.userId ? this.list(filter) : [];
  }
  async get(id: string): Promise<WithdrawalDetail | null> { return id === this.withdrawalRequestId ? this.detail() : null; }
  async getForUser(id: string, userId: string): Promise<WithdrawalDetail | null> {
    return userId === this.userId ? this.get(id) : null;
  }
  async approve(id: string, adminId: string, reason: string | null): Promise<WithdrawalDetail> {
    if (id !== this.withdrawalRequestId) throw new PayoutError(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal request not found.');
    if (this.currentStatus !== 'pending') throw new PayoutError(409, 'INVALID_WITHDRAWAL_TRANSITION', 'Only pending withdrawals can be approved.');
    this.currentStatus = 'approved';
    this.event(adminId, 'pending', 'approved', 'approved', reason);
    return this.detail();
  }
  async reject(id: string, adminId: string, reason: string): Promise<WithdrawalDetail> {
    if (id !== this.withdrawalRequestId) throw new PayoutError(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal request not found.');
    if (this.currentStatus !== 'pending') throw new PayoutError(409, 'INVALID_WITHDRAWAL_TRANSITION', 'Only pending withdrawals can be rejected.');
    this.availableMinor += this.reservedMinor;
    this.reservedMinor = 0;
    this.currentStatus = 'rejected';
    this.event(adminId, 'pending', 'rejected', 'rejected', reason);
    return this.detail();
  }
  async cancel(id: string, userId: string): Promise<WithdrawalDetail> {
    if (id !== this.withdrawalRequestId || userId !== this.userId) throw new PayoutError(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal request not found.');
    if (this.currentStatus !== 'pending' && this.currentStatus !== 'approved') throw new PayoutError(409, 'INVALID_WITHDRAWAL_TRANSITION', 'Withdrawal cannot be cancelled.');
    this.availableMinor += this.reservedMinor;
    this.reservedMinor = 0;
    const previous = this.currentStatus;
    this.currentStatus = 'cancelled';
    this.event(userId, previous, 'cancelled', 'cancelled');
    return this.detail();
  }
  async preparePayout(id: string, adminId: string, provider: string): Promise<PreparedPayout> {
    if (id !== this.withdrawalRequestId) throw new PayoutError(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal request not found.');
    if (this.currentStatus !== 'approved' && this.currentStatus !== 'failed') {
      throw new PayoutError(409, 'INVALID_WITHDRAWAL_TRANSITION', 'Withdrawal is not ready for payout.');
    }
    const previous = this.currentStatus;
    const attemptNumber = this.attempts.length + 1;
    if (previous === 'failed') {
      if (this.availableMinor < 500) throw new PayoutError(409, 'INSUFFICIENT_FUNDS', 'Insufficient funds to retry.');
      this.availableMinor -= 500;
      this.reservedMinor += 500;
    }
    this.currentStatus = 'processing';
    const prepared: PreparedPayout = {
      payoutAttemptId: randomUUID(),
      withdrawalRequestId: id,
      userId: this.userId,
      amountMinor: 500,
      currency: 'INR',
      attemptNumber,
      idempotencyKey: `arena-withdrawal:${id}:${attemptNumber}`,
      provider
    };
    this.prepared.set(prepared.payoutAttemptId, prepared);
    this.attempts.push({
      payoutAttemptId: prepared.payoutAttemptId,
      attemptNumber,
      provider,
      providerReferenceId: null,
      status: 'processing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    this.event(adminId, previous, 'processing', previous === 'failed' ? 'retried' : 'processing');
    return prepared;
  }
  async recordPayoutResult(prepared: PreparedPayout, result: PayoutResult, actorUserId: string, action: 'created' | 'reconciled'): Promise<WithdrawalDetail> {
    const tracked = this.prepared.get(prepared.payoutAttemptId);
    if (!tracked || this.currentStatus !== 'processing') throw new PayoutError(409, 'INVALID_WITHDRAWAL_TRANSITION', 'Withdrawal is no longer processing.');
    const index = this.attempts.findIndex((attempt) => attempt.payoutAttemptId === prepared.payoutAttemptId);
    const previousAttempt = this.attempts[index]!;
    if (result.providerReferenceId && this.attempts.some((attempt) =>
      attempt.payoutAttemptId !== prepared.payoutAttemptId && attempt.provider === prepared.provider
        && attempt.providerReferenceId === result.providerReferenceId
    )) {
      throw new PayoutError(409, 'PAYOUT_REFERENCE_CONFLICT', 'Provider payout reference is already linked.');
    }
    this.attempts[index] = {
      ...previousAttempt, status: result.status,
      providerReferenceId: result.providerReferenceId ?? previousAttempt.providerReferenceId,
      updatedAt: new Date().toISOString()
    };
    if (result.status === 'paid') {
      this.reservedMinor -= 500;
      this.currentStatus = 'paid';
      this.event(actorUserId, 'processing', 'paid', 'paid');
    } else if (result.status === 'failed') {
      this.availableMinor += this.reservedMinor;
      this.reservedMinor = 0;
      this.currentStatus = 'failed';
      this.event(actorUserId, 'processing', 'failed', 'failed');
    } else {
      this.event(actorUserId, 'processing', 'processing', action === 'reconciled' ? 'reconciled' : 'processing');
    }
    return this.detail();
  }
  async prepareReconciliation(id: string, adminId: string): Promise<PreparedPayout> {
    if (id !== this.withdrawalRequestId || this.currentStatus !== 'processing') {
      throw new PayoutError(409, 'INVALID_WITHDRAWAL_TRANSITION', 'Only processing withdrawals can be reconciled.');
    }
    const attempt = this.attempts.at(-1);
    const prepared = attempt ? this.prepared.get(attempt.payoutAttemptId) : null;
    if (!prepared) throw new PayoutError(404, 'PAYOUT_ATTEMPT_NOT_FOUND', 'No payout attempt is available.');
    this.event(adminId, 'processing', 'processing', 'reconciled');
    return prepared;
  }
  async recordWebhookEvent(event: PayoutWebhookEvent): Promise<{ readonly duplicate: boolean; readonly withdrawalRequestId: string | null }> {
    const eventKey = `${event.provider}:${event.providerEventId}`;
    const prior = this.eventDigests.get(eventKey);
    if (prior) {
      if (prior.length !== event.payloadHash.length || !timingSafeEqual(prior, event.payloadHash)) {
        throw new PayoutError(409, 'PAYOUT_EVENT_ID_CONFLICT', 'Payout event ID was reused with different content.');
      }
      return { duplicate: true, withdrawalRequestId: this.withdrawalRequestId };
    }
    this.eventDigests.set(eventKey, Buffer.from(event.payloadHash));
    const attempt = this.attempts.find((item) => item.provider === event.provider && item.providerReferenceId === event.providerReferenceId);
    if (attempt && this.currentStatus === 'processing' && this.attempts.at(-1)?.payoutAttemptId === attempt.payoutAttemptId) {
      const prepared = this.prepared.get(attempt.payoutAttemptId)!;
      if ((event.providerStatus === 'paid' || event.providerStatus === 'failed')
        && (event.amountMinor !== 500 || event.currency !== 'INR')) {
        return { duplicate: false, withdrawalRequestId: this.withdrawalRequestId };
      }
      await this.recordPayoutResult(prepared, {
        status: event.providerStatus,
        ...(event.providerReferenceId ? { providerReferenceId: event.providerReferenceId } : {}),
        ...(event.amountMinor !== null ? { amountMinor: event.amountMinor } : {}),
        ...(event.currency ? { currency: event.currency } : {})
      }, 'provider', 'created');
    }
    return { duplicate: false, withdrawalRequestId: attempt ? this.withdrawalRequestId : null };
  }
}

class TestAuthRepository implements AuthRepository {
  private readonly users = new Map<string, AuthUser>();
  private readonly sessions = new Map<string, string>();
  addUser(role: 'user' | 'admin' = 'user', userId = randomUUID()) {
    const user: AuthUser = {
      userId, fullName: 'Test User', username: `${role}_${randomUUID().slice(0, 8)}`,
      email: `${randomUUID()}@example.test`, avatar: null, status: 'active', role, createdAt: new Date().toISOString()
    };
    const token = randomBytes(24).toString('base64url');
    this.users.set(user.userId, user);
    this.sessions.set(hashSessionToken(token).toString('hex'), user.userId);
    return { user, cookie: `arena_x_session=${token}` };
  }
  async createUser(_input: NewUserInput): Promise<AuthUser> { throw new Error('Not used by payout tests.'); }
  async findByIdentifier(_identifier: string): Promise<StoredCredentials | null> { return null; }
  async createSession(_userId: string, _tokenHash: Buffer, _expiresAt: Date): Promise<void> {}
  async findSessionUser(tokenHash: Buffer): Promise<AuthUser | null> {
    const userId = this.sessions.get(tokenHash.toString('hex'));
    return userId ? this.users.get(userId) ?? null : null;
  }
  async revokeSession(tokenHash: Buffer): Promise<void> { this.sessions.delete(tokenHash.toString('hex')); }
  async closeOwnAccount(_userId: string): Promise<boolean> { return false; }
}

async function createRouteHarness(context: TestContext, repository: StatefulPayoutRepository, provider: PayoutProvider) {
  const auth = new TestAuthRepository();
  const user = auth.addUser('user', repository.userId);
  const other = auth.addUser();
  const admin = auth.addUser('admin');
  const config = parseEnvironment({ NODE_ENV: 'test', CORS_ORIGINS: ORIGIN });
  const app = buildApp(config, auth, undefined, undefined, undefined, undefined, undefined, repository, provider);
  context.after(async () => app.close());
  return { app, user, other, admin };
}

test('unavailable payout provider never pretends to create or pay a payout', async () => {
  const repository = new StatefulPayoutRepository();
  const service = new PayoutService(repository, new UnavailablePayoutProvider());
  await service.approve(repository.withdrawalRequestId, 'admin-id', null);
  await assert.rejects(
    service.retry(repository.withdrawalRequestId, 'admin-id'),
    (error: unknown) => error instanceof PayoutError && error.code === 'PAYOUT_PROVIDER_UNAVAILABLE'
  );
  assert.equal((await repository.get(repository.withdrawalRequestId))?.status, 'approved');
  assert.equal((await repository.get(repository.withdrawalRequestId))?.attempts.length, 0);
});

test('ambiguous creation reconciles before retry; retry and successful settlement use a new hold', async () => {
  const repository = new StatefulPayoutRepository();
  const keys: string[] = [];
  let createCount = 0;
  const provider = new HmacPayoutProvider('test-provider', 'webhook-secret',
    async (request: PayoutRequest) => {
      createCount += 1;
      keys.push(request.idempotencyKey);
      throw new Error('simulated response timeout');
    },
    async () => ({ status: 'unknown' }),
    async () => ({ status: 'failed', providerReferenceId: 'ref-first', amountMinor: 500, currency: 'INR' }));
  const service = new PayoutService(repository, provider);
  await service.approve(repository.withdrawalRequestId, 'admin-id', 'reviewed');
  const uncertain = await service.retry(repository.withdrawalRequestId, 'admin-id');
  assert.equal(uncertain.status, 'processing');
  assert.equal(uncertain.attempts[0]?.status, 'unknown');
  assert.equal(repository.availableMinor, 1500);
  assert.equal(repository.reservedMinor, 500);
  await assert.rejects(service.retry(repository.withdrawalRequestId, 'admin-id'),
    (error: unknown) => error instanceof PayoutError && error.code === 'INVALID_WITHDRAWAL_TRANSITION');
  assert.equal(createCount, 1);

  const failed = await service.reconcile(repository.withdrawalRequestId, 'admin-id');
  assert.equal(failed.status, 'failed');
  assert.equal(repository.availableMinor, 2000);
  assert.equal(repository.reservedMinor, 0);
  const paidProvider = new HmacPayoutProvider('test-provider', 'webhook-secret',
    async (request) => {
      keys.push(request.idempotencyKey);
      return { status: 'paid', providerReferenceId: 'ref-second', amountMinor: 500, currency: 'INR' };
    },
    async () => ({ status: 'unknown' }),
    async () => ({ status: 'unknown' }));
  const paid = await new PayoutService(repository, paidProvider).retry(repository.withdrawalRequestId, 'admin-id');
  assert.equal(paid.status, 'paid');
  assert.equal(repository.availableMinor, 1500);
  assert.equal(repository.reservedMinor, 0);
  assert.equal(paid.attempts.length, 2);
  assert.notEqual(keys[0], keys[1]);
  await assert.rejects(new PayoutService(repository, paidProvider).retry(repository.withdrawalRequestId, 'admin-id'),
    (error: unknown) => error instanceof PayoutError && error.code === 'INVALID_WITHDRAWAL_TRANSITION');
});

test('withdrawal rejection releases reservation and terminal state cannot be mutated', async () => {
  const repository = new StatefulPayoutRepository();
  const rejected = await repository.reject(repository.withdrawalRequestId, 'admin-id', 'Manual rejection');
  assert.equal(rejected.status, 'rejected');
  assert.equal(repository.availableMinor, 2000);
  assert.equal(repository.reservedMinor, 0);
  await assert.rejects(repository.approve(repository.withdrawalRequestId, 'admin-id', null),
    (error: unknown) => error instanceof PayoutError && error.statusCode === 409);

  const cancelledRepository = new StatefulPayoutRepository();
  const cancelled = await cancelledRepository.cancel(cancelledRepository.withdrawalRequestId, cancelledRepository.userId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelledRepository.availableMinor, 2000);
  assert.equal(cancelledRepository.reservedMinor, 0);
});

test('webhook HMAC rejects forgeries; event replay is idempotent and conflicting event IDs fail', async () => {
  const repository = new StatefulPayoutRepository();
  const calls: PayoutRequest[] = [];
  const provider = new HmacPayoutProvider('test-provider', 'webhook-secret',
    async (request) => {
      calls.push(request);
      return { status: 'processing', providerReferenceId: 'provider-ref-1' };
    },
    async () => ({ status: 'unknown' }),
    async () => ({ status: 'unknown' }));
  const service = new PayoutService(repository, provider);
  await service.approve(repository.withdrawalRequestId, 'admin-id', null);
  await service.retry(repository.withdrawalRequestId, 'admin-id');
  const body = Buffer.from(JSON.stringify({
    id: 'event-one', event: 'payout.processed', payload: { payout: { entity: {
      id: 'provider-ref-1', status: 'paid', amount: 500, currency: 'INR'
    } } }
  }));
  const signature = createHmac('sha256', 'webhook-secret').update(body).digest('hex');
  await assert.rejects(provider.verifyWebhook(body, '0'.repeat(64)),
    (error: unknown) => error instanceof PayoutError && error.statusCode === 401);
  const event = await provider.verifyWebhook(body, signature);
  assert.equal(event.status, 'paid');
  const first = await service.handleWebhook(event);
  const replay = await service.handleWebhook(event);
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal((await repository.get(repository.withdrawalRequestId))?.status, 'paid');
  assert.equal(calls.length, 1);
  await assert.rejects(service.handleWebhook({ ...event, payloadHash: Buffer.alloc(32, 9) }),
    (error: unknown) => error instanceof PayoutError && error.code === 'PAYOUT_EVENT_ID_CONFLICT');
});

test('provider result with mismatched amount is left for reconciliation and provider references are unique', async () => {
  const repository = new StatefulPayoutRepository();
  const failedProvider = new HmacPayoutProvider('test-provider', 'webhook-secret',
    async () => ({ status: 'failed', providerReferenceId: 'reference-used', amountMinor: 500, currency: 'INR' }),
    async () => ({ status: 'unknown' }),
    async () => ({ status: 'failed', providerReferenceId: 'reference-used', amountMinor: 500, currency: 'INR' }));
  const service = new PayoutService(repository, failedProvider);
  await service.approve(repository.withdrawalRequestId, 'admin-id', null);
  const failed = await service.retry(repository.withdrawalRequestId, 'admin-id');
  assert.equal(failed.status, 'failed');
  const paidWithMismatch = new HmacPayoutProvider('test-provider', 'webhook-secret',
    async () => ({ status: 'paid', providerReferenceId: 'new-reference', amountMinor: 499, currency: 'INR' }),
    async () => ({ status: 'unknown' }),
    async () => ({ status: 'unknown' }));
  const uncertain = await new PayoutService(repository, paidWithMismatch).retry(repository.withdrawalRequestId, 'admin-id');
  assert.equal(uncertain.status, 'processing');
  assert.equal(uncertain.attempts.at(-1)?.status, 'unknown');

  const conflictRepo = new StatefulPayoutRepository();
  await conflictRepo.approve(conflictRepo.withdrawalRequestId, 'admin-id', null);
  await new PayoutService(conflictRepo, failedProvider).retry(conflictRepo.withdrawalRequestId, 'admin-id');
  const sameReferenceProvider = new HmacPayoutProvider('test-provider', 'webhook-secret',
    async () => ({ status: 'paid', providerReferenceId: 'reference-used', amountMinor: 500, currency: 'INR' }),
    async () => ({ status: 'unknown' }),
    async () => ({ status: 'unknown' }));
  await assert.rejects(new PayoutService(conflictRepo, sameReferenceProvider).retry(conflictRepo.withdrawalRequestId, 'admin-id'),
    (error: unknown) => error instanceof PayoutError && error.code === 'PAYOUT_REFERENCE_CONFLICT');
});

test('user withdrawal API is owner-scoped and admin mutations require admin role', async (context) => {
  const repository = new StatefulPayoutRepository();
  const provider = new UnavailablePayoutProvider();
  const { app, user, other, admin } = await createRouteHarness(context, repository, provider);
  const own = await app.inject({
    method: 'GET', url: `/api/wallet/withdrawal-requests/${repository.withdrawalRequestId}`,
    headers: { cookie: user.cookie }
  });
  const idor = await app.inject({
    method: 'GET', url: `/api/wallet/withdrawal-requests/${repository.withdrawalRequestId}`,
    headers: { cookie: other.cookie }
  });
  const nonAdmin = await app.inject({
    method: 'POST', url: `/api/admin/withdrawals/${repository.withdrawalRequestId}/approve`,
    headers: { cookie: user.cookie, origin: ORIGIN }, payload: {}
  });
  const forgedStatus = await app.inject({
    method: 'POST', url: `/api/admin/withdrawals/${repository.withdrawalRequestId}/approve`,
    headers: { cookie: admin.cookie, origin: ORIGIN }, payload: { status: 'paid' }
  });
  assert.equal(own.statusCode, 200);
  assert.equal(own.json().withdrawal.status, 'pending');
  assert.equal(Object.hasOwn(own.json().withdrawal, 'attempts'), false);
  assert.equal(idor.statusCode, 404);
  assert.equal(nonAdmin.statusCode, 403);
  assert.equal(forgedStatus.statusCode, 400);
});

test('webhook route verifies provider signature and uses raw body', async (context) => {
  const repository = new StatefulPayoutRepository();
  const provider = new HmacPayoutProvider('test-provider', 'webhook-secret',
    async () => ({ status: 'unknown' }), async () => ({ status: 'unknown' }),
    async () => ({ status: 'unknown' }));
  const { app } = await createRouteHarness(context, repository, provider);
  const body = JSON.stringify({
    id: 'forged-event', event: 'payout.processed', payload: { payout: { entity: { id: 'any-ref', status: 'paid' } } }
  });
  const forged = await app.inject({
    method: 'POST', url: '/api/payouts/webhooks/test-provider',
    headers: { 'content-type': 'application/json', 'x-payout-signature': '0'.repeat(64) }, payload: body
  });
  assert.equal(forged.statusCode, 401);
});
