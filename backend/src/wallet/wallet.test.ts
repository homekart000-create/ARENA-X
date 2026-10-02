import assert from 'node:assert/strict';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { AppConfig } from '../config/env.js';
import { parseEnvironment } from '../config/env.js';
import type { AuthRepository, AuthUser, NewUserInput, StoredCredentials } from '../auth/contracts.js';
import { hashSessionToken } from '../auth/session.js';
import type {
  WalletCommand,
  WalletCommandResult,
  WalletRepository,
  WalletTransactionFilter,
  WalletTransactionView,
  WalletView,
  WithdrawalRequestView
} from './contracts.js';
import { WalletError } from './contracts.js';
import { WalletService } from './service.js';
import { walletRequestHash } from './service.js';

const ORIGIN = 'http://localhost:5500';

class MemoryWalletRepository implements WalletRepository {
  private readonly wallets = new Map<string, WalletView>();
  private readonly transactions: Array<{ view: WalletTransactionView; hash: Buffer; request: WalletCommand }> = [];
  private readonly lockQueue = new Map<string, Promise<void>>();
  private readonly referenceIds = new Map<string, string>();
  private readonly withdrawalIds = new Map<string, string>();
  private lastTransactionTime = 0;
  failNextProjectionUpdate = false;
  failNextLedgerInsert = false;
  ledgerEntries = 0;

  private createWallet(userId: string): WalletView {
    const now = new Date().toISOString();
    return {
      walletId: randomUUID(), userId, currency: 'INR', status: 'active',
      availableBalanceMinor: 0, reservedBalanceMinor: 0,
      totalDepositedMinor: 0, totalWithdrawnMinor: 0, totalWinningsMinor: 0,
      version: 0, createdAt: now, updatedAt: now
    };
  }

