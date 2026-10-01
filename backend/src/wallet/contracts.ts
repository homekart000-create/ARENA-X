export type WalletStatus = 'active' | 'restricted' | 'closed';
export type WalletTransactionType = 'deposit' | 'withdrawal' | 'entry_fee' | 'winning' | 'refund' | 'adjustment';
export type WalletDirection = 'credit' | 'debit';
export type WalletTransactionStatus = 'pending' | 'completed' | 'failed' | 'reversed' | 'approved' | 'rejected' | 'cancelled';

export interface WalletView {
  readonly walletId: string;
  readonly userId: string;
  readonly currency: 'INR';
  readonly status: WalletStatus;
  readonly availableBalanceMinor: number;
  readonly reservedBalanceMinor: number;
  readonly totalDepositedMinor: number;
  readonly totalWithdrawnMinor: number;
  readonly totalWinningsMinor: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WalletTransactionView {
  readonly transactionId: string;
  readonly walletId: string;
  readonly userId: string;
  readonly type: WalletTransactionType;
  readonly direction: WalletDirection;
  readonly amountMinor: number;
  readonly currency: 'INR';
  readonly status: WalletTransactionStatus;
  readonly description: string;
  readonly referenceId: string | null;
  readonly relatedTransactionId: string | null;
  readonly createdAt: string;
}

export interface WalletTransactionFilter {
  readonly limit: number;
  readonly offset: number;
  readonly type?: WalletTransactionType;
  readonly status?: WalletTransactionStatus;
}

export interface WalletCommand {
  readonly userId: string;
  readonly type: WalletTransactionType;
  readonly direction: WalletDirection;
  readonly amountMinor: number;
  readonly idempotencyKey: string;
  readonly referenceId?: string;
  readonly relatedTransactionId?: string;
  readonly description?: string;
  readonly actorUserId?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface WalletCommandResult {
  readonly wallet: WalletView;
  readonly transaction: WalletTransactionView;
  readonly replayed: boolean;
}

export interface WithdrawalRequestView {
  readonly withdrawalRequestId: string;
  readonly transaction: WalletTransactionView;
  readonly wallet: WalletView;
  readonly replayed: boolean;
}

export interface WalletRepository {
  getWallet(userId: string): Promise<WalletView>;
  listTransactions(userId: string, filter: WalletTransactionFilter): Promise<readonly WalletTransactionView[]>;
  postTransaction(command: WalletCommand): Promise<WalletCommandResult>;
  requestWithdrawal(command: WalletCommand): Promise<WithdrawalRequestView>;
}

export class WalletError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = 'WalletError';
  }
}