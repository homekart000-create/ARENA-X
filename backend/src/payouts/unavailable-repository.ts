import { PayoutError } from './contracts.js';
import type { PayoutListFilter, PayoutRepository, PayoutResult, PayoutWebhookEvent, PreparedPayout, WithdrawalDetail } from './contracts.js';

function unavailable(): never {
  throw new PayoutError(503, 'PAYOUT_STORAGE_UNAVAILABLE', 'Withdrawal storage is temporarily unavailable.');
}

export class UnavailablePayoutRepository implements PayoutRepository {
  async list(_filter?: PayoutListFilter) { return unavailable(); }
  async listForUser(_userId: string, _filter?: PayoutListFilter) { return unavailable(); }
  async get(_withdrawalRequestId: string) { return unavailable(); }
  async getForUser(_withdrawalRequestId: string, _userId: string) { return unavailable(); }
  async approve(_withdrawalRequestId: string, _adminUserId: string, _reason: string | null): Promise<WithdrawalDetail> { return unavailable(); }
  async reject(_withdrawalRequestId: string, _adminUserId: string, _reason: string): Promise<WithdrawalDetail> { return unavailable(); }
  async cancel(_withdrawalRequestId: string, _userId: string): Promise<WithdrawalDetail> { return unavailable(); }
  async preparePayout(_withdrawalRequestId: string, _adminUserId: string, _provider: string): Promise<PreparedPayout> { return unavailable(); }
  async recordPayoutResult(_prepared: PreparedPayout, _result: PayoutResult, _actorUserId: string, _action: 'created' | 'reconciled'): Promise<WithdrawalDetail> { return unavailable(); }
  async prepareReconciliation(_withdrawalRequestId: string, _adminUserId: string): Promise<PreparedPayout> { return unavailable(); }
  async recordWebhookEvent(_event: PayoutWebhookEvent): Promise<{ readonly duplicate: boolean; readonly withdrawalRequestId: string | null }> { return unavailable(); }
}
