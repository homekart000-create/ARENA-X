import type { KycAuditEvent, KycDecisionInput, KycListFilter, KycProfile, KycProfileInput, KycRepository, KycStatus } from './contracts.js';
import { KycError, canTransitionKycStatus } from './contracts.js';

export class InMemoryKycRepository implements KycRepository {
  private readonly profiles = new Map<string, KycProfile>();
  private readonly auditEvents = new Map<string, KycAuditEvent[]>();

  private timestamp(): string {
    return new Date().toISOString();
  }

  async getByUserId(userId: string): Promise<KycProfile | null> {
    const profile = this.profiles.get(userId);
    return profile ? { ...profile } : null;
  }

  async list(filter: KycListFilter = {}): Promise<readonly KycProfile[]> {
    const records = Array.from(this.profiles.values()).filter((profile) =>
      (!filter.status || profile.status === filter.status)
    );
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? records.length;
    return records
      .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt) || second.userId.localeCompare(first.userId))
      .slice(offset, offset + limit);
  }

  async listAuditEvents(userId: string): Promise<readonly KycAuditEvent[]> {
    return (this.auditEvents.get(userId) ?? []).map((event) => ({ ...event }));
  }

  async createOrUpdate(userId: string, input: KycProfileInput & { readonly status?: KycStatus }): Promise<KycProfile> {
    const current = this.profiles.get(userId);
    const now = this.timestamp();
    const nextStatus = input.status ?? current?.status ?? 'pending';
    const fromStatus = current?.status ?? 'unverified';
    if (!canTransitionKycStatus(fromStatus, nextStatus)) {
      throw new KycError(409, 'INVALID_KYC_STATUS_TRANSITION', `KYC status may not transition from ${fromStatus} to ${nextStatus}.`);
    }
    const next: KycProfile = {
      userId,
      status: nextStatus,
      legalName: input.legalName ?? current?.legalName ?? null,
      country: input.country ?? current?.country ?? null,
      dateOfBirth: input.dateOfBirth ?? current?.dateOfBirth ?? null,
      verificationReference: input.verificationReference ?? current?.verificationReference ?? null,
      rejectionReason: nextStatus === 'pending' ? null : current?.rejectionReason ?? null,
      reviewedByUserId: nextStatus === 'pending' ? null : current?.reviewedByUserId ?? null,
      reviewedAt: nextStatus === 'pending' ? null : current?.reviewedAt ?? null,
      submittedAt: current?.submittedAt ?? now,
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    };
    this.profiles.set(userId, next);
    this.addAudit(userId, {
      actorUserId: userId, fromStatus, toStatus: nextStatus, action: 'submitted', reason: null, createdAt: now
    });
    return { ...next };
  }

  async review(userId: string, reviewerUserId: string, input: KycDecisionInput): Promise<KycProfile> {
    const current = this.profiles.get(userId);
    if (!current) {
      throw new KycError(404, 'KYC_PROFILE_NOT_FOUND', 'No KYC record exists for this user.');
    }
    if (!canTransitionKycStatus(current.status, input.status)) {
      throw new KycError(409, 'INVALID_KYC_STATUS_TRANSITION', `KYC status may not transition from ${current.status} to ${input.status}.`);
    }
    const now = this.timestamp();
    const next: KycProfile = {
      ...current,
      status: input.status,
      verificationReference: input.verificationReference ?? current.verificationReference,
      rejectionReason: input.status === 'rejected' ? input.reason ?? current.rejectionReason ?? 'Rejected by administrator.' : null,
      reviewedByUserId: reviewerUserId,
      reviewedAt: now,
      updatedAt: now
    };
    this.profiles.set(userId, next);
    const action = input.status === 'rejected' ? 'rejected'
      : input.status === 'suspended' ? 'suspended'
        : input.status === 'verified' && current.status === 'suspended' ? 'reinstated' : 'reviewed';
    this.addAudit(userId, {
      actorUserId: reviewerUserId,
      fromStatus: current.status,
      toStatus: input.status,
      action,
      reason: input.reason ?? null,
      createdAt: now
    });
    return { ...next };
  }

  private addAudit(userId: string, event: KycAuditEvent): void {
    const events = this.auditEvents.get(userId) ?? [];
    events.push(event);
    this.auditEvents.set(userId, events);
  }
}
