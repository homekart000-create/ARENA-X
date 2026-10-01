import Fastify from 'fastify';
import type { AppConfig } from './config/env.js';
import { registerCors } from './plugins/cors.js';
import { registerHealthRoute } from './routes/health.js';

export function buildApp(config: AppConfig) {
  const app = Fastify({ logger: true });

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error &&
      typeof error.statusCode === 'number' ? error.statusCode : undefined;
    const isClientError = statusCode !== undefined && statusCode >= 400 && statusCode < 500;
    if (!isClientError) {
      app.log.error({ err: error }, 'Unhandled request error');
    }

    return reply.code(isClientError ? statusCode : 500).send({
      error: {
        code: isClientError ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR',
        message: isClientError ? 'Request could not be processed.' : 'An unexpected error occurred.'
      }
    });
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({
    error: {
      code: 'NOT_FOUND',
      message: 'The requested resource was not found.'
    }
  }));

  void registerCors(app, config);
  void registerHealthRoute(app);
  return app;
}