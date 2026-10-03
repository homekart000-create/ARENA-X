import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { AuthRepository } from './auth/contracts.js';
import { createOptionalAuth, createRequireAuth, requireAdmin } from './auth/middleware.js';
import { registerAuthRoutes } from './auth/routes.js';
import { KycError, type KycRepository } from './kyc/contracts.js';
import { InMemoryKycRepository } from './kyc/in-memory-repository.js';
import { registerKycRoutes } from './kyc/routes.js';
import { PayoutError, type PayoutProvider, type PayoutRepository } from './payouts/contracts.js';
import { UnavailablePayoutProvider } from './payouts/provider.js';
import { registerPayoutRoutes } from './payouts/routes.js';
import { PayoutService } from './payouts/service.js';
import { UnavailablePayoutRepository } from './payouts/unavailable-repository.js';
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
import type { PaymentProvider, PaymentRepository } from './payments/contracts.js';
import { PaymentError } from './payments/contracts.js';
import { PostgresPaymentRepository } from './payments/postgres-repository.js';
import { RazorpayPaymentProvider } from './payments/provider.js';
import { registerPaymentRoutes } from './payments/routes.js';
import { UnavailablePaymentRepository } from './payments/unavailable-repository.js';

export function buildApp(
  config: AppConfig,
  authRepository: AuthRepository,
  competitionRepository: CompetitionRepository = new UnavailableCompetitionRepository(),
  walletRepository: WalletRepository = new UnavailableWalletRepository(),
  paymentRepository: PaymentRepository = new UnavailablePaymentRepository(),
  paymentProvider?: PaymentProvider,
  kycRepository: KycRepository = new InMemoryKycRepository(),
  payoutRepository: PayoutRepository = new UnavailablePayoutRepository(),
  payoutProvider: PayoutProvider = new UnavailablePayoutProvider()
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
    const response = error instanceof CompetitionError || error instanceof WalletError || error instanceof PaymentError || error instanceof KycError || error instanceof PayoutError
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
    registerUserRoutes(routesApp, { requireAuth, config, repository: authRepository });
    registerKycRoutes(routesApp, { repository: kycRepository, config, requireAuth, requireAdmin });
    registerCompetitionRoutes(routesApp, { config, repository: competitionRepository, requireAuth, optionalAuth });
    registerWalletRoutes(routesApp, {
      config,
      service: new WalletService(walletRepository, kycRepository, config.withdrawalKycRequired,
        config.minimumWithdrawalMinor, config.maximumWithdrawalMinor),
      requireAuth
    });
    routesApp.register(async (paymentsApp) => {
      paymentsApp.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
        if (request.url.startsWith('/api/payments/webhooks/') || request.url.startsWith('/api/payouts/webhooks/')) {
          done(null, body);
          return;
        }
        try {
          done(null, JSON.parse(body.toString('utf8')));
        } catch {
          done(new Error('Invalid JSON body.'));
        }
      });
      paymentsApp.addContentTypeParser('application/*+json', { parseAs: 'buffer' }, (request, body, done) => {
        if (request.url.startsWith('/api/payments/webhooks/') || request.url.startsWith('/api/payouts/webhooks/')) {
          done(null, body);
          return;
        }
        try {
          done(null, JSON.parse(body.toString('utf8')));
        } catch {
          done(new Error('Invalid JSON body.'));
        }
      });
      registerPaymentRoutes(paymentsApp, {
        config,
        repository: paymentRepository,
        provider: paymentProvider ?? new RazorpayPaymentProvider({
          mode: config.paymentsMode,
          ...(config.razorpayKeyId ? { keyId: config.razorpayKeyId } : {}),
          ...(config.razorpayKeySecret ? { keySecret: config.razorpayKeySecret } : {}),
          ...(config.razorpayWebhookSecret ? { webhookSecret: config.razorpayWebhookSecret } : {})
        }),
        requireAuth
      });
      registerPayoutRoutes(paymentsApp, {
        config,
        service: new PayoutService(payoutRepository, payoutProvider),
        provider: payoutProvider,
        requireAuth,
        requireAdmin
      });
    });
  });
  return app;
}