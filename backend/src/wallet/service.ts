import { createHash } from 'node:crypto';
import type { KycRepository } from '../kyc/contracts.js';
import type {
  TransactionalWalletRepository,
  WalletCommand,
  WalletCommandResult,
  WalletDirection,
  WalletRepository,
  WalletTransactionType,
  WalletView,
  WithdrawalRequestView
} from './contracts.js';
import { WalletError } from './contracts.js';
import type { PoolClient } from 'pg';

export const MAX_WALLET_AMOUNT_MINOR = 100_000_000;

export interface WalletOperationInput {
  readonly amountMinor: number;
  readonly idempotencyKey: string;
  readonly referenceId?: string;
  readonly relatedTransactionId?: string;
  readonly description?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface WithdrawalInput {
  readonly amountMinor: number;
  readonly idempotencyKey: string;
  readonly description?: string;
}

export class WalletService {
  constructor(
    private readonly repository: WalletRepository,
    private readonly kycRepository?: Pick<KycRepository, 'getByUserId'>,
    private readonly requireVerifiedKyc = false,
    private readonly minimumWithdrawalMinor = 1,
    private readonly maximumWithdrawalMinor = MAX_WALLET_AMOUNT_MINOR
  ) {}

  getWallet(userId: string): Promise<WalletView> {
    return this.repository.getWallet(userId);
  }

  listTransactions(userId: string, filter: Parameters<WalletRepository['listTransactions']>[1]) {
    return this.repository.listTransactions(userId, filter);
  }

  async credit(userId: string, type: 'deposit' | 'winning' | 'refund' | 'adjustment', input: WalletOperationInput, actorUserId?: string): Promise<WalletCommandResult> {
    return this.post(userId, type, 'credit', input, actorUserId);
  }

  async debit(userId: string, type: 'entry_fee' | 'adjustment', input: WalletOperationInput, actorUserId?: string): Promise<WalletCommandResult> {
    return this.post(userId, type, 'debit', input, actorUserId);
  }

  async refund(userId: string, input: WalletOperationInput, actorUserId?: string): Promise<WalletCommandResult> {
    return this.post(userId, 'refund', 'credit', input, actorUserId);
  }

  async winning(userId: string, input: WalletOperationInput, actorUserId?: string): Promise<WalletCommandResult> {
    return this.post(userId, 'winning', 'credit', input, actorUserId);
  }

  async tournamentEntryFee(userId: string, input: WalletOperationInput, actorUserId?: string): Promise<WalletCommandResult> {
    return this.post(userId, 'entry_fee', 'debit', input, actorUserId);
  }

  async creditWithinTransaction(
    client: PoolClient,
    userId: string,
    type: 'deposit' | 'winning' | 'refund' | 'adjustment',
    input: WalletOperationInput,
    actorUserId?: string
  ): Promise<WalletCommandResult> {
    return this.postWithinTransaction(client, userId, type, 'credit', input, actorUserId);
  }

  async tournamentEntryFeeWithinTransaction(
    client: PoolClient,
    userId: string,
    input: WalletOperationInput,
    actorUserId?: string
  ): Promise<WalletCommandResult> {
    return this.postWithinTransaction(client, userId, 'entry_fee', 'debit', input, actorUserId);
  }

  async refundWithinTransaction(
    client: PoolClient,
    userId: string,
    input: WalletOperationInput,
    actorUserId?: string
  ): Promise<WalletCommandResult> {
    return this.postWithinTransaction(client, userId, 'refund', 'credit', input, actorUserId);
  }

  async requestWithdrawal(userId: string, input: WithdrawalInput): Promise<WithdrawalRequestView> {
    if (!Number.isSafeInteger(input.amountMinor)
      || input.amountMinor < this.minimumWithdrawalMinor
      || input.amountMinor > this.maximumWithdrawalMinor) {
      throw new WalletError(400, 'INVALID_WITHDRAWAL_AMOUNT', 'Withdrawal amount is outside the configured integer-paise limits.');
    }
    const command = this.buildCommand(userId, 'withdrawal', 'debit', input);
    if (this.requireVerifiedKyc && !this.kycRepository) {
      throw new WalletError(503, 'KYC_UNAVAILABLE', 'Withdrawal verification is temporarily unavailable.');
    }
    if (this.requireVerifiedKyc && this.kycRepository) {
      const profile = await this.kycRepository.getByUserId(userId);
      if (!profile || profile.status !== 'verified') {
        throw new WalletError(403, 'KYC_REQUIRED', 'Withdrawal is unavailable until KYC has been verified.');
      }
    }
    return this.repository.requestWithdrawal(command);
  }

  private async post(userId: string, type: WalletTransactionType, direction: WalletDirection, input: WalletOperationInput, actorUserId?: string): Promise<WalletCommandResult> {
    return this.repository.postTransaction(this.buildCommand(userId, type, direction, input, actorUserId));
  }

  private async postWithinTransaction(
    client: PoolClient,
    userId: string,
    type: WalletTransactionType,
    direction: WalletDirection,
    input: WalletOperationInput,
    actorUserId?: string
  ): Promise<WalletCommandResult> {
    if (!('postTransactionWithinTransaction' in this.repository)
      || typeof this.repository.postTransactionWithinTransaction !== 'function') {
      throw new WalletError(503, 'WALLET_TRANSACTION_UNAVAILABLE', 'Atomic wallet transactions are temporarily unavailable.');
    }
    return this.repository.postTransactionWithinTransaction(
      client,
      this.buildCommand(userId, type, direction, input, actorUserId)
    );
  }

  private buildCommand(userId: string, type: WalletTransactionType, direction: WalletDirection, input: WalletOperationInput, actorUserId?: string): WalletCommand {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || input.amountMinor > MAX_WALLET_AMOUNT_MINOR) {
      throw new WalletError(400, 'INVALID_AMOUNT', 'Amount must be positive whole paise and within the allowed limit.');
    }
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(input.idempotencyKey)) {
      throw new WalletError(400, 'INVALID_IDEMPOTENCY_KEY', 'A valid idempotency key is required.');
    }
    const referenceId = input.referenceId?.trim();
    if (referenceId && referenceId.length > 120) throw new WalletError(400, 'INVALID_REFERENCE', 'Reference ID is too long.');
    const description = input.description?.trim() ?? '';
    if (description.length > 160) throw new WalletError(400, 'INVALID_DESCRIPTION', 'Description is too long.');
    const metadata = input.metadata ?? {};
    if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 4096) throw new WalletError(400, 'INVALID_METADATA', 'Transaction metadata is too large.');

    return {
      userId,
      type,
      direction,
      amountMinor: input.amountMinor,
      idempotencyKey: input.idempotencyKey,
      ...(referenceId ? { referenceId } : {}),
      ...(input.relatedTransactionId ? { relatedTransactionId: input.relatedTransactionId } : {}),
      ...(description ? { description } : {}),
      ...(actorUserId ? { actorUserId } : {}),
      metadata
    };
  }
}

export function walletRequestHash(command: WalletCommand): Buffer {
  const canonical = JSON.stringify({
    userId: command.userId,
    type: command.type,
    direction: command.direction,
    amountMinor: command.amountMinor,
    referenceId: command.referenceId ?? null,
    relatedTransactionId: command.relatedTransactionId ?? null,
    description: command.description ?? '',
    metadata: command.metadata ?? {}
  });
  return createHash('sha256').update(canonical).digest();
}