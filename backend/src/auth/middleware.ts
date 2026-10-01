import type { preHandlerHookHandler } from 'fastify';
import type { AppConfig } from '../config/env.js';
import type { AuthRepository } from './contracts.js';
import { hashSessionToken } from './session.js';

function cookieOptions(config: AppConfig) {
  return {
    path: '/',
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: config.nodeEnv === 'production' ? 'none' as const : 'lax' as const
  };
}

function sendUnauthorized(reply: Parameters<preHandlerHookHandler>[1]): void {
  void reply.code(401).send({
    error: { code: 'UNAUTHORIZED', message: 'Authentication is required.' }
  });
}

export function createRequireAuth(repository: AuthRepository, config: AppConfig): preHandlerHookHandler {
  return async (request, reply) => {
    const token = request.cookies[config.authCookieName];
    if (!token) {
      sendUnauthorized(reply);
      return;
    }

    const user = await repository.findSessionUser(hashSessionToken(token));
    if (!user || user.status !== 'active') {
      reply.clearCookie(config.authCookieName, cookieOptions(config));
      sendUnauthorized(reply);
      return;
    }

    request.authUser = user;
  };
}

export const requireAdmin: preHandlerHookHandler = async (request, reply) => {
  if (!request.authUser) {
    sendUnauthorized(reply);
    return;
  }
  if (request.authUser.role !== 'admin') {
    void reply.code(403).send({
      error: { code: 'FORBIDDEN', message: 'This action is not allowed.' }
    });
  }
};