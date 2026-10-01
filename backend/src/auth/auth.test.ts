import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/env.js';
import { parseEnvironment } from '../config/env.js';
import { buildApp } from '../app.js';
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

test('returns the authenticated profile from /api/users/me', async (context) => {
  const { app } = await createTestServer(context);
  const registration = await register(app);
  const response = await app.inject({ method: 'GET', url: '/api/users/me', headers: { cookie: sessionCookie(registration) } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().user.email, validAccount.email);
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