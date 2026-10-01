import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/env.js';

export function registerCors(app: FastifyInstance, config: AppConfig): void {
  void app.register(cors, {
    origin: config.corsOrigins.length > 0 ? [...config.corsOrigins] : false,
    credentials: true
  });
}