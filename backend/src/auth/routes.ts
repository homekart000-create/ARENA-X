import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../config/env.js';
import {
  DuplicateAccountError,
  type AuthRepository,
  type PublicUser
} from './contracts.js';
import { hashPassword, verifyPassword } from './password.js';
import { createSessionToken, hashSessionToken } from './session.js';

interface RegisterBody {
  fullName: string;
  username: string;
  email: string;
  password: string;
  phone?: string;
  dateOfBirth?: string;
}

interface LoginBody {
  identifier: string;
  password: string;
}

interface AuthRouteOptions {
  readonly config: AppConfig;
  readonly repository: AuthRepository;
  readonly requireAuth: preHandlerHookHandler;
}

function toPublicUser(user: NonNullable<import('./contracts.js').AuthUser>): PublicUser {
  return {
    userId: user.userId,
    fullName: user.fullName,
    username: user.username,
    email: user.email,
    avatar: user.avatar,
    createdAt: user.createdAt
  };
}

function cookieOptions(config: AppConfig) {
  return {
    path: '/',
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: config.nodeEnv === 'production' ? 'none' as const : 'lax' as const,
    maxAge: config.sessionTtlSeconds
  };
}

function checkOrigin(config: AppConfig, origin: string | undefined): boolean {
  return origin !== undefined && config.corsOrigins.includes(origin);
}

function initials(fullName: string): string {
  return fullName.trim().split(/\s+/).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase();
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const { config, repository, requireAuth } = options;
  let dummyHash: Promise<string> | undefined;

  app.post<{ Body: RegisterBody }>('/api/auth/register', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['fullName', 'username', 'email', 'password'],
        properties: {
          fullName: { type: 'string', minLength: 2, maxLength: 120 },
          username: { type: 'string', minLength: 3, maxLength: 20, pattern: '^[A-Za-z0-9_]+$' },
          email: { type: 'string', minLength: 3, maxLength: 254, format: 'email' },
          password: { type: 'string', minLength: 8, maxLength: 128 },
          phone: { type: 'string', minLength: 10, maxLength: 20, pattern: '^\\+?[0-9\\s()-]+$' },
          dateOfBirth: { type: 'string', format: 'date' }
        }
      }
    }
  }, async (request, reply) => {
    if (!checkOrigin(config, request.headers.origin)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'This action is not allowed.' } });
    }

    const fullName = request.body.fullName.trim();
    const username = request.body.username.trim();
    const email = request.body.email.trim().toLowerCase();
    if (fullName.length < 2 || !username || !email || !request.body.password.trim()) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Enter valid account details.' } });
    }
    if (request.body.dateOfBirth && new Date(`${request.body.dateOfBirth}T00:00:00Z`) > new Date()) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Enter valid account details.' } });
    }

    const passwordHash = await hashPassword(request.body.password);
    let user;
    try {
      user = await repository.createUser({
        fullName,
        username,
        email,
        passwordHash,
        avatar: initials(fullName),
        ...(request.body.phone ? { phone: request.body.phone.trim() } : {}),
        ...(request.body.dateOfBirth ? { dateOfBirth: request.body.dateOfBirth } : {})
      });
    } catch (error) {
      if (error instanceof DuplicateAccountError) {
        return reply.code(409).send({ error: { code: 'CONFLICT', message: 'An account with those details already exists.' } });
      }
      throw error;
    }

    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000);
    await repository.createSession(user.userId, hashSessionToken(token), expiresAt);
    reply.setCookie(config.authCookieName, token, cookieOptions(config));
    return reply.code(201).send({ user: toPublicUser(user) });
  });

  app.post<{ Body: LoginBody }>('/api/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['identifier', 'password'],
        properties: {
          identifier: { type: 'string', minLength: 1, maxLength: 254 },
          password: { type: 'string', minLength: 1, maxLength: 128 }
        }
      }
    }
  }, async (request, reply) => {
    if (!checkOrigin(config, request.headers.origin)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'This action is not allowed.' } });
    }

    const identifier = request.body.identifier.trim();
    const credentials = identifier ? await repository.findByIdentifier(identifier) : null;
    const fallbackHash = credentials ? undefined : await (dummyHash ??= hashPassword(randomBytes(32).toString('hex')));
    const passwordMatches = await verifyPassword(credentials?.passwordHash ?? fallbackHash!, request.body.password);
    if (!credentials || credentials.user.status !== 'active' || !passwordMatches) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Email/username or password was not recognized.' } });
    }

    const priorToken = request.cookies[config.authCookieName];
    if (priorToken) await repository.revokeSession(hashSessionToken(priorToken));

    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000);
    await repository.createSession(credentials.user.userId, hashSessionToken(token), expiresAt);
    reply.setCookie(config.authCookieName, token, cookieOptions(config));
    return reply.send({ user: toPublicUser(credentials.user) });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    if (!checkOrigin(config, request.headers.origin)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'This action is not allowed.' } });
    }
    const token = request.cookies[config.authCookieName];
    if (token) await repository.revokeSession(hashSessionToken(token));
    reply.clearCookie(config.authCookieName, cookieOptions(config));
    return reply.send({ success: true });
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (request) => ({ user: toPublicUser(request.authUser!) }));
}