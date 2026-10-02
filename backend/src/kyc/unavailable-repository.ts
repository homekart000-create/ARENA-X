import { KycError } from './contracts.js';
import type { KycDecisionInput, KycListFilter, KycProfile, KycProfileInput, KycRepository } from './contracts.js';

function unavailable(): never {
  throw new KycError(503, 'KYC_STORAGE_UNAVAILABLE', 'KYC storage is temporarily unavailable.');
}

export class UnavailableKycRepository implements KycRepository {
  async getByUserId(_userId: string): Promise<KycProfile | null> { return unavailable(); }
  async list(_filter?: KycListFilter): Promise<readonly KycProfile[]> { return unavailable(); }
  async listAuditEvents(_userId: string) { return unavailable(); }
  async createOrUpdate(_userId: string, _input: KycProfileInput): Promise<KycProfile> { return unavailable(); }
  async review(_userId: string, _reviewerUserId: string, _input: KycDecisionInput): Promise<KycProfile> { return unavailable(); }
}
