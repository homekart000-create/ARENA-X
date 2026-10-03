import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { AppConfig } from '../config/env.js';
import { parseEnvironment } from '../config/env.js';
import { buildApp } from '../app.js';
import { PostgresAuthRepository } from './postgres-repository.js';
import { createRequireAuth, requireAdmin } from './middleware.js';
import type {
  AuthRepository,
  AuthUser,
  NewUserInput,
  StoredCredentials
} from './contracts.js';
import { DuplicateAccountError } from './contracts.js';
import { verifyPassword } from './password.js';

const validAccount = {
  fullName: 'Test Player',
  username: 'test_player',
  email: 'player@example.test',
  password: 'correct horse battery staple'
};

class MemoryAuthRepository implements AuthRepository {
  private readonly users = new Map<string, StoredCredentials>();
  private readonly sessions = new Map<string, { userId: string; expiresAt: Date; revoked: boolean }>();
  private readonly linkedData = new Map<string, {
    walletBalanceMinor: number;
    walletTransactions: readonly string[];
    ledgerEntries: readonly string[];
    tournamentRecords: readonly string[];
    auditEvents: readonly string[];
    kycProfile: { legalName: string | null; dateOfBirth: string | null; verificationReference: string | null };
  }>();

  async createUser(input: NewUserInput): Promise<AuthUser> {
    const existing = [...this.users.values()].some(({ user }) =>
      user.username.toLowerCase() === input.username.toLowerCase() || user.email.toLowerCase() === input.email.toLowerCase()
    );
    if (existing) throw new DuplicateAccountError();

    const user: AuthUser = {
      userId: randomUUID(),
      fullName: input.fullName,
      username: input.username,
      email: input.email,
      avatar: input.avatar,
      status: 'active',
      role: 'user',
      createdAt: new Date().toISOString()
    };
    this.users.set(user.userId, { user, passwordHash: input.passwordHash });
    this.linkedData.set(user.userId, {
      walletBalanceMinor: 1250,
      walletTransactions: ['wallet-transaction'],
      ledgerEntries: ['ledger-entry'],
      tournamentRecords: ['registration', 'match-result'],
      auditEvents: ['kyc-audit', 'withdrawal-event'],
      kycProfile: { legalName: 'Test Legal Name', dateOfBirth: '1990-01-01', verificationReference: 'kyc-reference' }
    });
    return user;
  }

  async findByIdentifier(identifier: string): Promise<StoredCredentials | null> {
    return [...this.users.values()].find(({ user }) =>
      user.username.toLowerCase() === identifier.toLowerCase() || user.email.toLowerCase() === identifier.toLowerCase()
    ) ?? null;
  }

  async createSession(userId: string, tokenHash: Buffer, expiresAt: Date): Promise<void> {
    this.sessions.set(tokenHash.toString('hex'), { userId, expiresAt, revoked: false });
  }

  async findSessionUser(tokenHash: Buffer): Promise<AuthUser | null> {
    const session = this.sessions.get(tokenHash.toString('hex'));
    if (!session || session.revoked || session.expiresAt <= new Date()) return null;
    return this.users.get(session.userId)?.user.status === 'active' ? this.users.get(session.userId)!.user : null;
  }

  async revokeSession(tokenHash: Buffer): Promise<void> {
    const session = this.sessions.get(tokenHash.toString('hex'));
    if (session) session.revoked = true;
  }

  async closeOwnAccount(userId: string): Promise<boolean> {
    const record = this.users.get(userId);
    if (!record || record.user.status !== 'active') return false;

    for (const session of this.sessions.values()) {
      if (session.userId === userId) session.revoked = true;
    }

    const closedUser: AuthUser = {
      ...record.user,
      fullName: 'Deleted player',
      username: `deleted_${userId.replaceAll('-', '').slice(0, 12)}`,
      email: `deleted+${userId}@deleted.invalid`,
      avatar: null,
      status: 'closed'
    };
    this.users.set(userId, { user: closedUser, passwordHash: '' });
    const data = this.linkedData.get(userId);
    if (data) {
      this.linkedData.set(userId, {
        ...data,
        kycProfile: { legalName: null, dateOfBirth: null, verificationReference: null }
      });
    }
    return true;
  }

