import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { AuthUser, PublicUser } from '../auth/contracts.js';

interface UserRouteOptions {
  readonly requireAuth: preHandlerHookHandler;
}

function toPublicUser(user: AuthUser): PublicUser {
  return {
    userId: user.userId,
    fullName: user.fullName,
    username: user.username,
    email: user.email,
    avatar: user.avatar,
    createdAt: user.createdAt
  };
}

export function registerUserRoutes(app: FastifyInstance, options: UserRouteOptions): void {
  app.get('/api/users/me', { preHandler: options.requireAuth }, async (request) => ({ user: toPublicUser(request.authUser!) }));
}