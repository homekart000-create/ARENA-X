(() => {
  const api = globalThis.ArenaApi;
  const auth = globalThis.ArenaAuth;
  if (!api || !auth) return;

  const MAX_AMOUNT_MINOR = 100_000_000;
  let wallet = null;
  let transactions = [];
  let walletError = null;
  let transactionsError = null;

  function currentUser(userId) {
    const user = auth.getCurrentUser();
    return user && (!userId || user.userId === userId) ? user : null;
  }

  function errorMessage(error) {
    return error && typeof error.message === 'string'
      ? error.message
      : 'The wallet request could not be completed. Please try again.';
  }

  function isMinorAmount(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function isWallet(value, userId) {
    return Boolean(value && typeof value === 'object' && value.userId === userId
      && value.currency === 'INR'
      && ['active', 'restricted', 'closed'].includes(value.status)
      && ['availableBalanceMinor', 'reservedBalanceMinor', 'totalDepositedMinor', 'totalWithdrawnMinor', 'totalWinningsMinor']
        .every((key) => isMinorAmount(value[key]))
      && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)));
  }

  function isTransaction(value, userId) {
    return Boolean(value && typeof value === 'object'
      && typeof value.transactionId === 'string' && value.transactionId.trim()
      && value.userId === userId && value.currency === 'INR'
      && ['deposit', 'withdrawal', 'entry_fee', 'winning', 'refund', 'adjustment'].includes(value.type)
      && ['credit', 'debit'].includes(value.direction)
      && Number.isSafeInteger(value.amountMinor) && value.amountMinor > 0
      && ['pending', 'completed', 'failed', 'reversed', 'approved', 'rejected', 'cancelled'].includes(value.status)
      && typeof value.description === 'string'
      && (value.referenceId === null || typeof value.referenceId === 'string')
      && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)));
  }

  async function loadWallet(userId) {
    const user = currentUser(userId);
    if (!user) {
      wallet = null;
      walletError = { code: 'UNAUTHORIZED', message: 'Log in to view your wallet.' };
      return { success: false, error: walletError };
    }
    try {
      const response = await api.request('/api/wallet');
      if (!isWallet(response.wallet, user.userId)) throw new Error('The backend returned invalid wallet information.');
      wallet = response.wallet;
      walletError = null;
      return { success: true, wallet };
    } catch (error) {
      wallet = null;
      walletError = { code: error.code || 'BACKEND_UNAVAILABLE', message: errorMessage(error) };
      return { success: false, error: walletError };
    }
  }

  async function loadTransactions(userId) {
    const user = currentUser(userId);
    if (!user) {
      transactions = [];
      transactionsError = { code: 'UNAUTHORIZED', message: 'Log in to view your transactions.' };
      return { success: false, error: transactionsError };
    }
    try {
      const response = await api.request('/api/wallet/transactions?limit=100&offset=0');
      if (!Array.isArray(response.transactions) || !response.transactions.every((entry) => isTransaction(entry, user.userId))) {
        throw new Error('The backend returned invalid transaction information.');
      }
      transactions = [...response.transactions].sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt));
      transactionsError = null;
      return { success: true, transactions: [...transactions] };
    } catch (error) {
      transactions = [];
      transactionsError = { code: error.code || 'BACKEND_UNAVAILABLE', message: errorMessage(error) };
      return { success: false, error: transactionsError };
    }
  }

  function parseAmountMinor(value) {
    const text = String(value ?? '').trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) return null;
    const [rupees, fraction = ''] = text.split('.');
    const amountMinor = Number(rupees) * 100 + Number(fraction.padEnd(2, '0'));
    return Number.isSafeInteger(amountMinor) && amountMinor > 0 && amountMinor <= MAX_AMOUNT_MINOR
      ? amountMinor
      : null;
  }

  function makeIdempotencyKey() {
    const randomId = globalThis.crypto?.randomUUID?.();
    return randomId || `withdrawal-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
  }

  async function requestWithdrawal(userId, amountMinor) {
    const user = currentUser(userId);
    if (!user) return { success: false, reason: 'UNAUTHORIZED', message: 'Log in to request a withdrawal.' };
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 1 || amountMinor > MAX_AMOUNT_MINOR) {
      return { success: false, reason: 'VALIDATION', message: 'Enter a valid amount in rupees.' };
    }
    try {
      const response = await api.request('/api/wallet/withdrawal-requests', {
        method: 'POST',
        headers: { 'Idempotency-Key': makeIdempotencyKey() },
        body: { amountMinor }
      });
      if (!response.withdrawal || response.withdrawal.wallet?.userId !== user.userId) {
        throw new Error('The backend returned an invalid withdrawal response.');
      }
      return { success: true, withdrawal: response.withdrawal };
    } catch (error) {
      return {
        success: false,
        reason: error.code || 'REQUEST_FAILED',
        message: errorMessage(error)
      };
    }
  }

  function formatPaise(value) {
    if (!Number.isSafeInteger(value) || value < 0) return '—';
    const rupees = Math.floor(value / 100);
    const paise = value % 100;
    return `₹${rupees.toLocaleString('en-IN')}.${String(paise).padStart(2, '0')}`;
  }

  globalThis.ArenaMoney = Object.freeze({ formatPaise });
  globalThis.ArenaWallet = Object.freeze({
    loadWallet,
    loadTransactions,
    requestWithdrawal,
    parseAmountMinor,
    formatPaise,
    getWallet: () => wallet,
    getTransactions: () => [...transactions],
    getWalletError: () => walletError,
    getTransactionsError: () => transactionsError
  });
})();
