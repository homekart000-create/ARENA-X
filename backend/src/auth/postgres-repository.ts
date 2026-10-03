import type { Pool, PoolClient } from 'pg';
import {
  DatabaseUnavailableError,
  DuplicateAccountError,
  type AuthRepository,
  type AuthUser,
  type NewUserInput,
  type StoredCredentials
} from './contracts.js';

interface UserRow {
  readonly id: string;
  readonly full_name: string;
  readonly username: string;
  readonly email: string;
  readonly avatar: string | null;
  readonly status: string;
  readonly role: string;
  readonly created_at: Date | string;
  readonly password_hash?: string;
}

const userProjection = `
  u.id::text AS id,
  u.full_name,
  u.username,
  u.email_normalized AS email,
  u.avatar,
  u.status,
  u.created_at,
  COALESCE((
    SELECT ura.role
    FROM user_role_assignments ura
    WHERE ura.user_id = u.id AND ura.revoked_at IS NULL
    ORDER BY CASE WHEN ura.role = 'admin' THEN 0 ELSE 1 END
    LIMIT 1
  ), 'user') AS role`;

function mapUser(row: UserRow): AuthUser {
  return {
    userId: row.id,
    fullName: row.full_name,
    username: row.username,
    email: row.email,
    avatar: row.avatar,
    status: row.status,
    role: row.role,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString()
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly pool: Pool) {}

  async createUser(input: NewUserInput): Promise<AuthUser> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const result = await client.query<UserRow>(
        `INSERT INTO users (username, full_name, email_normalized, phone, date_of_birth, avatar)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id::text AS id, full_name, username, email_normalized AS email, avatar, status, created_at`,
        [input.username, input.fullName, input.email, input.phone ?? null, input.dateOfBirth ?? null, input.avatar]
      );
      const row = result.rows[0];
      if (!row) throw new DatabaseUnavailableError();

      await client.query(
        `INSERT INTO user_credentials (user_id, password_hash, hash_algorithm)
         VALUES ($1, $2, 'argon2id')`,
        [row.id, input.passwordHash]
      );
      await client.query(
        `INSERT INTO user_role_assignments (user_id, role) VALUES ($1, 'user')`,
        [row.id]
      );
      await client.query('COMMIT');

      return mapUser({ ...row, role: 'user' });
    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the original failure without leaking database details.
        }
      }
      if (isUniqueViolation(error)) throw new DuplicateAccountError();
      throw new DatabaseUnavailableError();
    } finally {
      client?.release();
    }
  }

  async findByIdentifier(identifier: string): Promise<StoredCredentials | null> {
    try {
      const result = await this.pool.query<UserRow>(
        `SELECT ${userProjection}, uc.password_hash
         FROM users u
         JOIN user_credentials uc ON uc.user_id = u.id
         WHERE lower(u.email_normalized) = lower($1) OR lower(u.username) = lower($1)
         LIMIT 1`,
        [identifier]
      );
      const row = result.rows[0];
      return row?.password_hash ? { user: mapUser(row), passwordHash: row.password_hash } : null;
    } catch {
      throw new DatabaseUnavailableError();
    }
  }

  async createSession(userId: string, tokenHash: Buffer, expiresAt: Date): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
        [userId, tokenHash, expiresAt]
      );
    } catch {
      throw new DatabaseUnavailableError();
    }
  }

  async findSessionUser(tokenHash: Buffer): Promise<AuthUser | null> {
    try {
      const result = await this.pool.query<UserRow>(
        `SELECT ${userProjection}
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1
           AND s.revoked_at IS NULL
           AND s.expires_at > now()
           AND u.status = 'active'
         LIMIT 1`,
        [tokenHash]
      );
      const row = result.rows[0];
      return row ? mapUser(row) : null;
    } catch {
      throw new DatabaseUnavailableError();
    }
  }

  async revokeSession(tokenHash: Buffer): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE auth_sessions SET revoked_at = now(), updated_at = now()
         WHERE token_hash = $1 AND revoked_at IS NULL`,
        [tokenHash]
      );
    } catch {
      throw new DatabaseUnavailableError();
    }
  }

  async closeOwnAccount(userId: string): Promise<boolean> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');

      const account = await client.query<{ readonly id: string }>(
        `SELECT id::text AS id FROM users WHERE id = $1 AND status = 'active' FOR UPDATE`,
        [userId]
      );
      if (!account.rows[0]) {
        await client.query('ROLLBACK');
        return false;
      }

      await client.query(
        `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()), updated_at = now()
         WHERE user_id = $1`,
        [userId]
      );
      await client.query(`DELETE FROM user_credentials WHERE user_id = $1`, [userId]);
      await client.query(
        `UPDATE user_role_assignments SET revoked_at = COALESCE(revoked_at, now())
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );
      await client.query(
        `UPDATE kyc_profiles
         SET legal_name = NULL,
             country = NULL,
             date_of_birth = NULL,
             verification_reference = NULL,
             rejection_reason = NULL,
             updated_at = now()
         WHERE user_id = $1`,
        [userId]
      );
      await client.query(
        `UPDATE users
         SET full_name = 'Deleted player',
             username = 'd' || left(md5(id::text), 19),
             email_normalized = 'deleted+' || id::text || '@deleted.invalid',
             phone = NULL,
             date_of_birth = NULL,
             avatar = NULL,
             status = 'closed',
             updated_at = now()
         WHERE id = $1 AND status = 'active'`,
        [userId]
      );

      await client.query('COMMIT');
      return true;
    } catch {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the original failure without leaking database details.
        }
      }
      throw new DatabaseUnavailableError();
    } finally {
      client?.release();
    }
  }
}

export class UnavailableAuthRepository implements AuthRepository {
  async createUser(_input: NewUserInput): Promise<AuthUser> {
    throw new DatabaseUnavailableError();
  }

  async findByIdentifier(_identifier: string): Promise<StoredCredentials | null> {
    throw new DatabaseUnavailableError();
  }

  async createSession(_userId: string, _tokenHash: Buffer, _expiresAt: Date): Promise<void> {
    throw new DatabaseUnavailableError();
  }

  async findSessionUser(_tokenHash: Buffer): Promise<AuthUser | null> {
    throw new DatabaseUnavailableError();
  }

  async revokeSession(_tokenHash: Buffer): Promise<void> {
    throw new DatabaseUnavailableError();
  }

  async closeOwnAccount(_userId: string): Promise<boolean> {
    throw new DatabaseUnavailableError();
  }
}