  setStatus(identifier: string, status: string): void {
    const record = [...this.users.entries()].find(([, credentials]) =>
      credentials.user.email === identifier || credentials.user.username === identifier
    );
    if (!record) throw new Error('Test user was not found.');
    const [userId, credentials] = record;
    this.users.set(userId, { ...credentials, user: { ...credentials.user, status } });
  }

  storedCredentials(identifier: string): StoredCredentials | undefined {
    return [...this.users.values()].find(({ user }) => user.email === identifier || user.username === identifier);
  }

  userById(userId: string): AuthUser | undefined {
    return this.users.get(userId)?.user;
  }

  linkedDataFor(userId: string) {
    return this.linkedData.get(userId);
  }

  activeSessionCount(userId: string): number {
    return [...this.sessions.values()].filter((session) => session.userId === userId && !session.revoked).length;
  }

  get size(): number {
    return this.users.size;
  }
}

interface TestServer {
  readonly app: FastifyInstance;
  readonly repository: MemoryAuthRepository;
}

async function createTestServer(context: TestContext): Promise<TestServer> {
  const config: AppConfig = parseEnvironment({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3000',
    CORS_ORIGINS: 'http://localhost:5500'
  });
  const repository = new MemoryAuthRepository();
  const app = buildApp(config, repository);
  app.get('/test/admin', {
    preHandler: [createRequireAuth(repository, config), requireAdmin]
  }, async () => ({ authorized: true }));
  context.after(async () => app.close());
  return { app, repository };
}

async function register(app: FastifyInstance, body: object = validAccount) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: 'http://localhost:5500' },
    payload: body
  });
}

function sessionCookie(response: { headers: { 'set-cookie'?: unknown } }): string {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') throw new Error('Expected an authentication cookie.');
  const cookie = value.split(';', 1)[0];
  if (!cookie) throw new Error('Expected an authentication cookie.');
  return cookie;
}

test('registers a valid user and establishes an HTTP-only session', async (context) => {
  const { app } = await createTestServer(context);
  const response = await register(app);
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().user.username, validAccount.username);
  assert.match(String(response.headers['set-cookie']), /HttpOnly/i);
});

test('rejects invalid registration input', async (context) => {
  const { app, repository } = await createTestServer(context);
  const response = await register(app, { ...validAccount, email: 'not-an-email' });
  assert.equal(response.statusCode, 400);
  assert.equal(repository.size, 0);
});

test('rejects duplicate email or username', async (context) => {
  const { app } = await createTestServer(context);
  assert.equal((await register(app)).statusCode, 201);
  const duplicate = await register(app, { ...validAccount, username: 'other_player' });
  assert.equal(duplicate.statusCode, 409);
});

test('stores only an Argon2id password hash', async (context) => {
  const { app, repository } = await createTestServer(context);
  await register(app);
  const stored = repository.storedCredentials(validAccount.email);
  assert.ok(stored);
  assert.notEqual(stored.passwordHash, validAccount.password);
  assert.match(stored.passwordHash, /^\$argon2id\$/);
  assert.equal(await verifyPassword(stored.passwordHash, validAccount.password), true);
});

test('logs in with valid email and password', async (context) => {
  const { app } = await createTestServer(context);
  await register(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: 'http://localhost:5500' },
    payload: { identifier: validAccount.email, password: validAccount.password }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().user.email, validAccount.email);
  assert.match(String(response.headers['set-cookie']), /HttpOnly/i);
});

test('revokes a prior cookie session when logging in again', async (context) => {
  const { app } = await createTestServer(context);
  const registration = await register(app);
  const priorCookie = sessionCookie(registration);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { cookie: priorCookie, origin: 'http://localhost:5500' },
    payload: { identifier: validAccount.username, password: validAccount.password }
  });
  const nextCookie = sessionCookie(login);
  const priorSession = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: priorCookie } });
  const nextSession = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: nextCookie } });
  assert.equal(priorSession.statusCode, 401);
  assert.equal(nextSession.statusCode, 200);
});