  private async exclusive<T>(userId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.lockQueue.get(userId) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.lockQueue.set(userId, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.lockQueue.get(userId) === current) this.lockQueue.delete(userId);
    }
  }

  private getOrCreateWallet(userId: string): WalletView {
    const wallet = this.wallets.get(userId) ?? this.createWallet(userId);
    this.wallets.set(userId, wallet);
    return wallet;
  }

  private nextTransactionTimestamp(): string {
    this.lastTransactionTime = Math.max(Date.now(), this.lastTransactionTime + 1);
    return new Date(this.lastTransactionTime).toISOString();
  }

  async getWallet(userId: string): Promise<WalletView> {
    return this.getOrCreateWallet(userId);
  }

  async listTransactions(userId: string, filter: WalletTransactionFilter): Promise<readonly WalletTransactionView[]> {
    return this.transactions.map((entry) => entry.view)
      .filter((transaction) => transaction.userId === userId
        && (!filter.type || transaction.type === filter.type)
        && (!filter.status || transaction.status === filter.status))
      .sort((first, second) => second.createdAt.localeCompare(first.createdAt) || second.transactionId.localeCompare(first.transactionId))
      .slice(filter.offset, filter.offset + filter.limit);
  }

  async postTransaction(command: WalletCommand): Promise<WalletCommandResult> {
    return this.exclusive(command.userId, async () => this.execute(command, false));
  }

  async requestWithdrawal(command: WalletCommand): Promise<WithdrawalRequestView> {
    return this.exclusive(command.userId, async () => {
      const result = await this.execute(command, true);
      let requestId = this.withdrawalIds.get(result.transaction.transactionId);
      if (!requestId) {
        requestId = randomUUID();
        this.withdrawalIds.set(result.transaction.transactionId, requestId);
      }
      return {
        withdrawalRequestId: requestId,
        transaction: result.transaction,
        wallet: result.wallet,
        replayed: result.replayed
      };
    });
  }

  private async execute(command: WalletCommand, reserve: boolean): Promise<WalletCommandResult> {
    const wallet = this.getOrCreateWallet(command.userId);
    if (wallet.status !== 'active') throw new WalletError(403, 'WALLET_RESTRICTED', 'This wallet is not available for transactions.');
    const requestHash = walletRequestHash(command);
    const replay = this.transactions.find((entry) => entry.view.userId === command.userId && entry.request.idempotencyKey === command.idempotencyKey);
    if (replay) {
      if (replay.hash.length !== requestHash.length || !timingSafeEqual(replay.hash, requestHash)) throw new WalletError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was used for a different request.');
      return { wallet, transaction: replay.view, replayed: true };
    }
    if (reserve && this.transactions.some((entry) =>
      entry.view.userId === command.userId && entry.view.type === 'withdrawal' && entry.view.status === 'pending'
    )) {
      throw new WalletError(409, 'WITHDRAWAL_ALREADY_ACTIVE', 'A withdrawal request is already being reviewed or processed.');
    }
    if (command.referenceId && this.referenceIds.has(command.referenceId)) throw new WalletError(409, 'DUPLICATE_TRANSACTION', 'This reference has already been processed.');
    if (command.direction === 'debit' && wallet.availableBalanceMinor < command.amountMinor) throw new WalletError(409, 'INSUFFICIENT_FUNDS', 'Available wallet balance is insufficient.');

    const priorWallet = wallet;
    const priorTransactionCount = this.transactions.length;
    const priorEntries = this.ledgerEntries;
    try {
      const availableDelta = command.direction === 'credit' ? command.amountMinor : -command.amountMinor;
      const nextWallet: WalletView = {
        ...wallet,
        availableBalanceMinor: wallet.availableBalanceMinor + availableDelta,
        reservedBalanceMinor: wallet.reservedBalanceMinor + (reserve ? command.amountMinor : 0),
        totalDepositedMinor: wallet.totalDepositedMinor + (command.type === 'deposit' ? command.amountMinor : 0),
        totalWithdrawnMinor: wallet.totalWithdrawnMinor,
        totalWinningsMinor: wallet.totalWinningsMinor + (command.type === 'winning' ? command.amountMinor : 0),
        version: wallet.version + 1,
        updatedAt: new Date().toISOString()
      };
      if (nextWallet.availableBalanceMinor < 0 || nextWallet.reservedBalanceMinor < 0) throw new WalletError(409, 'INSUFFICIENT_FUNDS', 'Available wallet balance is insufficient.');
      const transaction: WalletTransactionView = {
        transactionId: randomUUID(), walletId: wallet.walletId, userId: command.userId,
        type: command.type, direction: command.direction, amountMinor: command.amountMinor,
        currency: 'INR', status: reserve ? 'pending' : 'completed', description: command.description ?? '',
        referenceId: command.referenceId ?? null, relatedTransactionId: command.relatedTransactionId ?? null,
        createdAt: this.nextTransactionTimestamp()
      };
      this.transactions.push({ view: transaction, hash: requestHash, request: command });
      if (command.referenceId) this.referenceIds.set(command.referenceId, transaction.transactionId);

      if (this.failNextProjectionUpdate) {
        this.failNextProjectionUpdate = false;
        throw new WalletError(503, 'BALANCE_WRITE_FAILED', 'Wallet projection update failed.');
      }
      this.wallets.set(command.userId, nextWallet);

      if (this.failNextLedgerInsert) {
        this.failNextLedgerInsert = false;
        throw new WalletError(503, 'LEDGER_WRITE_FAILED', 'Ledger write failed.');
      }

      this.ledgerEntries += 2;
      if (reserve) this.withdrawalIds.set(transaction.transactionId, randomUUID());
      return { wallet: nextWallet, transaction, replayed: false };
    } catch (error) {
      this.wallets.set(command.userId, priorWallet);
      this.transactions.length = priorTransactionCount;
      this.ledgerEntries = priorEntries;
      if (command.referenceId) this.referenceIds.delete(command.referenceId);
      throw error;
    }
  }
}

