import type { KycDecisionInput, KycListFilter, KycProfile, KycProfileInput, KycRepository } from './contracts.js';
import { KycError, canTransitionKycStatus } from './contracts.js';

function normalizeOptionalText(value: string | null | undefined, maxLength: number, fieldName: string): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > maxLength) {
    throw new KycError(400, 'INVALID_KYC_FIELD', `${fieldName} is too long.`);
  }
  return trimmed;
}

function normalizeDate(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) {
    throw new KycError(400, 'INVALID_DATE_OF_BIRTH', 'Date of birth must be a valid YYYY-MM-DD value.');
  }
  if (parsed > new Date()) {
    throw new KycError(400, 'INVALID_DATE_OF_BIRTH', 'Date of birth cannot be in the future.');
  }
  return trimmed;
}

export class KycService {
  constructor(private readonly repository: KycRepository) {}

  async getProfile(userId: string): Promise<KycProfile | null> {
    return this.repository.getByUserId(userId);
  }

  async listProfiles(filter: KycListFilter = {}): Promise<readonly KycProfile[]> {
    return this.repository.list({
      limit: filter.limit ?? 25,
      offset: filter.offset ?? 0,
      ...(filter.status ? { status: filter.status } : {})
    });
  }

  async createOrUpdateProfile(userId: string, input: KycProfileInput): Promise<KycProfile> {
    if (input.legalName === undefined && input.country === undefined && input.dateOfBirth === undefined) {
      throw new KycError(400, 'EMPTY_KYC_SUBMISSION', 'At least one KYC field is required.');
    }
    const existing = await this.repository.getByUserId(userId);
    if (existing && (existing.status === 'verified' || existing.status === 'suspended')) {
      throw new KycError(409, 'KYC_PROFILE_LOCKED', 'Contact support before changing a verified or suspended KYC profile.');
    }
    const normalized = {
      legalName: input.legalName === undefined ? existing?.legalName ?? null : normalizeOptionalText(input.legalName, 120, 'Legal name'),
      country: input.country === undefined ? existing?.country ?? null : normalizeOptionalText(input.country, 80, 'Country'),
      dateOfBirth: input.dateOfBirth === undefined ? existing?.dateOfBirth ?? null : normalizeDate(input.dateOfBirth),
      verificationReference: existing?.verificationReference ?? null
    };
    if (!existing && Object.values(normalized).every((value) => value === null)) {
      throw new KycError(400, 'EMPTY_KYC_SUBMISSION', 'At least one KYC field must contain a value.');
    }
    return this.repository.createOrUpdate(userId, { ...normalized, status: 'pending' });
  }

  async reviewProfile(targetUserId: string, reviewerUserId: string, input: KycDecisionInput): Promise<KycProfile> {
    const current = await this.repository.getByUserId(targetUserId);
    if (!current) {
      throw new KycError(404, 'KYC_PROFILE_NOT_FOUND', 'No KYC record exists for this user.');
    }
    const status = input.status;
    if (!canTransitionKycStatus(current.status, status)) {
      throw new KycError(409, 'INVALID_KYC_STATUS_TRANSITION', `KYC status may not transition from ${current.status} to ${status}.`);
    }
    const normalizedReason = normalizeOptionalText(input.reason ?? null, 240, 'Review reason');
    const normalizedReference = normalizeOptionalText(input.verificationReference ?? null, 128, 'Verification reference');
    if (status === 'rejected' && !normalizedReason) {
      throw new KycError(400, 'REJECTION_REASON_REQUIRED', 'A reason is required when rejecting a KYC submission.');
    }
    return this.repository.review(targetUserId, reviewerUserId, {
      status,
      reason: normalizedReason,
      verificationReference: normalizedReference
    });
  }
}
