export type KycStatus = 'unverified' | 'pending' | 'verified' | 'rejected' | 'suspended';

export interface KycProfile {
  readonly userId: string;
  readonly status: KycStatus;
  readonly legalName: string | null;
  readonly country: string | null;
  readonly dateOfBirth: string | null;
  readonly verificationReference: string | null;
  readonly rejectionReason: string | null;
  readonly reviewedByUserId: string | null;
  readonly reviewedAt: string | null;
  readonly submittedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KycProfileInput {
  readonly legalName?: string | null;
  readonly country?: string | null;
  readonly dateOfBirth?: string | null;
  readonly verificationReference?: string | null;
}

export interface KycDecisionInput {
  readonly status: KycStatus;
  readonly reason?: string | null;
  readonly verificationReference?: string | null;
}

export interface KycListFilter {
  readonly limit?: number;
  readonly offset?: number;
  readonly status?: KycStatus;
}

export interface KycAuditEvent {
  readonly actorUserId: string;
  readonly fromStatus: KycStatus;
  readonly toStatus: KycStatus;
  readonly action: 'submitted' | 'reviewed' | 'rejected' | 'suspended' | 'reinstated';
  readonly reason: string | null;
  readonly createdAt: string;
}

export interface KycRepository {
  getByUserId(userId: string): Promise<KycProfile | null>;
  list(filter?: KycListFilter): Promise<readonly KycProfile[]>;
  listAuditEvents(userId: string): Promise<readonly KycAuditEvent[]>;
  createOrUpdate(userId: string, input: KycProfileInput & { readonly status?: KycStatus }): Promise<KycProfile>;
  review(userId: string, reviewerUserId: string, input: KycDecisionInput): Promise<KycProfile>;
}

export class KycError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = 'KycError';
  }
}

export function canTransitionKycStatus(from: KycStatus, to: KycStatus): boolean {
  if (from === to) return false;
  const allowedTransitions: ReadonlyMap<KycStatus, readonly KycStatus[]> = new Map([
    ['unverified', ['pending']],
    ['pending', ['verified', 'rejected']],
    ['verified', ['suspended']],
    ['rejected', ['pending']],
    ['suspended', ['verified', 'pending']]
  ]);
  return (allowedTransitions.get(from) ?? []).includes(to);
}
