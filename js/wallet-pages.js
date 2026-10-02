(() => {
  const walletStore = globalThis.ArenaWallet;
  const auth = globalThis.ArenaAuth;
  if (!walletStore || !auth || document.body.dataset.page !== 'wallet') return;
  let user = auth.getCurrentUser();
  const amountLabel = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const dateLabel = (value) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const toastRegion = document.querySelector('#toast-region');

  function showToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.className = `toast${isError ? ' is-error' : ''}`;
    toast.textContent = message;
    toastRegion.append(toast);
    window.setTimeout(() => toast.remove(), 3600);
  }

  function renderSummary() {
    const wallet = walletStore.getWallet(user.userId);
    if (!wallet) {
      showToast('Wallet storage is unavailable or invalid. Existing data was left unchanged.', true);
      return;
    }
    document.querySelector('#wallet-balance').textContent = amountLabel(wallet.balance);
    document.querySelector('#wallet-deposited').textContent = amountLabel(wallet.totalDeposited);
    document.querySelector('#wallet-withdrawn').textContent = amountLabel(wallet.totalWithdrawn);
    document.querySelector('#wallet-winnings').textContent = amountLabel(wallet.totalWinnings);
  }

  function transactionRow(transaction) {
    const credit = ['deposit', 'winning', 'refund', 'adjustment'].includes(transaction.type);
    const signs = credit ? '+' : '−';
    return `<article class="wallet-transaction-row ${credit ? 'is-credit' : 'is-debit'}"><span class="wallet-transaction-mark" aria-hidden="true">${credit ? '+' : '−'}</span><div class="wallet-transaction-main"><span class="wallet-transaction-type">${escapeHtml(transaction.type.replaceAll('_', ' ').toUpperCase())}</span><strong>${escapeHtml(transaction.description)}</strong><time datetime="${escapeHtml(transaction.createdAt)}">${escapeHtml(dateLabel(transaction.createdAt))}</time></div><strong class="wallet-transaction-amount">${signs}${amountLabel(transaction.amount)}</strong><span class="wallet-transaction-status status-${escapeHtml(transaction.status)}">${escapeHtml(transaction.status.toUpperCase())}</span></article>`;
  }

  function renderTransactions() {
    const list = document.querySelector('#wallet-transactions');
    const empty = document.querySelector('#wallet-transactions-empty');
    const filter = document.querySelector('[data-wallet-filter].is-active')?.dataset.walletFilter || 'all';
    const transactions = walletStore.getUserTransactions(user.userId);
    const visible = filter === 'all' ? transactions : transactions.filter((transaction) => transaction.type === filter);
    list.innerHTML = visible.map(transactionRow).join('');
    list.hidden = visible.length === 0;
    empty.hidden = visible.length !== 0;
    empty.querySelector('p').textContent = filter === 'all' ? 'No transactions yet.' : `No ${filter.replaceAll('_', ' ')} transactions.`;
    document.querySelector('#wallet-transaction-count').textContent = `${visible.length} ${visible.length === 1 ? 'TRANSACTION' : 'TRANSACTIONS'}`;
  }

  function submitAmount(event, operation) {
    event.preventDefault();
    const form = event.currentTarget;
    const result = operation === 'deposit'
      ? walletStore.creditWallet(user.userId, new FormData(form).get('amount'), { type: 'deposit', status: 'completed', description: 'Demo wallet credit' })
      : walletStore.debitWallet(user.userId, new FormData(form).get('amount'), { type: 'withdrawal', status: 'pending', description: 'Demo withdrawal request' });
    if (!result.success) {
      const feedback = form.querySelector('[data-wallet-feedback]');
      feedback.textContent = result.message;
      feedback.classList.add('is-error');
      return;
    }
    form.reset();
    const feedback = form.querySelector('[data-wallet-feedback]');
    feedback.textContent = operation === 'deposit' ? 'Demo funds added to your wallet.' : 'Withdrawal request recorded locally as pending.';
    feedback.classList.remove('is-error');
    renderSummary();
    renderTransactions();
    showToast(operation === 'deposit' ? 'Demo funds added.' : 'Withdrawal request saved as pending.');
  }

  document.querySelector('#wallet-deposit-form').addEventListener('submit', (event) => submitAmount(event, 'deposit'));
  document.querySelector('#wallet-withdraw-form').addEventListener('submit', (event) => submitAmount(event, 'withdrawal'));
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

  auth.ready.then(() => {
    user = auth.getCurrentUser();
    if (!user) return;
    renderSummary();
    renderTransactions();
  });
})();