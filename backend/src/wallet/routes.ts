import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { AppConfig } from '../config/env.js';
import type { WalletTransactionStatus, WalletTransactionType } from './contracts.js';
import { WalletService, MAX_WALLET_AMOUNT_MINOR } from './service.js';

interface TransactionQuery {
  limit?: number;
  offset?: number;
  type?: WalletTransactionType;
  status?: WalletTransactionStatus;
}

interface WithdrawalBody {
  amountMinor: number;
}

interface WalletRouteOptions {
  readonly config: AppConfig;
  readonly service: WalletService;
  readonly requireAuth: preHandlerHookHandler;
}

function isAllowedOrigin(config: AppConfig, origin: string | undefined): boolean {
  return origin !== undefined && config.corsOrigins.includes(origin);
}

export function registerWalletRoutes(app: FastifyInstance, options: WalletRouteOptions): void {
  const { config, service, requireAuth } = options;

  app.get('/api/wallet', {
    preHandler: requireAuth,
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {} } }
  }, async (request) => ({
    wallet: await service.getWallet(request.authUser!.userId)
  }));

  app.get<{ Querystring: TransactionQuery }>('/api/wallet/transactions', {
    preHandler: requireAuth,
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          offset: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
          type: { type: 'string', enum: ['deposit', 'withdrawal', 'entry_fee', 'winning', 'refund', 'adjustment'] },
          status: { type: 'string', enum: ['pending', 'completed', 'failed', 'reversed', 'approved', 'rejected', 'cancelled'] }
        }
      }
    }
  }, async (request) => ({
    transactions: await service.listTransactions(request.authUser!.userId, {
      limit: request.query.limit ?? 25,
      offset: request.query.offset ?? 0,
      ...(request.query.type ? { type: request.query.type } : {}),
      ...(request.query.status ? { status: request.query.status } : {})
    })
  }));

  app.post<{ Body: WithdrawalBody }>('/api/wallet/withdrawal-requests', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    preHandler: requireAuth,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['amountMinor'],
        properties: { amountMinor: { type: 'integer', minimum: 1, maximum: MAX_WALLET_AMOUNT_MINOR } }
      }
    }
  }, async (request, reply) => {
    if (!isAllowedOrigin(config, request.headers.origin)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'This action is not allowed.' } });
    }
    const header = request.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(header) ? header[0] : header;
    const withdrawal = await service.requestWithdrawal(request.authUser!.userId, {
      amountMinor: request.body.amountMinor,
      idempotencyKey: idempotencyKey ?? '',
      description: 'Withdrawal request'
    });
    return reply.code(withdrawal.replayed ? 200 : 202).send({ withdrawal });
  });
}