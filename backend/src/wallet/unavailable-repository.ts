import { WalletError } from './contracts.js';
import type { WalletRepository } from './contracts.js';
import type { WalletCommand } from './contracts.js';

function unavailable(): never {
  throw new WalletError(503, 'SERVICE_UNAVAILABLE', 'Wallet storage is temporarily unavailable.');
}

export class UnavailableWalletRepository implements WalletRepository {
  async getWallet(_userId: string) { return unavailable(); }
  async listTransactions(_userId: string, _filter: Parameters<WalletRepository['listTransactions']>[1]) { return unavailable(); }
  async postTransaction(_command: WalletCommand) { return unavailable(); }
  async requestWithdrawal(_command: WalletCommand) { return unavailable(); }
}