test('rejects invalid login credentials with a generic error', async (context) => {
  const { app } = await createTestServer(context);
  await register(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: 'http://localhost:5500' },
    payload: { identifier: 'unknown@example.test', password: 'incorrect password' }
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.message, 'Email/username or password was not recognized.');
});

test('limits repeated login attempts', async (context) => {
  const { app } = await createTestServer(context);
  let response;
  for (let attempt = 0; attempt < 11; attempt += 1) {
    response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://localhost:5500' },
      payload: { identifier: 'unknown@example.test', password: 'incorrect password' }
    });
  }
  assert.equal(response?.statusCode, 429);
});

test('returns the authenticated profile from /api/auth/me', async (context) => {
  const { app } = await createTestServer(context);
  const response = await register(app);
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sessionCookie(response) } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.userId, response.json().user.userId);
  assert.equal(me.json().user.role, 'user');
  assert.equal(me.json().user.status, 'active');
  assert.equal('passwordHash' in me.json().user, false);
});

test('rejects unauthenticated /api/auth/me requests', async (context) => {
  const { app } = await createTestServer(context);
  const response = await app.inject({ method: 'GET', url: '/api/auth/me' });
  assert.equal(response.statusCode, 401);
});

test('logout revokes the server session and clears its cookie', async (context) => {
  const { app } = await createTestServer(context);
  const registration = await register(app);
  const logout = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { cookie: sessionCookie(registration), origin: 'http://localhost:5500' }
  });
  assert.equal(logout.statusCode, 200);
  assert.equal(logout.json().success, true);
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sessionCookie(registration) } });
  assert.equal(me.statusCode, 401);
});

test('authenticated user can close their own account', async (context) => {
  const { app, repository } = await createTestServer(context);
  const registration = await register(app);
  const userId = registration.json().user.userId as string;
  const response = await app.inject({
    method: 'POST',
    url: '/api/users/me/close',
    headers: { cookie: sessionCookie(registration), origin: 'http://localhost:5500' }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().success, true);
  assert.match(String(response.headers['set-cookie']), /Max-Age=0/i);
  assert.equal(repository.userById(userId)?.status, 'closed');
});

test('rejects unauthenticated account closure', async (context) => {
  const { app, repository } = await createTestServer(context);
  const response = await app.inject({
    method: 'POST',
    url: '/api/users/me/close',
    headers: { origin: 'http://localhost:5500' }
  });

  assert.equal(response.statusCode, 401);
  assert.equal(repository.size, 0);
});

test('rejects account closure from an unapproved or missing origin', async (context) => {
  const { app, repository } = await createTestServer(context);
  const registration = await register(app);
  const cookie = sessionCookie(registration);

  const unapproved = await app.inject({
    method: 'POST',
    url: '/api/users/me/close',
    headers: { cookie, origin: 'https://unapproved.example' }
  });
  const missing = await app.inject({ method: 'POST', url: '/api/users/me/close', headers: { cookie } });

  assert.equal(unapproved.statusCode, 403);
  assert.equal(missing.statusCode, 403);
  assert.equal(repository.userById(registration.json().user.userId)?.status, 'active');
});

test('account closure uses the existing cross-origin POST method policy', async (context) => {
  const { app } = await createTestServer(context);
  const response = await app.inject({
    method: 'OPTIONS',
    url: '/api/users/me/close',
    headers: {
      origin: 'http://localhost:5500',
      'access-control-request-method': 'POST'
    }
  });

  assert.equal(response.statusCode, 204);
  assert.match(response.headers['access-control-allow-methods'] ?? '', /POST/);
  assert.doesNotMatch(response.headers['access-control-allow-methods'] ?? '', /DELETE/);
});

test('account closure only targets the authenticated user', async (context) => {
  const { app, repository } = await createTestServer(context);
  const owner = await register(app);
  const other = await register(app, { ...validAccount, username: 'other_player', email: 'other@example.test' });
  const otherUserId = other.json().user.userId as string;

  const otherPath = await app.inject({
    method: 'POST',
    url: `/api/users/${otherUserId}`,
    headers: { cookie: sessionCookie(owner), origin: 'http://localhost:5500' }
  });
  assert.equal(otherPath.statusCode, 404);
  assert.equal(repository.userById(otherUserId)?.status, 'active');

  const selfRequestWithForeignId = await app.inject({
    method: 'POST',
    url: '/api/users/me/close',
    headers: { cookie: sessionCookie(owner), origin: 'http://localhost:5500' },
    payload: { userId: otherUserId }
  });
  assert.equal(selfRequestWithForeignId.statusCode, 200);
  assert.equal(repository.userById(owner.json().user.userId)?.status, 'closed');
  assert.equal(repository.userById(otherUserId)?.status, 'active');
});

test('account closure invalidates every active session', async (context) => {
  const { app, repository } = await createTestServer(context);
  const registration = await register(app);
  const userId = registration.json().user.userId as string;
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: 'http://localhost:5500' },
    payload: { identifier: validAccount.email, password: validAccount.password }
  });
  const nextCookie = sessionCookie(login);
  assert.equal(repository.activeSessionCount(userId), 2);

  const close = await app.inject({
    method: 'POST',
    url: '/api/users/me/close',
    headers: { cookie: nextCookie, origin: 'http://localhost:5500' }
  });
  assert.equal(close.statusCode, 200);
  assert.equal(repository.activeSessionCount(userId), 0);
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sessionCookie(registration) } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: nextCookie } })).statusCode, 401);
});