class WalletTestAuthRepository implements AuthRepository {
  private readonly users = new Map<string, StoredCredentials>();
  private readonly sessions = new Map<string, string>();

  addUser(role: 'user' | 'admin' = 'user'): AuthUser {
    const user: AuthUser = {
      userId: randomUUID(), fullName: 'Wallet Test User', username: `${role}_${randomUUID().slice(0, 8)}`,
      email: `${randomUUID()}@example.test`, avatar: null, status: 'active', role, createdAt: new Date().toISOString()
    };
    this.users.set(user.userId, { user, passwordHash: 'test-only-hash' });
    return user;
  }

  addSession(userId: string, token: string): void {
    this.sessions.set(hashSessionToken(token).toString('hex'), userId);
  }

  async createUser(_input: NewUserInput): Promise<AuthUser> { throw new Error('Not used by wallet API tests.'); }
  async findByIdentifier(_identifier: string): Promise<StoredCredentials | null> { return null; }
  async createSession(userId: string, tokenHash: Buffer): Promise<void> { this.sessions.set(tokenHash.toString('hex'), userId); }
  async findSessionUser(tokenHash: Buffer): Promise<AuthUser | null> {
    const userId = this.sessions.get(tokenHash.toString('hex'));
    return userId ? this.users.get(userId)?.user ?? null : null;
  }
  async revokeSession(tokenHash: Buffer): Promise<void> { this.sessions.delete(tokenHash.toString('hex')); }
}

interface WalletHarness {
  readonly app: FastifyInstance;
  readonly service: WalletService;
  readonly repository: MemoryWalletRepository;
  readonly user: AuthUser;
  readonly otherUser: AuthUser;
  readonly userCookie: string;
  readonly otherCookie: string;
  readonly adminCookie: string;
}

async function createWalletHarness(context: TestContext): Promise<WalletHarness> {
  const config: AppConfig = parseEnvironment({ NODE_ENV: 'test', CORS_ORIGINS: ORIGIN });
  const auth = new WalletTestAuthRepository();
  const user = auth.addUser();
  const otherUser = auth.addUser();
  const admin = auth.addUser('admin');
  const repository = new MemoryWalletRepository();
  const service = new WalletService(repository);
  const app = buildApp(config, auth, undefined, repository);
  context.after(async () => app.close());
  const userToken = randomBytes(24).toString('base64url');
  const otherToken = randomBytes(24).toString('base64url');
  const adminToken = randomBytes(24).toString('base64url');
  auth.addSession(user.userId, userToken);
  auth.addSession(otherUser.userId, otherToken);
  auth.addSession(admin.userId, adminToken);
  return {
    app, service, repository, user, otherUser,
    userCookie: `arena_x_session=${userToken}`,
    otherCookie: `arena_x_session=${otherToken}`,
    adminCookie: `arena_x_session=${adminToken}`
  };
}

const key = (value: string) => `wallet-test-key-${value.padStart(12, '0')}`;

async function credit(harness: WalletHarness, amountMinor: number, idempotencyKey = key(randomUUID())) {
  return harness.service.credit(harness.user.userId, 'deposit', { amountMinor, idempotencyKey });
}

test('creates a zeroed INR wallet for a new authenticated user', async (context) => {
  const harness = await createWalletHarness(context);
  const wallet = await harness.service.getWallet(harness.user.userId);
  assert.equal(wallet.currency, 'INR');
  assert.equal(wallet.availableBalanceMinor, 0);
  assert.equal(wallet.reservedBalanceMinor, 0);
  assert.equal(wallet.version, 0);
});

