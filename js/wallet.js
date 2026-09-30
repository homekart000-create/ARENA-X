(() => {
  const WALLETS_KEY = 'arenaX_wallets';
  const TRANSACTIONS_KEY = 'arenaX_transactions';
  const MAX_TRANSACTION_AMOUNT = 1000000;
  const creditTypes = new Set(['deposit', 'winning', 'refund', 'adjustment']);
  const debitTypes = new Set(['withdrawal', 'entry_fee']);
  const transactionTypes = new Set([...creditTypes, ...debitTypes]);
  const statuses = new Set(['completed', 'pending', 'failed']);

  function readArrayState(key) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return { items: [], raw, valid: true };
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? { items: parsed, raw, valid: true } : { items: [], raw, valid: false };
    } catch {
      return { items: [], raw: null, valid: false };
    }
  }

  function currentUser() {
    return globalThis.ArenaAuth?.getCurrentUser() || null;
  }

  function canAccess(userId) {
    const user = currentUser();
    return Boolean(user && userId && user.userId === userId);
  }

  function amountValue(value) {
    if (typeof value === 'string' && value.trim() === '') return null;
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_TRANSACTION_AMOUNT) return null;
    const rounded = Math.round(amount * 100) / 100;
    return rounded > 0 ? rounded : null;
  }

  function isValidTransaction(transaction) {
    if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) return false;
    return typeof transaction.id === 'string' && Boolean(transaction.id.trim())
      && typeof transaction.userId === 'string' && Boolean(transaction.userId.trim())
      && transactionTypes.has(transaction.type)
      && amountValue(transaction.amount) !== null
      && statuses.has(transaction.status)
      && typeof transaction.createdAt === 'string'
      && Number.isFinite(Date.parse(transaction.createdAt));
  }

  function createId(transactions) {
    let id = '';
    do {
      id = globalThis.crypto?.randomUUID?.() || `wallet-tx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    } while (transactions.some((transaction) => transaction?.id === id));
    return id;
  }

  function ensureWallet(userId) {
    const state = readArrayState(WALLETS_KEY);
    if (!state.valid) return { wallet: null, state, created: false };
    let wallet = state.items.find((item) => item?.userId === userId);
    if (wallet) {
      const balance = Number(wallet.balance);
      if (!Number.isFinite(balance) || balance < 0) return { wallet: null, state, created: false };
      return {
        wallet: {
          ...wallet,
          balance,
          totalDeposited: Number.isFinite(Number(wallet.totalDeposited)) && Number(wallet.totalDeposited) >= 0 ? Number(wallet.totalDeposited) : 0,
          totalWithdrawn: Number.isFinite(Number(wallet.totalWithdrawn)) && Number(wallet.totalWithdrawn) >= 0 ? Number(wallet.totalWithdrawn) : 0,
          totalWinnings: Number.isFinite(Number(wallet.totalWinnings)) && Number(wallet.totalWinnings) >= 0 ? Number(wallet.totalWinnings) : 0
        },
        state,
        created: false
      };
    }
    const legacyBalance = Number(globalThis.ArenaAuth?.getLegacyWalletBalance?.(userId) || 0);
    const balance = Number.isFinite(legacyBalance) && legacyBalance >= 0 ? Math.round(legacyBalance * 100) / 100 : 0;
    wallet = { userId, balance, totalDeposited: 0, totalWithdrawn: 0, totalWinnings: 0, updatedAt: new Date().toISOString() };
    try {
      localStorage.setItem(WALLETS_KEY, JSON.stringify([...state.items, wallet]));
      return { wallet, state, created: true };
    } catch {
      return { wallet: null, state: { ...state, valid: false }, created: false };
    }
  }

  function getWallet(userId = currentUser()?.userId) {
    if (!canAccess(userId)) return null;
    return ensureWallet(userId).wallet;
  }

  function getWalletBalance(userId = currentUser()?.userId) {
    return Number(getWallet(userId)?.balance || 0);
  }

  function getUserTransactions(userId = currentUser()?.userId) {
    if (!canAccess(userId)) return [];
    const state = readArrayState(TRANSACTIONS_KEY);
    if (!state.valid) return [];
    return state.items.filter((transaction) => isValidTransaction(transaction) && transaction.userId === userId)
      .sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt));
  }

  function buildTransaction(userId, amount, metadata, transactions) {
    const value = amountValue(amount);
    const type = String(metadata?.type || 'adjustment');
    const status = String(metadata?.status || 'completed');
    if (value === null) return { error: 'Enter an amount greater than 0 and no more than ₹10,00,000.' };
    if (!transactionTypes.has(type)) return { error: 'That transaction type is not supported.' };
    if (!statuses.has(status)) return { error: 'That transaction status is not supported.' };
    const description = String(metadata?.description || '').trim().slice(0, 160);
    const referenceId = metadata?.referenceId == null ? null : String(metadata.referenceId).slice(0, 120);
    return {
      transaction: {
        id: createId(transactions),
        userId,
        type,
        amount: value,
        status,
        description: description || `${type.replaceAll('_', ' ')} transaction`,
        referenceId,
        createdAt: new Date().toISOString()
      }
    };
  }

  function commit(walletState, transactionState, wallets, transactions) {
    if (!walletState.valid || !transactionState.valid) return false;
    try {
      localStorage.setItem(WALLETS_KEY, JSON.stringify(wallets));
      localStorage.setItem(TRANSACTIONS_KEY, JSON.stringify(transactions));
      return true;
    } catch {
      try {
        if (walletState.raw === null) localStorage.removeItem(WALLETS_KEY);
        else localStorage.setItem(WALLETS_KEY, walletState.raw);
        if (transactionState.raw === null) localStorage.removeItem(TRANSACTIONS_KEY);
        else localStorage.setItem(TRANSACTIONS_KEY, transactionState.raw);
      } catch {
        return false;
      }
      return false;
    }
  }

  function saveTransactionOnly(userId, amount, metadata = {}) {
    if (!canAccess(userId)) return { success: false, reason: 'auth', message: 'Log in to manage your wallet.' };
    const transactionState = readArrayState(TRANSACTIONS_KEY);
    if (!transactionState.valid) return { success: false, reason: 'storage', message: 'Transaction storage is invalid and was left unchanged.' };
    const result = buildTransaction(userId, amount, metadata, transactionState.items);
    if (result.error) return { success: false, reason: 'validation', message: result.error };
    if (!saveTransactions([...transactionState.items, result.transaction])) return { success: false, reason: 'storage', message: 'Your browser could not save this transaction.' };
    return { success: true, transaction: result.transaction };
  }

  function saveTransactions(transactions) {
    const state = readArrayState(TRANSACTIONS_KEY);
    if (!state.valid) return false;
    try {
      localStorage.setItem(TRANSACTIONS_KEY, JSON.stringify(transactions));
      return true;
    } catch {
      return false;
    }
  }

  function changeBalance(userId, amount, metadata, direction) {
    if (!canAccess(userId)) return { success: false, reason: 'auth', message: 'Log in to manage your wallet.' };
    const normalizedAmount = amountValue(amount);
    if (normalizedAmount === null) return { success: false, reason: 'validation', message: 'Enter an amount greater than 0 and no more than ₹10,00,000.' };
    const type = String(metadata?.type || (direction > 0 ? 'deposit' : 'withdrawal'));
    if (!(direction > 0 ? creditTypes : debitTypes).has(type)) return { success: false, reason: 'type', message: 'That wallet operation is not supported.' };
    const transactionStatus = String(metadata?.status || (type === 'withdrawal' ? 'pending' : 'completed'));
    if (direction > 0 && transactionStatus !== 'completed') return { success: false, reason: 'status', message: 'Wallet credits must be completed transactions.' };
    if (direction < 0 && !['pending', 'completed'].includes(transactionStatus)) return { success: false, reason: 'status', message: 'Failed transactions cannot debit the wallet.' };
    const walletState = readArrayState(WALLETS_KEY);
    const transactionState = readArrayState(TRANSACTIONS_KEY);
    if (!walletState.valid || !transactionState.valid) return { success: false, reason: 'storage', message: 'Wallet storage is invalid and was left unchanged.' };
    const indexedWallet = walletState.items.findIndex((wallet) => wallet?.userId === userId);
    const wallet = indexedWallet < 0 ? ensureWallet(userId).wallet : walletState.items[indexedWallet];
    if (!wallet) return { success: false, reason: 'storage', message: 'Your browser could not initialize this wallet.' };
    if (direction < 0 && normalizedAmount > Number(wallet.balance || 0)) return { success: false, reason: 'insufficient-funds', message: 'Insufficient wallet balance.' };
    const transactionResult = buildTransaction(userId, normalizedAmount, { ...metadata, type, status: transactionStatus }, transactionState.items);
    if (transactionResult.error) return { success: false, reason: 'validation', message: transactionResult.error };
    const transaction = transactionResult.transaction;
    const nextWallet = {
      ...wallet,
      balance: Math.round((Number(wallet.balance || 0) + direction * normalizedAmount) * 100) / 100,
      totalDeposited: Number(wallet.totalDeposited || 0) + (type === 'deposit' && direction > 0 ? normalizedAmount : 0),
      totalWithdrawn: Number(wallet.totalWithdrawn || 0) + (type === 'withdrawal' && direction < 0 && transaction.status === 'completed' ? normalizedAmount : 0),
      totalWinnings: Number(wallet.totalWinnings || 0) + (type === 'winning' && direction > 0 ? normalizedAmount : 0),
      updatedAt: new Date().toISOString()
    };
    if (nextWallet.balance < 0) return { success: false, reason: 'insufficient-funds', message: 'Wallet balance cannot be negative.' };
    const nextWallets = indexedWallet < 0
      ? [...walletState.items, nextWallet]
      : walletState.items.map((item, index) => index === indexedWallet ? nextWallet : item);
    if (!commit(walletState, transactionState, nextWallets, [...transactionState.items, transaction])) {
      return { success: false, reason: 'storage', message: 'Your browser could not save the wallet transaction.' };
    }
    return { success: true, wallet: nextWallet, transaction };
  }

  function creditWallet(userId, amount, metadata = {}) {
    return changeBalance(userId, amount, metadata, 1);
  }

  function debitWallet(userId, amount, metadata = {}) {
    const details = { ...metadata };
    if (details.type === 'withdrawal' && !details.status) details.status = 'pending';
    return changeBalance(userId, amount, details, -1);
  }

  globalThis.ArenaWallet = Object.freeze({
    getWallet,
    getWalletBalance,
    creditWallet,
    debitWallet,
    createTransaction: saveTransactionOnly,
    getUserTransactions,
    getMaximumAmount: () => MAX_TRANSACTION_AMOUNT
  });
})();