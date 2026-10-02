import { buildApp } from './app.js';
import { config } from './config/env.js';
import { getDatabaseConfig } from './config/database.js';
import { PostgresAuthRepository, UnavailableAuthRepository } from './auth/postgres-repository.js';
import { PostgresCompetitionRepository } from './competition/postgres-repository.js';
import { UnavailableCompetitionRepository } from './competition/unavailable-repository.js';
import { PostgresWalletRepository } from './wallet/postgres-repository.js';
import { UnavailableWalletRepository } from './wallet/unavailable-repository.js';
import { WalletService } from './wallet/service.js';
import { PostgresPaymentRepository } from './payments/postgres-repository.js';
import { UnavailablePaymentRepository } from './payments/unavailable-repository.js';
import { Pool } from 'pg';

const databaseConfig = getDatabaseConfig(config);
const pool = databaseConfig ? new Pool({ connectionString: databaseConfig.connectionString }) : null;
const repository = pool ? new PostgresAuthRepository(pool) : new UnavailableAuthRepository();
const walletRepository = pool ? new PostgresWalletRepository(pool) : new UnavailableWalletRepository();
const walletService = new WalletService(walletRepository);
const competitionRepository = pool ? new PostgresCompetitionRepository(pool, walletService) : new UnavailableCompetitionRepository();
const paymentRepository = pool ? new PostgresPaymentRepository(pool, walletService) : new UnavailablePaymentRepository();
const app = buildApp(config, repository, competitionRepository, walletRepository, paymentRepository);

if (pool) {
  app.addHook('onClose', async () => pool.end());
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ err: error }, 'Backend failed to start');
  process.exitCode = 1;
}