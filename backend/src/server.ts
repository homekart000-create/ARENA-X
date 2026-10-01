import { buildApp } from './app.js';
import { config } from './config/env.js';

const app = buildApp(config);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ err: error }, 'Backend failed to start');
  process.exitCode = 1;
}