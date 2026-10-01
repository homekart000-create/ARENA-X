import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { AuthRepository } from './auth/contracts.js';
import { createOptionalAuth, createRequireAuth } from './auth/middleware.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerUserRoutes } from './users/routes.js';
import type { CompetitionRepository } from './competition/contracts.js';
import { CompetitionError } from './competition/contracts.js';
import { registerCompetitionRoutes } from './competition/routes.js';
import { UnavailableCompetitionRepository } from './competition/unavailable-repository.js';
import type { AppConfig } from './config/env.js';
import { registerCors } from './plugins/cors.js';
import { registerHealthRoute } from './routes/health.js';
import type { WalletRepository } from './wallet/contracts.js';
import { WalletError } from './wallet/contracts.js';
import { registerWalletRoutes } from './wallet/routes.js';
import { UnavailableWalletRepository } from './wallet/unavailable-repository.js';
import { WalletService } from './wallet/service.js';

export function buildApp(
  config: AppConfig,
  authRepository: AuthRepository,
  competitionRepository: CompetitionRepository = new UnavailableCompetitionRepository(),
  walletRepository: WalletRepository = new UnavailableWalletRepository()
) {
  const app = Fastify({
    logger: config.nodeEnv !== 'test',
    ajv: { customOptions: { removeAdditional: false } }
  });
  const requireAuth = createRequireAuth(authRepository, config);
  const optionalAuth = createOptionalAuth(authRepository, config);

  app.decorateRequest('authUser', null);

  app.setErrorHandler((error, request, reply) => {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error &&
      typeof error.statusCode === 'number' ? error.statusCode : undefined;
    const response = error instanceof CompetitionError || error instanceof WalletError
      ? { status: error.statusCode, code: error.code, message: error.message }
      : statusCode === 400
      ? { status: 400, code: 'BAD_REQUEST', message: 'Request could not be processed.' }
      : statusCode === 401
        ? { status: 401, code: 'UNAUTHORIZED', message: 'Authentication is required.' }
        : statusCode === 403
          ? { status: 403, code: 'FORBIDDEN', message: 'This action is not allowed.' }
          : statusCode === 404
            ? { status: 404, code: 'NOT_FOUND', message: 'The requested resource was not found.' }
            : statusCode === 409
              ? { status: 409, code: 'CONFLICT', message: 'An account with those details already exists.' }
              : statusCode === 429
                ? { status: 429, code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' }
                : statusCode === 503
                  ? { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'The service is temporarily unavailable.' }
                  : { status: 500, code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred.' };

    if (response.status >= 500) {
      app.log.error({ requestId: request.id, errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Request failed');
    }

    return reply.code(response.status).send({
      error: {
        code: response.code,
        message: response.message
      }
    });
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({
    error: {
      code: 'NOT_FOUND',
      message: 'The requested resource was not found.'
    }
  }));

  app.register(cookie);
  app.register(rateLimit, { global: false });
  registerCors(app, config);
  registerHealthRoute(app);
  app.register(async (routesApp) => {
    registerAuthRoutes(routesApp, { config, repository: authRepository, requireAuth });
    registerUserRoutes(routesApp, { requireAuth });
    registerCompetitionRoutes(routesApp, { config, repository: competitionRepository, requireAuth, optionalAuth });
    registerWalletRoutes(routesApp, { config, service: new WalletService(walletRepository), requireAuth });
  });
  return app;
}