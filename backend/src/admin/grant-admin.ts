import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';

export type AdminGrantStatus = 'granted' | 'already-admin';

export class AdminGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminGrantError';
  }
}

interface AccountRow {
  readonly id: string;
  readonly username: string;
  readonly status: string;
}

interface RoleAssignmentRow {
  readonly revoked_at: Date | string | null;
}

interface AdminGrantResult {
  readonly status: AdminGrantStatus;
}

function normalizeIdentifier(value: string): string {
  const identifier = value.trim();
  if (!identifier || identifier.length > 254) {
    throw new AdminGrantError('Provide one exact email address or username (1-254 characters).');
  }
  return identifier.toLowerCase();
}

export function parseAdminGrantArguments(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== '--confirm') {
    throw new AdminGrantError('Usage: npm run admin:grant -- --confirm <exact-email-or-username>');
  }
  return normalizeIdentifier(args[1] ?? '');
}

export async function grantAdminByIdentifier(
  pool: Pick<Pool, 'connect'>,
  rawIdentifier: string
): Promise<AdminGrantResult> {
  const identifier = normalizeIdentifier(rawIdentifier);
  let client: PoolClient | undefined;
  let transactionStarted = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    const accountResult = await client.query<AccountRow>(
      `SELECT id::text AS id, username, status
       FROM users
       WHERE lower(email_normalized) = $1 OR lower(username) = $1
       FOR UPDATE`,
      [identifier]
    );
    if (accountResult.rows.length === 0) {
      throw new AdminGrantError('No account matches the supplied identifier.');
    }
    if (accountResult.rows.length !== 1) {
      throw new AdminGrantError('The identifier matches multiple accounts; use the exact email address.');
    }

    const account = accountResult.rows[0]!;
    if (account.status !== 'active') {
      throw new AdminGrantError('The matching account is not active.');
    }

    const assignmentResult = await client.query<RoleAssignmentRow>(
      `SELECT revoked_at
       FROM user_role_assignments
       WHERE user_id = $1 AND role = 'admin'
       FOR UPDATE`,
      [account.id]
    );
    const assignment = assignmentResult.rows[0];
    if (assignment && assignment.revoked_at === null) {
      await client.query('COMMIT');
      transactionStarted = false;
      return { status: 'already-admin' };
    }

    if (assignment) {
      await client.query(
        `UPDATE user_role_assignments
         SET assigned_at = now(), revoked_at = NULL
         WHERE user_id = $1 AND role = 'admin' AND revoked_at IS NOT NULL`,
        [account.id]
      );
    } else {
      await client.query(
        `INSERT INTO user_role_assignments (user_id, role)
         VALUES ($1, 'admin')`,
        [account.id]
      );
    }

    await client.query('COMMIT');
    transactionStarted = false;
    return { status: 'granted' };
  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original error; the CLI reports database failures safely.
      }
    }
    throw error;
  } finally {
    client?.release();
  }
}

function databaseConnectionString(): string {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new AdminGrantError('DATABASE_URL must be set in the operator environment.');
  }
  try {
    const url = new URL(connectionString);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error();
  } catch {
    throw new AdminGrantError('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }
  return connectionString;
}

async function main(): Promise<void> {
  const identifier = parseAdminGrantArguments(process.argv.slice(2));
  const pool = new Pool({ connectionString: databaseConnectionString() });
  try {
    const result = await grantAdminByIdentifier(pool, identifier);
    console.log(result.status === 'granted'
      ? 'Admin role granted.'
      : 'Account already has an active admin role.');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof AdminGrantError
      ? error.message
      : 'Admin grant failed. Check database connectivity and migration status; sensitive details were not logged.');
    process.exitCode = 1;
  });
}