test('account closure preserves wallet balances, transaction history, and ledger entries', async (context) => {
  const { app, repository } = await createTestServer(context);
  const registration = await register(app);
  const userId = registration.json().user.userId as string;
  const before = structuredClone(repository.linkedDataFor(userId));

  const response = await app.inject({
    method: 'POST',
    url: '/api/users/me/close',
    headers: { cookie: sessionCookie(registration), origin: 'http://localhost:5500' }
  });

  assert.equal(response.statusCode, 200);
  const after = repository.linkedDataFor(userId);
  assert.equal(after?.walletBalanceMinor, before?.walletBalanceMinor);
  assert.deepEqual(after?.walletTransactions, before?.walletTransactions);
  assert.deepEqual(after?.ledgerEntries, before?.ledgerEntries);
});

test('account closure anonymizes profile data while preserving competition and audit history', async (context) => {
  const { app, repository } = await createTestServer(context);
  const registration = await register(app);
  const userId = registration.json().user.userId as string;

  const response = await app.inject({
    method: 'POST',
    url: '/api/users/me/close',
    headers: { cookie: sessionCookie(registration), origin: 'http://localhost:5500' }
  });

  assert.equal(response.statusCode, 200);
  const closed = repository.userById(userId);
  assert.equal(closed?.fullName, 'Deleted player');
  assert.equal(closed?.email, `deleted+${userId}@deleted.invalid`);
  assert.equal(closed?.avatar, null);
  assert.equal(repository.storedCredentials(validAccount.email), undefined);
  const data = repository.linkedDataFor(userId);
  assert.equal(data?.kycProfile.legalName, null);
  assert.equal(data?.kycProfile.dateOfBirth, null);
  assert.equal(data?.kycProfile.verificationReference, null);
  assert.deepEqual(data?.tournamentRecords, ['registration', 'match-result']);
  assert.deepEqual(data?.auditEvents, ['kyc-audit', 'withdrawal-event']);
});

