import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { AppConfig } from '../config/env.js';
import type { KycRepository } from './contracts.js';
import { KycService } from './service.js';

interface KycRouteOptions {
  readonly repository: KycRepository;
  readonly config: AppConfig;
  readonly requireAuth: preHandlerHookHandler;
  readonly requireAdmin: preHandlerHookHandler;
}

function normalizeListQuery(limit?: number, offset?: number) {
  const safeLimit = typeof limit === 'number' ? limit : 25;
  const safeOffset = typeof offset === 'number' ? offset : 0;
  return {
    limit: Math.min(Math.max(safeLimit, 1), 100),
    offset: Math.max(safeOffset, 0)
  };
}

function isAllowedOrigin(config: AppConfig, origin: string | undefined): boolean {
  return origin !== undefined && config.corsOrigins.includes(origin);
}

function kycSummary(profile: Awaited<ReturnType<KycService['listProfiles']>>[number]) {
  return {
    userId: profile.userId,
    status: profile.status,
    country: profile.country,
    submittedAt: profile.submittedAt,
    reviewedAt: profile.reviewedAt,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  };
}

function kycUserView(profile: NonNullable<Awaited<ReturnType<KycService['getProfile']>>>) {
  return {
    userId: profile.userId,
    status: profile.status,
    legalName: profile.legalName,
    country: profile.country,
    dateOfBirth: profile.dateOfBirth,
    rejectionReason: profile.rejectionReason,
    submittedAt: profile.submittedAt,
    reviewedAt: profile.reviewedAt,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  };
}

export function registerKycRoutes(app: FastifyInstance, options: KycRouteOptions): void {
  const { repository, config, requireAuth, requireAdmin } = options;
  const service = new KycService(repository);

  app.get('/api/kyc', {
    preHandler: requireAuth
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const profile = await service.getProfile(request.authUser!.userId);
    return {
      kyc: profile ? kycUserView(profile) : {
        userId: request.authUser!.userId,
        status: 'unverified',
        legalName: null,
        country: null,
        dateOfBirth: null,
        rejectionReason: null,
        submittedAt: null,
        reviewedAt: null,
        createdAt: null,
        updatedAt: null
      }
    };
  });

  app.post<{ Body: { legalName?: string; country?: string; dateOfBirth?: string } }>('/api/kyc', {
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
    preHandler: requireAuth,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          legalName: { type: 'string', minLength: 1, maxLength: 120 },
          country: { type: 'string', minLength: 2, maxLength: 80 },
          dateOfBirth: { type: 'string', format: 'date' }
        }
      }
    }
  }, async (request, reply) => {
    if (!isAllowedOrigin(config, request.headers.origin)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'This action is not allowed.' } });
    }
    reply.header('cache-control', 'no-store');
    return { kyc: kycUserView(await service.createOrUpdateProfile(request.authUser!.userId, request.body)) };
  });

  app.patch<{ Body: { legalName?: string; country?: string; dateOfBirth?: string } }>('/api/kyc', {
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
    preHandler: requireAuth,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          legalName: { type: 'string', minLength: 1, maxLength: 120 },
          country: { type: 'string', minLength: 2, maxLength: 80 },
          dateOfBirth: { type: 'string', format: 'date' }
        }
      }
    }
  }, async (request, reply) => {
    if (!isAllowedOrigin(config, request.headers.origin)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'This action is not allowed.' } });
    }
    reply.header('cache-control', 'no-store');
    return { kyc: kycUserView(await service.createOrUpdateProfile(request.authUser!.userId, request.body)) };
  });

  app.get<{ Querystring: { limit?: number; offset?: number; status?: string } }>('/api/admin/kyc', {
    preHandler: [requireAuth, requireAdmin],
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          offset: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
          status: { type: 'string', enum: ['unverified', 'pending', 'verified', 'rejected', 'suspended'] }
        }
      }
    }
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return {
      kyc: (await service.listProfiles({
        ...normalizeListQuery(request.query.limit, request.query.offset),
        ...(request.query.status ? { status: request.query.status as 'unverified' | 'pending' | 'verified' | 'rejected' | 'suspended' } : {})
      })).map(kycSummary)
    };
  });

  app.get<{ Params: { userId: string } }>('/api/admin/kyc/:userId', {
    preHandler: [requireAuth, requireAdmin],
    schema: {
      params: {
        type: 'object',
        required: ['userId'],
        additionalProperties: false,
        properties: { userId: { type: 'string', format: 'uuid' } }
      }
    }
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const targetUserId = request.params.userId;
    const profile = await service.getProfile(targetUserId);
    if (!profile) {
      return { kyc: null };
    }
    return { kyc: profile };
  });

  app.get<{ Params: { userId: string } }>('/api/admin/kyc/:userId/audit', {
    preHandler: [requireAuth, requireAdmin],
    schema: {
      params: {
        type: 'object', required: ['userId'], additionalProperties: false,
        properties: { userId: { type: 'string', format: 'uuid' } }
      }
    }
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return { auditEvents: await repository.listAuditEvents(request.params.userId) };
  });

  app.post<{ Body: { status: 'pending' | 'verified' | 'rejected' | 'suspended'; reason?: string; verificationReference?: string }; Params: { userId: string } }>('/api/admin/kyc/:userId/review', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    preHandler: [requireAuth, requireAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['status'],
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['pending', 'verified', 'rejected', 'suspended'] },
          reason: { type: 'string', maxLength: 240 },
          verificationReference: { type: 'string', minLength: 1, maxLength: 128 }
        }
      },
      params: {
        type: 'object',
        required: ['userId'],
        additionalProperties: false,
        properties: { userId: { type: 'string', format: 'uuid' } }
      }
    }
  }, async (request, reply) => {
    if (!isAllowedOrigin(config, request.headers.origin)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'This action is not allowed.' } });
    }
    reply.header('cache-control', 'no-store');
    return { kyc: await service.reviewProfile(request.params.userId, request.authUser!.userId, request.body) };
  });
}
