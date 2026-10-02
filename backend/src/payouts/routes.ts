import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { AppConfig } from '../config/env.js';
import type { PayoutProvider } from './contracts.js';
import { PayoutError } from './contracts.js';
import { PayoutService } from './service.js';

interface WithdrawalRouteOptions {
  readonly config: AppConfig;
  readonly service: PayoutService;
  readonly provider: PayoutProvider;
  readonly requireAuth: preHandlerHookHandler;
  readonly requireAdmin: preHandlerHookHandler;
}

interface Params {
  readonly withdrawalRequestId: string;
}

interface ListQuery {
  readonly limit?: number;
  readonly offset?: number;
  readonly status?: 'pending' | 'approved' | 'processing' | 'paid' | 'failed' | 'rejected' | 'cancelled';
}

function allowedOrigin(config: AppConfig, origin: string | undefined): boolean {
  return origin !== undefined && config.corsOrigins.includes(origin);
}

function validateProviderName(name: string, provider: PayoutProvider): void {
  if (name !== provider.name) throw new PayoutError(404, 'PAYOUT_PROVIDER_NOT_FOUND', 'Payout provider not found.');
}

export function registerPayoutRoutes(app: FastifyInstance, options: WithdrawalRouteOptions): void {
  const { config, service, provider, requireAuth, requireAdmin } = options;

  app.get<{ Querystring: ListQuery }>('/api/wallet/withdrawal-requests', {
    preHandler: requireAuth,
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          offset: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
          status: { type: 'string', enum: ['pending', 'approved', 'processing', 'paid', 'failed', 'rejected', 'cancelled'] }
        }
      }
    }
  }, async (request) => ({
    withdrawals: await service.listForUser(request.authUser!.userId, {
      limit: request.query.limit ?? 25,
      offset: request.query.offset ?? 0,
      ...(request.query.status ? { status: request.query.status } : {})
    })
  }));

  app.get<{ Params: Params }>('/api/wallet/withdrawal-requests/:withdrawalRequestId', {
    preHandler: requireAuth,
    schema: {
      params: {
        type: 'object', required: ['withdrawalRequestId'], additionalProperties: false,
        properties: { withdrawalRequestId: { type: 'string', format: 'uuid' } }
      }
    }
  }, async (request, reply) => {
    const withdrawal = await service.getForUser(request.params.withdrawalRequestId, request.authUser!.userId);
    if (!withdrawal) {
      return reply.code(404).send({ error: { code: 'WITHDRAWAL_NOT_FOUND', message: 'Withdrawal request not found.' } });
    }
    return {
      withdrawal: {
        withdrawalRequestId: withdrawal.withdrawalRequestId,
        userId: withdrawal.userId,
        amountMinor: withdrawal.amountMinor,
        currency: withdrawal.currency,
        status: withdrawal.status,
        createdAt: withdrawal.createdAt,
        updatedAt: withdrawal.updatedAt,
        reviewReason: withdrawal.reviewReason
      }
    };
  });

  app.post<{ Params: Params }>('/api/wallet/withdrawal-requests/:withdrawalRequestId/cancel', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    preHandler: requireAuth,
    schema: {
      params: {
        type: 'object', required: ['withdrawalRequestId'], additionalProperties: false,
        properties: { withdrawalRequestId: { type: 'string', format: 'uuid' } }
      },
      body: { type: 'object', additionalProperties: false }
    }
  }, async (request, reply) => {
    if (!allowedOrigin(config, request.headers.origin)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'This action is not allowed.' } });
    const withdrawal = await service.cancel(request.params.withdrawalRequestId, request.authUser!.userId);
    return { withdrawal: { withdrawalRequestId: withdrawal.withdrawalRequestId, status: withdrawal.status } };
  });

  app.get<{ Querystring: ListQuery }>('/api/admin/withdrawals', {
    preHandler: [requireAuth, requireAdmin],
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          offset: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
          status: { type: 'string', enum: ['pending', 'approved', 'processing', 'paid', 'failed', 'rejected', 'cancelled'] }
        }
      }
    }
  }, async (request) => ({
    withdrawals: await service.list({
      limit: request.query.limit ?? 25,
      offset: request.query.offset ?? 0,
      ...(request.query.status ? { status: request.query.status } : {})
    })
  }));

  app.get<{ Params: Params }>('/api/admin/withdrawals/:withdrawalRequestId', {
    preHandler: [requireAuth, requireAdmin],
    schema: {
      params: {
        type: 'object', required: ['withdrawalRequestId'], additionalProperties: false,
        properties: { withdrawalRequestId: { type: 'string', format: 'uuid' } }
      }
    }
  }, async (request, reply) => {
    const withdrawal = await service.get(request.params.withdrawalRequestId);
    if (!withdrawal) return reply.code(404).send({ error: { code: 'WITHDRAWAL_NOT_FOUND', message: 'Withdrawal request not found.' } });
    return { withdrawal };
  });

  app.post<{ Params: Params; Body: { reason?: string } }>('/api/admin/withdrawals/:withdrawalRequestId/approve', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    preHandler: [requireAuth, requireAdmin],
    schema: {
      params: {
        type: 'object', required: ['withdrawalRequestId'], additionalProperties: false,
        properties: { withdrawalRequestId: { type: 'string', format: 'uuid' } }
      },
      body: {
        type: 'object', additionalProperties: false,
        properties: { reason: { type: 'string', maxLength: 240 } }
      }
    }
  }, async (request, reply) => {
    if (!allowedOrigin(config, request.headers.origin)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'This action is not allowed.' } });
    return { withdrawal: await service.approve(request.params.withdrawalRequestId, request.authUser!.userId, request.body.reason?.trim() || null) };
  });

  app.post<{ Params: Params; Body: { reason: string } }>('/api/admin/withdrawals/:withdrawalRequestId/reject', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    preHandler: [requireAuth, requireAdmin],
    schema: {
      params: {
        type: 'object', required: ['withdrawalRequestId'], additionalProperties: false,
        properties: { withdrawalRequestId: { type: 'string', format: 'uuid' } }
      },
      body: {
        type: 'object', required: ['reason'], additionalProperties: false,
        properties: { reason: { type: 'string', minLength: 1, maxLength: 240 } }
      }
    }
  }, async (request, reply) => {
    if (!allowedOrigin(config, request.headers.origin)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'This action is not allowed.' } });
    const reason = request.body.reason.trim();
    if (!reason) throw new PayoutError(400, 'REJECTION_REASON_REQUIRED', 'A reason is required to reject a withdrawal.');
    return { withdrawal: await service.reject(request.params.withdrawalRequestId, request.authUser!.userId, reason) };
  });

  app.post<{ Params: Params }>('/api/admin/withdrawals/:withdrawalRequestId/retry', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    preHandler: [requireAuth, requireAdmin],
    schema: {
      params: {
        type: 'object', required: ['withdrawalRequestId'], additionalProperties: false,
        properties: { withdrawalRequestId: { type: 'string', format: 'uuid' } }
      },
      body: { type: 'object', additionalProperties: false }
    }
  }, async (request, reply) => {
    if (!allowedOrigin(config, request.headers.origin)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'This action is not allowed.' } });
    const withdrawal = await service.retry(request.params.withdrawalRequestId, request.authUser!.userId);
    return reply.code(withdrawal.status === 'processing' ? 202 : 200).send({ withdrawal });
  });

  app.post<{ Params: Params }>('/api/admin/withdrawals/:withdrawalRequestId/reconcile', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    preHandler: [requireAuth, requireAdmin],
    schema: {
      params: {
        type: 'object', required: ['withdrawalRequestId'], additionalProperties: false,
        properties: { withdrawalRequestId: { type: 'string', format: 'uuid' } }
      },
      body: { type: 'object', additionalProperties: false }
    }
  }, async (request, reply) => {
    if (!allowedOrigin(config, request.headers.origin)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'This action is not allowed.' } });
    return { withdrawal: await service.reconcile(request.params.withdrawalRequestId, request.authUser!.userId) };
  });

  app.post<{ Params: { provider: string } }>('/api/payouts/webhooks/:provider', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    bodyLimit: 64 * 1024,
    schema: {
      params: {
        type: 'object', required: ['provider'], additionalProperties: false,
        properties: { provider: { type: 'string', pattern: '^[a-z][a-z0-9_-]{1,31}$' } }
      }
    }
  }, async (request, reply) => {
    validateProviderName(request.params.provider, provider);
    if (!provider.available) throw new PayoutError(503, 'PAYOUT_PROVIDER_UNAVAILABLE', 'Payout webhook processing is not configured.');
    if (!Buffer.isBuffer(request.body)) throw new PayoutError(400, 'INVALID_PAYOUT_EVENT', 'Payout webhook requires a raw request body.');
    const signature = request.headers['x-payout-signature'];
    const event = await provider.verifyWebhook(request.body, Array.isArray(signature) ? signature[0] : signature);
    if (!['processing', 'unknown', 'paid', 'failed'].includes(event.status)) {
      throw new PayoutError(400, 'INVALID_PAYOUT_EVENT', 'Payout webhook status is invalid.');
    }
    const result = await service.handleWebhook(event);
    return reply.code(200).send({ received: true, duplicate: result.duplicate, withdrawalRequestId: result.withdrawalRequestId });
  });
}
