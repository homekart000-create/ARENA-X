import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { AuthRepository, AuthUser, NewUserInput, StoredCredentials } from '../auth/contracts.js';
import { buildApp } from '../app.js';
import { parseEnvironment } from '../config/env.js';
import { hashSessionToken } from '../auth/session.js';
import { InMemoryKycRepository } from './in-memory-repository.js';

const ORIGIN = 'http://localhost:5500';

class TestAuthRepository implements AuthRepository {
  private readonly users = new Map<string, AuthUser>();
  private readonly sessions = new Map<string, string>();

  addUser(role: 'user' | 'admin' = 'user'): { readonly user: AuthUser; readonly cookie: string } {
    const user: AuthUser = {
      userId: randomUUID(), fullName: `Test ${role}`, username: `${role}_${randomUUID().slice(0, 8)}`,
      email: `${randomUUID()}@example.test`, avatar: null, status: 'active', role, createdAt: new Date().toISOString()
    };
    const token = randomBytes(24).toString('base64url');
    this.users.set(user.userId, user);
    this.sessions.set(hashSessionToken(token).toString('hex'), user.userId);
    return { user, cookie: `arena_x_session=${token}` };
  }

  async createUser(_input: NewUserInput): Promise<AuthUser> { throw new Error('Not used by KYC tests.'); }
  async findByIdentifier(_identifier: string): Promise<StoredCredentials | null> { return null; }
  async createSession(_userId: string, _tokenHash: Buffer, _expiresAt: Date): Promise<void> {}
  async findSessionUser(tokenHash: Buffer): Promise<AuthUser | null> {
    const userId = this.sessions.get(tokenHash.toString('hex'));
    return userId ? this.users.get(userId) ?? null : null;
  }
  async revokeSession(tokenHash: Buffer): Promise<void> { this.sessions.delete(tokenHash.toString('hex')); }
}

interface Harness {
  readonly app: FastifyInstance;
  readonly auth: TestAuthRepository;
  readonly kyc: InMemoryKycRepository;
}

async function createHarness(context: TestContext): Promise<Harness> {
  const config = parseEnvironment({ NODE_ENV: 'test', CORS_ORIGINS: ORIGIN });
  const auth = new TestAuthRepository();
  const kyc = new InMemoryKycRepository();
  const app = buildApp(config, auth, undefined, undefined, undefined, undefined, kyc);
  context.after(async () => app.close());
  return { app, auth, kyc };
}

