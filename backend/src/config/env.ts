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
  readonly roomCredentialsKey?: Buffer;
  readonly razorpayWebhookSecret?: string;
  readonly razorpayKeySecret?: string;
  readonly razorpayKeyId?: string;
  readonly paymentsMode: 'disabled' | 'sandbox';
  readonly payoutMode: 'disabled';
  readonly withdrawalKycRequired: boolean;
  readonly minimumWithdrawalMinor: number;
  readonly maximumWithdrawalMinor: number;
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

  const encodedRoomKey = environment.ROOM_CREDENTIALS_KEY?.trim();
  let roomCredentialsKey: Buffer | undefined;
  if (encodedRoomKey) {
    roomCredentialsKey = Buffer.from(encodedRoomKey, 'base64');
    if (roomCredentialsKey.length !== 32 || roomCredentialsKey.toString('base64') !== encodedRoomKey) {
      throw new Error('ROOM_CREDENTIALS_KEY must be a base64-encoded 32-byte key.');
    }
  }

  const requestedPaymentsMode = environment.RAZORPAY_MODE ?? 'disabled';
  if (requestedPaymentsMode !== 'disabled' && requestedPaymentsMode !== 'sandbox') {
    throw new Error('RAZORPAY_MODE must be disabled or sandbox.');
  }
  const razorpayKeyId = environment.RAZORPAY_KEY_ID?.trim();
  const razorpayWebhookSecret = environment.RAZORPAY_WEBHOOK_SECRET?.trim();
  const razorpayKeySecret = environment.RAZORPAY_KEY_SECRET?.trim();
  if (razorpayKeyId && !/^rzp_test_[A-Za-z0-9]+$/.test(razorpayKeyId)) {
    throw new Error('RAZORPAY_KEY_ID must be a Razorpay test key.');
  }
  const paymentsMode = requestedPaymentsMode === 'sandbox'
    && razorpayKeyId && razorpayKeySecret && razorpayWebhookSecret
    ? 'sandbox'
    : 'disabled';

  const payoutMode = environment.PAYOUT_MODE ?? 'disabled';
  if (payoutMode !== 'disabled') {
    throw new Error('PAYOUT_MODE must be disabled; no live payout adapter is configured.');
  }
  const withdrawalKycRequiredValue = environment.WITHDRAWAL_KYC_REQUIRED;
  if (withdrawalKycRequiredValue !== undefined && withdrawalKycRequiredValue !== 'true' && withdrawalKycRequiredValue !== 'false') {
    throw new Error('WITHDRAWAL_KYC_REQUIRED must be true or false.');
  }
  if (nodeEnv === 'production' && withdrawalKycRequiredValue === 'false') {
    throw new Error('WITHDRAWAL_KYC_REQUIRED cannot be false in production.');
  }
  const withdrawalKycRequired = nodeEnv === 'production' || withdrawalKycRequiredValue === 'true';
  const minimumWithdrawalMinor = Number(environment.MINIMUM_WITHDRAWAL_MINOR ?? '1');
  const maximumWithdrawalMinor = Number(environment.MAXIMUM_WITHDRAWAL_MINOR ?? '100000000');
  if (!Number.isSafeInteger(minimumWithdrawalMinor) || minimumWithdrawalMinor < 1
    || !Number.isSafeInteger(maximumWithdrawalMinor) || maximumWithdrawalMinor < minimumWithdrawalMinor
    || maximumWithdrawalMinor > 100_000_000) {
    throw new Error('Withdrawal minimum and maximum must be whole paise with 1 <= minimum <= maximum <= 100000000.');
  }

  return {
    nodeEnv,
    host,
    port,
    ...(databaseUrl ? { databaseUrl } : {}),
    corsOrigins,
    authCookieName,
    sessionTtlSeconds: sessionTtlHours * 60 * 60,
    ...(roomCredentialsKey ? { roomCredentialsKey } : {}),
    ...(razorpayWebhookSecret ? { razorpayWebhookSecret } : {}),
    ...(razorpayKeySecret ? { razorpayKeySecret } : {}),
    ...(razorpayKeyId ? { razorpayKeyId } : {}),
    paymentsMode,
    payoutMode,
    withdrawalKycRequired,
    minimumWithdrawalMinor,
    maximumWithdrawalMinor
  };
}

export const config = parseEnvironment(process.env);