test('Postgres account closure is atomic and does not mutate linked financial or competition records', async () => {
  const userId = randomUUID();
  const statements: string[] = [];
  let released = false;
  const client = {
    async query(statement: string) {
      statements.push(statement);
      return statement.startsWith('SELECT id::text')
        ? { rows: [{ id: userId }] }
        : { rows: [] };
    },
    release() { released = true; }
  } as unknown as PoolClient;
  const pool = { async connect() { return client; } } as unknown as Pool;

  const closed = await new PostgresAuthRepository(pool).closeOwnAccount(userId);

  assert.equal(closed, true);
  assert.equal(released, true);
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements.at(-1), 'COMMIT');
  assert.ok(statements.some((statement) => statement.includes('UPDATE auth_sessions')));
  assert.ok(statements.some((statement) => statement.includes('DELETE FROM user_credentials')));
  assert.ok(statements.some((statement) => statement.includes('UPDATE user_role_assignments')));
  assert.ok(statements.some((statement) => statement.includes('UPDATE kyc_profiles')));
  assert.ok(statements.some((statement) => statement.includes('UPDATE users')));
  const userUpdate = statements.find((statement) => statement.includes('UPDATE users'));
  assert.match(userUpdate ?? '', /phone = NULL/);
  assert.match(userUpdate ?? '', /date_of_birth = NULL/);
  assert.match(userUpdate ?? '', /avatar = NULL/);
  assert.match(userUpdate ?? '', /status = 'closed'/);
  assert.ok(statements.every((statement) =>
    !/\b(wallets|wallet_transactions|wallet_ledger_entries|payments|withdrawal_requests|tournaments|matches|kyc_audit_events)\b/i.test(statement)
  ));
});

test('returns the authenticated profile from /api/users/me', async (context) => {
  const { app } = await createTestServer(context);
  const registration = await register(app);
  const response = await app.inject({ method: 'GET', url: '/api/users/me', headers: { cookie: sessionCookie(registration) } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().user.email, validAccount.email);
  assert.equal(response.json().user.role, 'user');
  assert.equal(response.json().user.status, 'active');
});

test('does not authorize a normal user for an admin resource', async (context) => {
  const { app } = await createTestServer(context);
  const registration = await register(app);
  const response = await app.inject({ method: 'GET', url: '/test/admin', headers: { cookie: sessionCookie(registration) } });
  assert.equal(response.statusCode, 403);
});

test('suspended users cannot log in or use an existing session', async (context) => {
  const { app, repository } = await createTestServer(context);
  const registration = await register(app);
  repository.setStatus(validAccount.email, 'suspended');
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: 'http://localhost:5500' },
    payload: { identifier: validAccount.username, password: validAccount.password }
  });
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sessionCookie(registration) } });
  assert.equal(login.statusCode, 401);
  assert.equal(me.statusCode, 401);
});

test('rejects client-supplied privileged registration fields', async (context) => {
  const { app, repository } = await createTestServer(context);
  const response = await register(app, {
    ...validAccount,
    role: 'admin',
    status: 'active',
    isAdmin: true,
    isDemo: true,
    permissions: ['all']
  });
  assert.equal(response.statusCode, 400);
  assert.equal(repository.size, 0);
});

test('never returns password_hash in auth or user responses', async (context) => {
  const { app } = await createTestServer(context);
  const registration = await register(app);
  const cookie = sessionCookie(registration);
  const responses = [
    registration,
    await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } }),
    await app.inject({ method: 'GET', url: '/api/users/me', headers: { cookie } })
  ];
  for (const response of responses) {
    assert.equal(JSON.stringify(response.json()).includes('password_hash'), false);
    assert.equal(JSON.stringify(response.json()).includes('argon2id'), false);
  }
});

test('sets Secure and SameSite=None cookies in production', async (context) => {
  const config = parseEnvironment({
    NODE_ENV: 'production',
    CORS_ORIGINS: 'https://homekart000-create.github.io'
  });
  const repository = new MemoryAuthRepository();
  const app = buildApp(config, repository);
  context.after(async () => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: 'https://homekart000-create.github.io' },
    payload: validAccount
  });
  const setCookie = String(response.headers['set-cookie']);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=None/i);
});

test('rejects authentication writes from origins outside the exact allowlist', async (context) => {
  const { app, repository } = await createTestServer(context);
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: 'https://unapproved.example' },
    payload: validAccount
  });
  assert.equal(response.statusCode, 403);
  assert.equal(repository.size, 0);
});

test('rejects authentication writes without an Origin header', async (context) => {
  const { app, repository } = await createTestServer(context);
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: validAccount });
  assert.equal(response.statusCode, 403);
  assert.equal(repository.size, 0);
});