import 'dotenv/config';

export type NodeEnvironment = 'development' | 'test' | 'production';

export interface AppConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly host: string;
  readonly port: number;
  readonly databaseUrl?: string;
  readonly corsOrigins: readonly string[];
  readonly authCookieName: string;
  readonly sessionTtlSeconds: number;
}

export function parseEnvironment(environment: NodeJS.ProcessEnv): AppConfig {
  const nodeEnv = environment.NODE_ENV ?? 'development';
  if (nodeEnv !== 'development' && nodeEnv !== 'test' && nodeEnv !== 'production') {
    throw new Error('NODE_ENV must be development, test, or production.');
  }

  const port = Number(environment.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  const host = environment.HOST?.trim() || '127.0.0.1';
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (databaseUrl) {
    try {
      const parsedUrl = new URL(databaseUrl);
      if (parsedUrl.protocol !== 'postgres:' && parsedUrl.protocol !== 'postgresql:') {
        throw new Error();
      }
    } catch {
      throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
    }
  }

  const corsOrigins = (environment.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of corsOrigins) {
    try {
      const parsedOrigin = new URL(origin);
      if ((parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') || parsedOrigin.origin !== origin) {
        throw new Error();
      }
    } catch {
      throw new Error('CORS_ORIGINS must contain exact http or https origins.');
    }
  }

  if (nodeEnv === 'production' && corsOrigins.length === 0) {
    throw new Error('CORS_ORIGINS must be configured in production.');
  }

  const authCookieName = environment.AUTH_COOKIE_NAME?.trim() || 'arena_x_session';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(authCookieName)) {
    throw new Error('AUTH_COOKIE_NAME must contain only letters, numbers, underscores, or hyphens.');
  }

  const sessionTtlHours = Number(environment.SESSION_TTL_HOURS ?? '168');
  if (!Number.isInteger(sessionTtlHours) || sessionTtlHours < 1 || sessionTtlHours > 720) {
    throw new Error('SESSION_TTL_HOURS must be an integer between 1 and 720.');
  }

  return {
    nodeEnv,
    host,
    port,
    ...(databaseUrl ? { databaseUrl } : {}),
    corsOrigins,
    authCookieName,
    sessionTtlSeconds: sessionTtlHours * 60 * 60
  };
}

export const config = parseEnvironment(process.env);