test('wallet APIs require authentication and expose only the session user', async (context) => {
  const harness = await createWalletHarness(context);
  const unauthenticated = await harness.app.inject({ method: 'GET', url: '/api/wallet' });
  const self = await harness.app.inject({ method: 'GET', url: '/api/wallet', headers: { cookie: harness.userCookie } });
  const forgedQuery = await harness.app.inject({ method: 'GET', url: `/api/wallet?userId=${harness.otherUser.userId}`, headers: { cookie: harness.userCookie } });
  const adminQuery = await harness.app.inject({ method: 'GET', url: `/api/wallet/transactions?userId=${harness.otherUser.userId}`, headers: { cookie: harness.adminCookie } });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(self.statusCode, 200);
  assert.equal(self.json().wallet.userId, harness.user.userId);
  assert.equal(forgedQuery.statusCode, 400);
  assert.equal(adminQuery.statusCode, 400);
});

test('credits update the projection and immutable transaction in integer paise', async (context) => {
  const harness = await createWalletHarness(context);
  const result = await credit(harness, 10001);
  assert.equal(result.wallet.availableBalanceMinor, 10001);
  assert.equal(result.transaction.amountMinor, 10001);
  assert.equal(result.transaction.status, 'completed');
  assert.equal(result.wallet.totalDepositedMinor, 10001);
  assert.equal(harness.repository.ledgerEntries, 2);
});

test('debits are server-side and reduce available balance', async (context) => {
  const harness = await createWalletHarness(context);
  await credit(harness, 5000);
  const result = await harness.service.tournamentEntryFee(harness.user.userId, { amountMinor: 1250, idempotencyKey: key('entryfee') });
  assert.equal(result.wallet.availableBalanceMinor, 3750);
  assert.equal(result.transaction.type, 'entry_fee');
  assert.equal(result.transaction.direction, 'debit');
});

test('insufficient funds do not create transactions or negative balances', async (context) => {
  const harness = await createWalletHarness(context);
  await assert.rejects(
    harness.service.tournamentEntryFee(harness.user.userId, { amountMinor: 1, idempotencyKey: key('insufficient') }),
    (error: unknown) => error instanceof WalletError && error.code === 'INSUFFICIENT_FUNDS'
  );
  assert.equal((await harness.service.getWallet(harness.user.userId)).availableBalanceMinor, 0);
  assert.equal((await harness.service.listTransactions(harness.user.userId, { limit: 20, offset: 0 })).length, 0);
});

test('rejects zero, negative, fractional, and over-limit paise amounts', async (context) => {
  const harness = await createWalletHarness(context);
  for (const amountMinor of [0, -1, 1.5, 100_000_001]) {
    await assert.rejects(
      harness.service.credit(harness.user.userId, 'deposit', { amountMinor, idempotencyKey: key(`amount-${amountMinor}`) }),
      (error: unknown) => error instanceof WalletError && error.code === 'INVALID_AMOUNT'
    );
  }
});

test('idempotent replay does not duplicate a credit; changed payload conflicts', async (context) => {
  const harness = await createWalletHarness(context);
  const idempotencyKey = key('replay');
  const first = await credit(harness, 2500, idempotencyKey);
  const replay = await credit(harness, 2500, idempotencyKey);
  assert.equal(replay.replayed, true);
  assert.equal(replay.transaction.transactionId, first.transaction.transactionId);
  assert.equal(replay.wallet.availableBalanceMinor, 2500);
  await assert.rejects(
    credit(harness, 2501, idempotencyKey),
    (error: unknown) => error instanceof WalletError && error.code === 'IDEMPOTENCY_KEY_REUSED'
  );
});

test('ledger insertion failure rolls back wallet projection and transaction', async (context) => {
  const harness = await createWalletHarness(context);
  harness.repository.failNextLedgerInsert = true;
  await assert.rejects(credit(harness, 700, key('rollback')));
  assert.equal((await harness.service.getWallet(harness.user.userId)).availableBalanceMinor, 0);
  assert.equal((await harness.service.listTransactions(harness.user.userId, { limit: 10, offset: 0 })).length, 0);
  assert.equal(harness.repository.ledgerEntries, 0);
});

