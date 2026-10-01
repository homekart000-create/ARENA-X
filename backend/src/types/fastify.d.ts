import type { AuthUser } from '../auth/contracts.js';

declare module 'fastify' {
  interface FastifyRequest {
    authUser: AuthUser | null;
  }
}