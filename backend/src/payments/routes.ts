import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { AppConfig } from '../config/env.js';
import type { PaymentProvider } from './contracts.js';
import { PaymentError, type PaymentRecord, type PaymentRepository } from './contracts.js';
import { PaymentService } from './service.js';

interface OrderBody {
  amountMinor: number;
}

interface VerifyBody {
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
}

interface PaymentParams {
  id: string;
}

interface PaymentRouteOptions {
  readonly config: AppConfig;
  readonly repository: PaymentRepository;
  readonly provider: PaymentProvider;
  readonly requireAuth: preHandlerHookHandler;
}

function allowedOrigin(config: AppConfig, origin: string | undefined): boolean {
  return origin !== undefined && config.corsOrigins.includes(origin);
}

function paymentSummary(payment: PaymentRecord) {
  return {
    paymentId: payment.paymentId,
    provider: payment.provider,
    providerOrderId: payment.providerOrderId,
    providerPaymentId: payment.providerPaymentId,
    providerReferenceId: payment.providerReferenceId,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    status: payment.status,
    failureCode: payment.failureCode,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
    completedAt: payment.completedAt
  };
}

export function registerPaymentRoutes(app: FastifyInstance, options: PaymentRouteOptions): void {
  const { config, provider, requireAuth } = options;
  const service = new PaymentService(options.repository, provider);

  app.post<{ Body: OrderBody }>('/api/payments/orders', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    preHandler: requireAuth,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['amountMinor'],
        properties: { amountMinor: { type: 'integer', minimum: 1, maximum: 100_000_000 } }
      }
    }
  }, async (request, reply) => {
    if (!allowedOrigin(config, request.headers.origin)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'This action is not allowed.' } });
    }
    const header = request.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(header) ? header[0] : header;
    if (!idempotencyKey) throw new PaymentError(400, 'INVALID_IDEMPOTENCY_KEY', 'A valid idempotency key is required.');
    const result = await service.createOrder(request.authUser!.userId, request.body.amountMinor, idempotencyKey);
    return reply.code(201).send({
      payment: paymentSummary(result.payment),
      checkout: result.checkout
    });
  });

  app.get<{ Params: PaymentParams }>('/api/payments/:id', {
    preHandler: requireAuth,
    schema: {
      params: {
        type: 'object', additionalProperties: false, required: ['id'],
        properties: { id: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' } }
      }
    }
  }, async (request, reply) => {
    const payment = await service.getPayment(request.params.id, request.authUser!.userId);
    if (!payment) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Payment not found.' } });
    return { payment: paymentSummary(payment) };
  });

  app.post<{ Params: PaymentParams; Body: VerifyBody }>('/api/payments/:id/verify', {
    preHandler: requireAuth,
    schema: {
      params: {
        type: 'object', additionalProperties: false, required: ['id'],
        properties: { id: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' } }
      },
      body: {
        type: 'object', additionalProperties: false, required: ['providerOrderId', 'providerPaymentId', 'signature'],
        properties: {
          providerOrderId: { type: 'string', minLength: 1, maxLength: 128 },
          providerPaymentId: { type: 'string', minLength: 1, maxLength: 128 },
          signature: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' }
        }
      }
    }
  }, async (request, reply) => {
    if (!allowedOrigin(config, request.headers.origin)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'This action is not allowed.' } });
    }
    const payment = await service.verifyPayment(request.params.id, request.authUser!.userId, request.body);
    return { payment: paymentSummary(payment), settlement: payment.status === 'settled' ? 'credited' : 'pending' };
  });

  app.post<{ Body: Buffer }>('/api/payments/webhooks/razorpay', {
    schema: { body: { type: 'object' } }
  }, async (request) => {
    if (!Buffer.isBuffer(request.body)) {
      throw new PaymentError(400, 'INVALID_PROVIDER_EVENT', 'Payment webhook payload is invalid.');
    }
    const header = request.headers['x-razorpay-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    return service.processWebhook(request.body, signature);
  });
}