test('wallet projection failure rolls back the inserted transaction', async (context) => {
  const harness = await createWalletHarness(context);
  harness.repository.failNextProjectionUpdate = true;
  await assert.rejects(credit(harness, 700, key('balance-rollback')));
  assert.equal((await harness.service.getWallet(harness.user.userId)).availableBalanceMinor, 0);
  assert.equal((await harness.service.listTransactions(harness.user.userId, { limit: 10, offset: 0 })).length, 0);
  assert.equal(harness.repository.ledgerEntries, 0);
});

test('duplicate business references cannot post a second transaction', async (context) => {
  const harness = await createWalletHarness(context);
  await harness.service.credit(harness.user.userId, 'deposit', {
    amountMinor: 500, idempotencyKey: key('reference-a'), referenceId: 'provider-ref-unique'
  });
  await assert.rejects(
    harness.service.credit(harness.user.userId, 'deposit', {
      amountMinor: 500, idempotencyKey: key('reference-b'), referenceId: 'provider-ref-unique'
    }),
    (error: unknown) => error instanceof WalletError && error.code === 'DUPLICATE_TRANSACTION'
  );
  assert.equal((await harness.service.getWallet(harness.user.userId)).availableBalanceMinor, 500);
});

test('concurrent debits serialize and cannot overdraw', async (context) => {
  const harness = await createWalletHarness(context);
  await credit(harness, 1000);
  const attempts = await Promise.allSettled([
    harness.service.tournamentEntryFee(harness.user.userId, { amountMinor: 700, idempotencyKey: key('parallel-a') }),
    harness.service.tournamentEntryFee(harness.user.userId, { amountMinor: 700, idempotencyKey: key('parallel-b') })
  ]);
  assert.equal(attempts.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((entry) => entry.status === 'rejected').length, 1);
  assert.equal((await harness.service.getWallet(harness.user.userId)).availableBalanceMinor, 300);
});

test('refund and winning operations credit the wallet with typed ledger rows', async (context) => {
  const harness = await createWalletHarness(context);
  const refund = await harness.service.refund(harness.user.userId, { amountMinor: 300, idempotencyKey: key('refund') });
  const winning = await harness.service.winning(harness.user.userId, { amountMinor: 900, idempotencyKey: key('winning') });
  assert.equal(refund.transaction.type, 'refund');
  assert.equal(winning.transaction.type, 'winning');
  assert.equal(winning.wallet.totalWinningsMinor, 900);
  assert.equal(winning.wallet.availableBalanceMinor, 1200);
});

test('entry fees debit the wallet in integer paise', async (context) => {
  const harness = await createWalletHarness(context);
  await credit(harness, 12345);
  const result = await harness.service.tournamentEntryFee(harness.user.userId, { amountMinor: 999, idempotencyKey: key('paise') });
  assert.equal(result.wallet.availableBalanceMinor, 11346);
  assert.equal(result.transaction.amountMinor, 999);
});

test('a user cannot list another user transactions', async (context) => {
  const harness = await createWalletHarness(context);
  await credit(harness, 200);
  const self = await harness.app.inject({ method: 'GET', url: '/api/wallet/transactions', headers: { cookie: harness.userCookie } });
  const other = await harness.app.inject({ method: 'GET', url: '/api/wallet/transactions', headers: { cookie: harness.otherCookie } });
  assert.equal(self.json().transactions.length, 1);
  assert.equal(other.json().transactions.length, 0);
});

test('withdrawal requests reserve available funds and remain pending', async (context) => {
  const harness = await createWalletHarness(context);
  await credit(harness, 2500);
  const response = await harness.app.inject({
    method: 'POST', url: '/api/wallet/withdrawal-requests',
    headers: { cookie: harness.userCookie, origin: ORIGIN, 'idempotency-key': key('withdrawal') },
    payload: { amountMinor: 800 }
  });
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().withdrawal.transaction.status, 'pending');
  assert.equal(response.json().withdrawal.wallet.availableBalanceMinor, 1700);
  assert.equal(response.json().withdrawal.wallet.reservedBalanceMinor, 800);
  assert.equal(response.body.includes('bank'), false);
  const replay = await harness.app.inject({
    method: 'POST', url: '/api/wallet/withdrawal-requests',
    headers: { cookie: harness.userCookie, origin: ORIGIN, 'idempotency-key': key('withdrawal') },
    payload: { amountMinor: 800 }
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().withdrawal.replayed, true);
  assert.equal(replay.json().withdrawal.wallet.availableBalanceMinor, 1700);
});

