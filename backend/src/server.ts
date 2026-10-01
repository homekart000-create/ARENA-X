import { buildApp } from './app.js';
import { config } from './config/env.js';
import { getDatabaseConfig } from './config/database.js';
import { PostgresAuthRepository, UnavailableAuthRepository } from './auth/postgres-repository.js';
import { Pool } from 'pg';

const databaseConfig = getDatabaseConfig(config);
const pool = databaseConfig ? new Pool({ connectionString: databaseConfig.connectionString }) : null;
const repository = pool ? new PostgresAuthRepository(pool) : new UnavailableAuthRepository();
const app = buildApp(config, repository);

if (pool) {
  app.addHook('onClose', async () => pool.end());
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ err: error }, 'Backend failed to start');
  process.exitCode = 1;
}