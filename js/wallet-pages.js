(() => {
  const walletStore = globalThis.ArenaWallet;
  const auth = globalThis.ArenaAuth;
  if (!walletStore || !auth || document.body.dataset.page !== 'wallet') return;
  let user = auth.getCurrentUser();
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const dateLabel = (value) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
      : 'Date unavailable';
  };
  const toastRegion = document.querySelector('#toast-region');

  function showToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.className = `toast${isError ? ' is-error' : ''}`;
    toast.textContent = message;
    toastRegion.append(toast);
    window.setTimeout(() => toast.remove(), 3600);
  }

  function setFeedback(form, message, isError = false) {
    const feedback = form.querySelector('[data-wallet-feedback]');
    feedback.textContent = message;
    feedback.classList.toggle('is-error', isError);
  }

  function renderSummary() {
    const wallet = walletStore.getWallet();
    const error = walletStore.getWalletError();
    const errorRegion = document.querySelector('#wallet-error');
    const balance = document.querySelector('#wallet-balance');
    errorRegion.hidden = !error;
    errorRegion.textContent = error?.message || '';
    if (!wallet) {
      balance.textContent = '—';
      document.querySelector('#wallet-deposited').textContent = '—';
      document.querySelector('#wallet-withdrawn').textContent = '—';
      document.querySelector('#wallet-winnings').textContent = '—';
      document.querySelector('#wallet-reserved').textContent = '—';
      return;
    }
    balance.textContent = walletStore.formatPaise(wallet.availableBalanceMinor);
    document.querySelector('#wallet-deposited').textContent = walletStore.formatPaise(wallet.totalDepositedMinor);
    document.querySelector('#wallet-withdrawn').textContent = walletStore.formatPaise(wallet.totalWithdrawnMinor);
    document.querySelector('#wallet-winnings').textContent = walletStore.formatPaise(wallet.totalWinningsMinor);
    document.querySelector('#wallet-reserved').textContent = walletStore.formatPaise(wallet.reservedBalanceMinor);
  }

  function transactionRow(transaction) {
    const credit = transaction.direction === 'credit';
    const sign = credit ? '+' : '−';
    const amount = walletStore.formatPaise(transaction.amountMinor);
    return `<article class="wallet-transaction-row ${credit ? 'is-credit' : 'is-debit'}"><span class="wallet-transaction-mark" aria-hidden="true">${credit ? '+' : '−'}</span><div class="wallet-transaction-main"><span class="wallet-transaction-type">${escapeHtml(transaction.type.replaceAll('_', ' ').toUpperCase())}</span><strong>${escapeHtml(transaction.description)}</strong><time datetime="${escapeHtml(transaction.createdAt)}">${escapeHtml(dateLabel(transaction.createdAt))}</time><small>Reference: ${escapeHtml(transaction.referenceId || transaction.transactionId)}</small></div><strong class="wallet-transaction-amount">${sign}${escapeHtml(amount)}</strong><span class="wallet-transaction-status status-${escapeHtml(transaction.status)}">${escapeHtml(transaction.status.toUpperCase())}</span></article>`;
  }

  function renderTransactions() {
    const list = document.querySelector('#wallet-transactions');
    const empty = document.querySelector('#wallet-transactions-empty');
    const errorRegion = document.querySelector('#wallet-transactions-error');
    const filter = document.querySelector('[data-wallet-filter].is-active')?.dataset.walletFilter || 'all';
    const error = walletStore.getTransactionsError();
    const transactions = walletStore.getTransactions();
    const visible = filter === 'all' ? transactions : transactions.filter((transaction) => transaction.type === filter);
    errorRegion.hidden = !error;
    errorRegion.textContent = error?.message || '';
    list.innerHTML = error ? '' : visible.map(transactionRow).join('');
    list.hidden = Boolean(error) || visible.length === 0;
    empty.hidden = Boolean(error) || visible.length !== 0;
    empty.querySelector('p').textContent = filter === 'all' ? 'No transactions yet.' : `No ${filter.replaceAll('_', ' ')} transactions.`;
    document.querySelector('#wallet-transaction-count').textContent = error
      ? 'UNAVAILABLE'
      : `${visible.length} ${visible.length === 1 ? 'TRANSACTION' : 'TRANSACTIONS'}`;
  }

  async function refreshWalletData() {
    if (!user) return;
    await Promise.all([walletStore.loadWallet(user.userId), walletStore.loadTransactions(user.userId)]);
    renderSummary();
    renderTransactions();
  }

  document.querySelector('#wallet-withdraw-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const amountMinor = walletStore.parseAmountMinor(new FormData(form).get('amount'));
    if (amountMinor === null) {
      setFeedback(form, 'Enter an amount greater than ₹0 and no more than ₹10,00,000, with up to two decimal places.', true);
      return;
    }

    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    setFeedback(form, 'Submitting withdrawal request...');
    const result = await walletStore.requestWithdrawal(user.userId, amountMinor);
    if (!result.success) {
      setFeedback(form, result.message, true);
      button.disabled = false;
      return;
    }

    form.reset();
    const [walletResult, transactionsResult] = await Promise.all([
      walletStore.loadWallet(user.userId),
      walletStore.loadTransactions(user.userId)
    ]);
    renderSummary();
    renderTransactions();
    const refreshFailed = !walletResult.success || !transactionsResult.success;
    const message = refreshFailed
      ? 'Withdrawal request received. Wallet data could not be refreshed; reload to try again.'
      : 'Withdrawal request received. Funds are reserved pending review and settlement.';
    setFeedback(form, message, refreshFailed);
    showToast(message, refreshFailed);
    button.disabled = false;
  });

  document.querySelector('#wallet-deposit-form').addEventListener('submit', (event) => {
    event.preventDefault();
    setFeedback(event.currentTarget, 'Real deposits are not available yet. Payment integration will be added in a later step.', true);
  });

  document.addEventListener('click', (event) => {
    const filter = event.target.closest('[data-wallet-filter]');
    if (!filter) return;
    document.querySelectorAll('[data-wallet-filter]').forEach((button) => {
      const selected = button === filter;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    renderTransactions();
  });

  auth.ready.then(async () => {
    user = auth.getCurrentUser();
    if (!user) return;
    await refreshWalletData();
    document.querySelector('#wallet-loading').hidden = true;
  });
})();
