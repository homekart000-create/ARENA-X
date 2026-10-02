import type { Pool, PoolClient } from 'pg';
import type { KycAuditEvent, KycDecisionInput, KycListFilter, KycProfile, KycProfileInput, KycRepository, KycStatus } from './contracts.js';
import { KycError, canTransitionKycStatus } from './contracts.js';

interface KycRow {
  readonly user_id: string;
  readonly status: KycStatus;
  readonly legal_name: string | null;
  readonly country: string | null;
  readonly date_of_birth: string | null;
  readonly verification_reference: string | null;
  readonly rejection_reason: string | null;
  readonly reviewed_by_user_id: string | null;
  readonly reviewed_at: Date | string | null;
  readonly submitted_at: Date | string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapProfile(row: KycRow): KycProfile {
  return {
    userId: row.user_id,
    status: row.status,
    legalName: row.legal_name,
    country: row.country,
    dateOfBirth: row.date_of_birth,
    verificationReference: row.verification_reference,
    rejectionReason: row.rejection_reason,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedAt: iso(row.reviewed_at),
    submittedAt: iso(row.submitted_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!
  };
}

export class PostgresKycRepository implements KycRepository {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Keep the original repository error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async getForUpdate(client: PoolClient, userId: string): Promise<KycProfile | null> {
    const result = await client.query<KycRow>(`SELECT user_id::text AS user_id, status, legal_name, country, date_of_birth::text AS date_of_birth,
      verification_reference, rejection_reason, reviewed_by_user_id::text AS reviewed_by_user_id, reviewed_at, submitted_at, created_at, updated_at
      FROM kyc_profiles WHERE user_id=$1 FOR UPDATE`, [userId]);
    return result.rows[0] ? mapProfile(result.rows[0]) : null;
  }

  private async audit(
    client: PoolClient,
    userId: string,
    actorUserId: string,
    fromStatus: KycStatus,
    toStatus: KycStatus,
    action: 'submitted' | 'reviewed' | 'rejected' | 'suspended' | 'reinstated',
    reason: string | null
  ): Promise<void> {
    await client.query(`INSERT INTO kyc_audit_events (user_id, actor_user_id, from_status, to_status, action, reason)
      VALUES ($1,$2,$3,$4,$5,$6)`, [userId, actorUserId, fromStatus, toStatus, action, reason]);
  }

  async getByUserId(userId: string): Promise<KycProfile | null> {
    const result = await this.pool.query<KycRow>(`SELECT user_id::text AS user_id, status, legal_name, country, date_of_birth::text AS date_of_birth,
      verification_reference, rejection_reason, reviewed_by_user_id::text AS reviewed_by_user_id, reviewed_at, submitted_at, created_at, updated_at
      FROM kyc_profiles WHERE user_id=$1`, [userId]);
    return result.rows[0] ? mapProfile(result.rows[0]) : null;
  }

  async list(filter: KycListFilter = {}): Promise<readonly KycProfile[]> {
    const limit = filter.limit ?? 25;
    const offset = filter.offset ?? 0;
    const result = await this.pool.query<KycRow>(`SELECT user_id::text AS user_id, status, legal_name, country, date_of_birth::text AS date_of_birth,
      verification_reference, rejection_reason, reviewed_by_user_id::text AS reviewed_by_user_id, reviewed_at, submitted_at, created_at, updated_at
      FROM kyc_profiles WHERE ($1::text IS NULL OR status=$1)
      ORDER BY updated_at DESC, user_id DESC LIMIT $2 OFFSET $3`, [filter.status ?? null, limit, offset]);
    return result.rows.map(mapProfile);
  }

  async listAuditEvents(userId: string): Promise<readonly KycAuditEvent[]> {
    const result = await this.pool.query<{
      actor_user_id: string;
      from_status: KycStatus;
      to_status: KycStatus;
      action: KycAuditEvent['action'];
      reason: string | null;
      created_at: Date | string;
    }>(`SELECT actor_user_id::text AS actor_user_id, from_status, to_status, action, reason, created_at
       FROM kyc_audit_events WHERE user_id=$1 ORDER BY created_at, id`, [userId]);
    return result.rows.map((row) => ({
      actorUserId: row.actor_user_id,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      action: row.action,
      reason: row.reason,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString()
    }));
  }

  async createOrUpdate(userId: string, input: KycProfileInput & { readonly status?: KycStatus }): Promise<KycProfile> {
    return this.transaction(async (client) => {
      const current = await this.getForUpdate(client, userId);
      const fromStatus = current?.status ?? 'unverified';
      const status = input.status ?? 'pending';
      if (!canTransitionKycStatus(fromStatus, status)) {
        throw new KycError(409, 'INVALID_KYC_STATUS_TRANSITION', `KYC status may not transition from ${fromStatus} to ${status}.`);
      }
      if (current && (current.status === 'verified' || current.status === 'suspended')) {
        throw new KycError(409, 'KYC_PROFILE_LOCKED', 'Contact support before changing a verified or suspended KYC profile.');
      }
      const result = await client.query<KycRow>(`INSERT INTO kyc_profiles (
        user_id, status, legal_name, country, date_of_birth, verification_reference,
        rejection_reason, reviewed_by_user_id, reviewed_at, submitted_at, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,NULL,now(),now(),now())
      ON CONFLICT (user_id) DO UPDATE SET
        status=EXCLUDED.status, legal_name=EXCLUDED.legal_name, country=EXCLUDED.country,
        date_of_birth=EXCLUDED.date_of_birth, verification_reference=EXCLUDED.verification_reference,
        rejection_reason=NULL, reviewed_by_user_id=NULL, reviewed_at=NULL,
        submitted_at=now(), updated_at=now()
      RETURNING user_id::text AS user_id, status, legal_name, country, date_of_birth::text AS date_of_birth,
        verification_reference, rejection_reason, reviewed_by_user_id::text AS reviewed_by_user_id,
        reviewed_at, submitted_at, created_at, updated_at`,
      [userId, status, input.legalName ?? null, input.country ?? null, input.dateOfBirth ?? null, input.verificationReference ?? null]);
      const row = result.rows[0];
      if (!row) throw new Error('KYC profile could not be created.');
      await this.audit(client, userId, userId, fromStatus, status, 'submitted', null);
      return mapProfile(row);
    });
  }

  async review(userId: string, reviewerUserId: string, input: KycDecisionInput): Promise<KycProfile> {
    return this.transaction(async (client) => {
      const current = await this.getForUpdate(client, userId);
      if (!current) throw new KycError(404, 'KYC_PROFILE_NOT_FOUND', 'No KYC record exists for this user.');
      if (input.status === current.status || !canTransitionKycStatus(current.status, input.status)) {
        throw new KycError(409, 'INVALID_KYC_STATUS_TRANSITION', `KYC status may not transition from ${current.status} to ${input.status}.`);
      }
      if (input.status === 'rejected' && !input.reason) {
        throw new KycError(400, 'REJECTION_REASON_REQUIRED', 'A reason is required when rejecting a KYC submission.');
      }
      const result = await client.query<KycRow>(`UPDATE kyc_profiles SET status=$1, rejection_reason=$2,
        verification_reference=COALESCE($3,verification_reference), reviewed_by_user_id=$4, reviewed_at=now(), updated_at=now()
        WHERE user_id=$5 RETURNING user_id::text AS user_id, status, legal_name, country, date_of_birth::text AS date_of_birth,
        verification_reference, rejection_reason, reviewed_by_user_id::text AS reviewed_by_user_id,
        reviewed_at, submitted_at, created_at, updated_at`,
      [input.status, input.status === 'rejected' ? input.reason : null, input.verificationReference ?? null, reviewerUserId, userId]);
      const row = result.rows[0];
      if (!row) throw new KycError(404, 'KYC_PROFILE_NOT_FOUND', 'No KYC record exists for this user.');
      const action = input.status === 'rejected' ? 'rejected'
        : input.status === 'suspended' ? 'suspended'
          : input.status === 'verified' && current.status === 'suspended' ? 'reinstated' : 'reviewed';
      await this.audit(client, userId, reviewerUserId, current.status, input.status, action, input.reason ?? null);
      return mapProfile(row);
    });
  }
}