test('KYC API is authenticated, session-owned, and excludes client status and provider control fields', async (context) => {
  const { app, auth } = await createHarness(context);
  const user = auth.addUser();
  const other = auth.addUser();
  const unauthenticated = await app.inject({ method: 'GET', url: '/api/kyc' });
  const missing = await app.inject({ method: 'GET', url: '/api/kyc', headers: { cookie: user.cookie } });
  const submitted = await app.inject({
    method: 'POST', url: '/api/kyc',
    headers: { cookie: user.cookie, origin: ORIGIN },
    payload: { legalName: 'KYC User', country: 'India', dateOfBirth: '1995-02-03' }
  });
  const otherProfile = await app.inject({ method: 'GET', url: '/api/kyc', headers: { cookie: other.cookie } });
  const forged = await app.inject({
    method: 'PATCH', url: '/api/kyc',
    headers: { cookie: user.cookie, origin: ORIGIN },
    payload: { status: 'verified', reviewedByUserId: other.user.userId, verificationReference: 'forged' }
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(missing.statusCode, 200);
  assert.equal(missing.json().kyc.status, 'unverified');
  assert.equal(submitted.statusCode, 200);
  assert.equal(submitted.json().kyc.status, 'pending');
  assert.equal(submitted.json().kyc.userId, user.user.userId);
  assert.equal(Object.hasOwn(submitted.json().kyc, 'reviewedByUserId'), false);
  assert.equal(otherProfile.json().kyc.status, 'unverified');
  assert.equal(otherProfile.json().kyc.userId, other.user.userId);
  assert.equal(forged.statusCode, 400);
});

test('KYC admin review is role-gated, transition-controlled, and auditable', async (context) => {
  const { app, auth, kyc } = await createHarness(context);
  const user = auth.addUser();
  const normal = auth.addUser();
  const admin = auth.addUser('admin');
  await kyc.createOrUpdate(user.user.userId, { legalName: 'Private Name', country: 'India', dateOfBirth: '1990-01-01', status: 'pending' });

  const deniedList = await app.inject({ method: 'GET', url: '/api/admin/kyc', headers: { cookie: normal.cookie } });
  const deniedReview = await app.inject({
    method: 'POST', url: `/api/admin/kyc/${user.user.userId}/review`,
    headers: { cookie: normal.cookie, origin: ORIGIN }, payload: { status: 'verified' }
  });
  const listed = await app.inject({ method: 'GET', url: '/api/admin/kyc', headers: { cookie: admin.cookie } });
  const decision = await app.inject({
    method: 'POST', url: `/api/admin/kyc/${user.user.userId}/review`,
    headers: { cookie: admin.cookie, origin: ORIGIN }, payload: { status: 'verified', reason: 'Provider review complete' }
  });
  const audit = await app.inject({
    method: 'GET', url: `/api/admin/kyc/${user.user.userId}/audit`, headers: { cookie: admin.cookie }
  });
  const forgedTransition = await app.inject({
    method: 'POST', url: `/api/admin/kyc/${user.user.userId}/review`,
    headers: { cookie: admin.cookie, origin: ORIGIN }, payload: { status: 'rejected', reason: 'invalid transition' }
  });

  assert.equal(deniedList.statusCode, 403);
  assert.equal(deniedReview.statusCode, 403);
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().kyc[0].userId, user.user.userId);
  assert.equal(Object.hasOwn(listed.json().kyc[0], 'legalName'), false);
  assert.equal(decision.statusCode, 200);
  assert.equal(decision.json().kyc.status, 'verified');
  assert.equal(decision.json().kyc.reviewedByUserId, admin.user.userId);
  assert.ok(decision.json().kyc.reviewedAt);
  assert.equal(audit.json().auditEvents.length, 2);
  assert.equal(audit.json().auditEvents[1].actorUserId, admin.user.userId);
  assert.equal(audit.json().auditEvents[1].reason, 'Provider review complete');
  assert.equal(forgedTransition.statusCode, 409);
});

test('KYC review requires a rejection reason; rejected users can resubmit but cannot edit verified profiles', async (context) => {
  const { app, auth } = await createHarness(context);
  const user = auth.addUser();
  const admin = auth.addUser('admin');
  await app.inject({
    method: 'POST', url: '/api/kyc', headers: { cookie: user.cookie, origin: ORIGIN },
    payload: { legalName: 'Pending User' }
  });
  const rejectWithoutReason = await app.inject({
    method: 'POST', url: `/api/admin/kyc/${user.user.userId}/review`,
    headers: { cookie: admin.cookie, origin: ORIGIN }, payload: { status: 'rejected' }
  });
  const rejected = await app.inject({
    method: 'POST', url: `/api/admin/kyc/${user.user.userId}/review`,
    headers: { cookie: admin.cookie, origin: ORIGIN }, payload: { status: 'rejected', reason: 'Data mismatch' }
  });
  const ownerApprove = await app.inject({
    method: 'PATCH', url: '/api/kyc', headers: { cookie: user.cookie, origin: ORIGIN },
    payload: { legalName: 'Changed' }
  });
  const approve = await app.inject({
    method: 'POST', url: `/api/admin/kyc/${user.user.userId}/review`,
    headers: { cookie: admin.cookie, origin: ORIGIN }, payload: { status: 'verified' }
  });
  const editVerified = await app.inject({
    method: 'PATCH', url: '/api/kyc', headers: { cookie: user.cookie, origin: ORIGIN },
    payload: { legalName: 'Changed again' }
  });
  assert.equal(rejectWithoutReason.statusCode, 400);
  assert.equal(rejected.json().kyc.rejectionReason, 'Data mismatch');
  assert.equal(ownerApprove.statusCode, 200);
  assert.equal(ownerApprove.json().kyc.status, 'pending');
  assert.equal(approve.statusCode, 200);
  assert.equal(editVerified.statusCode, 409);
});

test('withdrawal and payout environment configuration fails closed', () => {
  assert.equal(parseEnvironment({ NODE_ENV: 'production', CORS_ORIGINS: ORIGIN }).withdrawalKycRequired, true);
  assert.throws(() => parseEnvironment({
    NODE_ENV: 'production', CORS_ORIGINS: ORIGIN, WITHDRAWAL_KYC_REQUIRED: 'false'
  }), /cannot be false in production/);
  assert.throws(() => parseEnvironment({ NODE_ENV: 'test', MINIMUM_WITHDRAWAL_MINOR: '400', MAXIMUM_WITHDRAWAL_MINOR: '300' }));
  assert.throws(() => parseEnvironment({ NODE_ENV: 'test', PAYOUT_MODE: 'live' }), /must be disabled/);
});
