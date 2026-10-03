import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { AppConfig } from '../config/env.js';
import type { AuthRepository, AuthUser, PublicUser } from '../auth/contracts.js';

interface UserRouteOptions {
  readonly requireAuth: preHandlerHookHandler;
  readonly config: AppConfig;
  readonly repository: AuthRepository;
}

function toPublicUser(user: AuthUser): PublicUser {
  return {
    userId: user.userId,
    fullName: user.fullName,
    username: user.username,
    email: user.email,
    avatar: user.avatar,
    status: user.status,
    role: user.role,
    createdAt: user.createdAt
  };
}

export function registerUserRoutes(app: FastifyInstance, options: UserRouteOptions): void {
  app.get('/api/users/me', { preHandler: options.requireAuth }, async (request) => ({ user: toPublicUser(request.authUser!) }));

  app.post('/api/users/me/close', {
    preHandler: options.requireAuth,
    config: { rateLimit: { max: 3, timeWindow: '1 hour' } }
  }, async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin || !options.config.corsOrigins.includes(origin)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'This action is not allowed.' } });
    }

    const closed = await options.repository.closeOwnAccount(request.authUser!.userId);
    if (!closed) {
      return reply.code(409).send({ error: { code: 'CONFLICT', message: 'This account could not be closed. Refresh and try again.' } });
    }

    reply.clearCookie(options.config.authCookieName, {
      path: '/',
      httpOnly: true,
      secure: options.config.nodeEnv === 'production',
      sameSite: options.config.nodeEnv === 'production' ? 'none' : 'lax'
    });
    return reply.send({ success: true });
  });
}