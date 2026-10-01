import type { AppConfig } from './env.js';

export interface DatabaseConfig {
  readonly connectionString: string;
}

export function getDatabaseConfig(config: AppConfig): DatabaseConfig | null {
  return config.databaseUrl ? { connectionString: config.databaseUrl } : null;
}