test('withdrawal requires verified KYC and applies configured minimum and maximum', async (context) => {
  const harness = await createWalletHarness(context);
  await credit(harness, 5000);
  let status = 'pending';
  const kycRepository = {
    async getByUserId(userId: string) {
      return status === 'verified' ? {
        userId, status: 'verified' as const, legalName: 'Test Player', country: 'India',
        dateOfBirth: null, verificationReference: null, rejectionReason: null,
        reviewedByUserId: 'admin', reviewedAt: new Date().toISOString(),
        submittedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      } : {
        userId, status: 'pending' as const, legalName: 'Test Player', country: 'India',
        dateOfBirth: null, verificationReference: null, rejectionReason: null,
        reviewedByUserId: null, reviewedAt: null, submittedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
    }
  };
  const service = new WalletService(harness.repository, kycRepository, true, 500, 3000);
  await assert.rejects(
    service.requestWithdrawal(harness.user.userId, { amountMinor: 700, idempotencyKey: key('kyc-pending') }),
    (error: unknown) => error instanceof WalletError && error.code === 'KYC_REQUIRED'
  );
  status = 'verified';
  await assert.rejects(
    service.requestWithdrawal(harness.user.userId, { amountMinor: 499, idempotencyKey: key('under-min') }),
    (error: unknown) => error instanceof WalletError && error.code === 'INVALID_WITHDRAWAL_AMOUNT'
  );
  await assert.rejects(
    service.requestWithdrawal(harness.user.userId, { amountMinor: 3001, idempotencyKey: key('over-max') }),
    (error: unknown) => error instanceof WalletError && error.code === 'INVALID_WITHDRAWAL_AMOUNT'
  );
  const withdrawal = await service.requestWithdrawal(harness.user.userId, {
    amountMinor: 700, idempotencyKey: key('kyc-verified')
  });
  assert.equal(withdrawal.wallet.availableBalanceMinor, 4300);
  assert.equal(withdrawal.wallet.reservedBalanceMinor, 700);
});

test('concurrent distinct withdrawal requests cannot create conflicting active holds', async (context) => {
  const harness = await createWalletHarness(context);
  await credit(harness, 3000);
  const results = await Promise.allSettled([
    harness.service.requestWithdrawal(harness.user.userId, { amountMinor: 500, idempotencyKey: key('concurrent-a') }),
    harness.service.requestWithdrawal(harness.user.userId, { amountMinor: 500, idempotencyKey: key('concurrent-b') })
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal((await harness.service.getWallet(harness.user.userId)).availableBalanceMinor, 2500);
  assert.equal((await harness.service.getWallet(harness.user.userId)).reservedBalanceMinor, 500);
});

test('withdrawal requests are rate limited without duplicating idempotent requests', async (context) => {
  const harness = await createWalletHarness(context);
  await credit(harness, 2500);
  const headers = { cookie: harness.userCookie, origin: ORIGIN, 'idempotency-key': key('withdrawal-limit') };
  const responses = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    responses.push(await harness.app.inject({
      method: 'POST', url: '/api/wallet/withdrawal-requests', headers, payload: { amountMinor: 800 }
    }));
  }

  assert.equal(responses[0]?.statusCode, 202);
  assert.equal(responses[1]?.statusCode, 200);
  assert.equal(responses[4]?.statusCode, 200);
  assert.equal(responses[5]?.statusCode, 429);
  assert.equal((await harness.service.getWallet(harness.user.userId)).availableBalanceMinor, 1700);
  assert.equal((await harness.service.listTransactions(harness.user.userId, { limit: 10, offset: 0 })).length, 2);
});

test('withdrawal validation requires positive paise, origin, and idempotency key', async (context) => {
  const harness = await createWalletHarness(context);
  const invalidAmount = await harness.app.inject({
    method: 'POST', url: '/api/wallet/withdrawal-requests',
    headers: { cookie: harness.userCookie, origin: ORIGIN, 'idempotency-key': key('bad-amount') }, payload: { amountMinor: 0 }
  });
  const missingHeader = await harness.app.inject({
    method: 'POST', url: '/api/wallet/withdrawal-requests',
    headers: { cookie: harness.userCookie, origin: ORIGIN }, payload: { amountMinor: 10 }
  });
  const missingOrigin = await harness.app.inject({
    method: 'POST', url: '/api/wallet/withdrawal-requests',
    headers: { cookie: harness.userCookie, 'idempotency-key': key('no-origin') }, payload: { amountMinor: 10 }
  });
  assert.equal(invalidAmount.statusCode, 400);
  assert.equal(missingHeader.statusCode, 400);
  assert.equal(missingOrigin.statusCode, 403);
});

test('withdrawal requests reject client balance and identity fields', async (context) => {
  const harness = await createWalletHarness(context);
  const response = await harness.app.inject({
    method: 'POST', url: '/api/wallet/withdrawal-requests',
    headers: { cookie: harness.userCookie, origin: ORIGIN, 'idempotency-key': key('forged') },
    payload: { amountMinor: 10, userId: harness.otherUser.userId, balance: 1_000_000 }
  });
  assert.equal(response.statusCode, 400);
});

test('withdrawal insufficient funds remain atomic', async (context) => {
  const harness = await createWalletHarness(context);
  const response = await harness.app.inject({
    method: 'POST', url: '/api/wallet/withdrawal-requests',
    headers: { cookie: harness.userCookie, origin: ORIGIN, 'idempotency-key': key('withdraw-empty') },
    payload: { amountMinor: 1 }
  });
  assert.equal(response.statusCode, 409);
  assert.equal((await harness.service.getWallet(harness.user.userId)).availableBalanceMinor, 0);
  assert.equal((await harness.service.getWallet(harness.user.userId)).reservedBalanceMinor, 0);
});

test('transaction history supports type/status filters and newest-first ordering', async (context) => {
  const harness = await createWalletHarness(context);
  await harness.service.refund(harness.user.userId, { amountMinor: 10, idempotencyKey: key('history-refund') });
  await harness.service.winning(harness.user.userId, { amountMinor: 20, idempotencyKey: key('history-win') });
  const all = await harness.app.inject({ method: 'GET', url: '/api/wallet/transactions?limit=1&offset=0', headers: { cookie: harness.userCookie } });
  const filtered = await harness.app.inject({ method: 'GET', url: '/api/wallet/transactions?type=refund&status=completed', headers: { cookie: harness.userCookie } });
  assert.equal(all.json().transactions.length, 1);
  assert.equal(all.json().transactions[0].type, 'winning');
  assert.equal(filtered.json().transactions.length, 1);
  assert.equal(filtered.json().transactions[0].type, 'refund');
});

test('rejects malformed wallet history filters', async (context) => {
  const harness = await createWalletHarness(context);
  const response = await harness.app.inject({ method: 'GET', url: '/api/wallet/transactions?type=forged', headers: { cookie: harness.userCookie } });
  assert.equal(response.statusCode, 400);
});

test('admins do not receive cross-user wallet access through normal endpoints', async (context) => {
  const harness = await createWalletHarness(context);
  const response = await harness.app.inject({ method: 'GET', url: `/api/wallet?userId=${harness.otherUser.userId}`, headers: { cookie: harness.adminCookie } });
  assert.equal(response.statusCode, 400);
});