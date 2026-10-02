const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const walletSource = fs.readFileSync(path.join(root, 'js/wallet.js'), 'utf8');
const pageSource = fs.readFileSync(path.join(root, 'js/wallet-pages.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'js/admin.js'), 'utf8');
const walletMarkup = fs.readFileSync(path.join(root, 'wallet.html'), 'utf8');
const userId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const wallet = (overrides = {}) => ({
  walletId: 'wallet-1',
  userId,
  currency: 'INR',
  status: 'active',
  availableBalanceMinor: 123456,
  reservedBalanceMinor: 1000,
  totalDepositedMinor: 200000,
  totalWithdrawnMinor: 25000,
  totalWinningsMinor: 10000,
  version: 1,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
  ...overrides
});
const transaction = (overrides = {}) => ({
  transactionId: 'transaction-1',
  walletId: 'wallet-1',
  userId,
  type: 'winning',
  direction: 'credit',
  amountMinor: 5000,
  currency: 'INR',
  status: 'completed',
  description: 'Match winnings',
  referenceId: 'match-1',
  relatedTransactionId: null,
  createdAt: '2026-10-01T11:00:00.000Z',
  ...overrides
});

class Element {
  constructor(dataset = {}) {
    this.dataset = dataset;
    this.hidden = false;
    this.textContent = '';
    this.innerHTML = '';
    this.disabled = false;
    this.value = '';
    this.listeners = new Map();
    this.children = new Map();
    this.attributes = {};
    this.classList = {
      toggle: (name, enabled) => { this.attributes[`class:${name}`] = Boolean(enabled); },
      add: (name) => { this.attributes[`class:${name}`] = true; },
      remove: (name) => { this.attributes[`class:${name}`] = false; }
    };
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  querySelector(selector) { return this.children.get(selector) || null; }
  append(child) { this.appended = child; }
  remove() { this.removed = true; }
  reset() { this.value = ''; }
  setAttribute(name, value) { this.attributes[name] = value; }
  closest(selector) { return selector === '[data-wallet-filter]' && this.dataset.walletFilter ? this : null; }
}

function createHarness(handler = async () => { throw new Error('Unexpected API request'); }) {
  const calls = [];
  const elements = new Map();
  const filters = ['all', 'deposit', 'withdrawal', 'entry_fee', 'winning', 'refund'].map((value, index) => {
    const element = new Element({ walletFilter: value });
    element.attributes['class:is-active'] = index === 0;
    return element;
  });
  const ids = [
    'wallet-balance', 'wallet-deposited', 'wallet-withdrawn', 'wallet-winnings', 'wallet-reserved',
    'wallet-error', 'wallet-loading', 'wallet-transactions', 'wallet-transactions-empty',
    'wallet-transactions-error', 'wallet-transaction-count', 'toast-region'
  ];
  ids.forEach((id) => elements.set(`#${id}`, new Element()));
  elements.get('#wallet-transactions-empty').children.set('p', new Element());

  const withdrawForm = new Element();
  withdrawForm.children.set('[data-wallet-feedback]', new Element());
  const withdrawButton = new Element();
  withdrawForm.children.set('button[type="submit"]', withdrawButton);
  elements.set('#wallet-withdraw-form', withdrawForm);
  const depositForm = new Element();
  depositForm.children.set('[data-wallet-feedback]', new Element());
  const depositButton = new Element();
  depositButton.disabled = walletMarkup.includes('type="submit" disabled');
  depositForm.children.set('button[type="submit"]', depositButton);
  elements.set('#wallet-deposit-form', depositForm);

  const documentListeners = new Map();
  const sandbox = {
    ArenaApi: {
      async request(url, options = {}) {
        const call = { url, options };
        calls.push(call);
        return handler(call);
      }
    },
    ArenaAuth: { ready: Promise.resolve(), getCurrentUser: () => ({ userId, username: 'player' }) },
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    localStorage: {
      getItem() { throw new Error('Wallet code must not read localStorage.'); },
      setItem() { throw new Error('Wallet code must not write localStorage.'); },
      removeItem() { throw new Error('Wallet code must not remove localStorage.'); }
    },
    document: {
      body: { dataset: { page: 'wallet' } },
      querySelector(selector) {
        if (selector === '[data-wallet-filter].is-active') return filters.find((filter) => filter.attributes['class:is-active']);
        return elements.get(selector) || null;
      },
      querySelectorAll(selector) { return selector === '[data-wallet-filter]' ? filters : []; },
      createElement() { return new Element(); },
      addEventListener(type, callback) { documentListeners.set(type, callback); }
    },
    window: { setTimeout() {} },
    FormData: class {
      constructor(form) { this.form = form; }
      get(name) { return name === 'amount' ? this.form.value : null; }
    },
    Date,
    Intl,
    Math,
    Promise
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(walletSource, sandbox, { filename: 'js/wallet.js' });
  vm.runInNewContext(pageSource, sandbox, { filename: 'js/wallet-pages.js' });
  return { sandbox, calls, elements, filters, withdrawForm, withdrawButton, depositForm, depositButton };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('wallet and transactions load only from the authenticated backend and display integer-paise values', async () => {
  const harness = createHarness(async ({ url }) => {
    if (url === '/api/wallet') return { wallet: wallet() };
    if (url.startsWith('/api/wallet/transactions?')) return { transactions: [transaction()] };
    throw new Error(`Unexpected API request ${url}`);
  });
  await flush();
  assert.deepEqual(harness.calls.map((call) => call.url), ['/api/wallet', '/api/wallet/transactions?limit=100&offset=0']);
  assert.equal(harness.elements.get('#wallet-balance').textContent, '₹1,234.56');
  assert.equal(harness.elements.get('#wallet-reserved').textContent, '₹10.00');
  assert.match(harness.elements.get('#wallet-transactions').innerHTML, /₹50\.00/);
  assert.match(harness.elements.get('#wallet-transactions').innerHTML, /Match winnings/);
  assert.equal(harness.elements.get('#wallet-transaction-count').textContent, '1 TRANSACTION');
  assert.equal(Object.hasOwn(harness.sandbox.ArenaWallet, 'creditWallet'), false);
  assert.equal(Object.hasOwn(harness.sandbox.ArenaWallet, 'debitWallet'), false);
});

test('withdrawal posts paise with an idempotency key then refreshes wallet and ledger', async () => {
  let availableBalanceMinor = 123456;
  const harness = createHarness(async ({ url, options }) => {
    if (url === '/api/wallet') return { wallet: wallet({ availableBalanceMinor }) };
    if (url.startsWith('/api/wallet/transactions?')) return { transactions: [transaction({ amountMinor: 2500, type: 'withdrawal', direction: 'debit', status: 'pending' })] };
    if (url === '/api/wallet/withdrawal-requests') {
      availableBalanceMinor -= options.body.amountMinor;
      return { withdrawal: { withdrawalRequestId: 'withdrawal-1', wallet: wallet({ availableBalanceMinor }), transaction: transaction({ type: 'withdrawal', direction: 'debit', amountMinor: options.body.amountMinor, status: 'pending' }), replayed: false } };
    }
    throw new Error(`Unexpected API request ${url}`);
  });
  await flush();
  harness.withdrawForm.value = '25.00';
  const handler = harness.withdrawForm.listeners.get('submit');
  await handler({ preventDefault() {}, currentTarget: harness.withdrawForm });
  assert.equal(harness.calls.filter((call) => call.url === '/api/wallet').length, 2);
  assert.equal(harness.calls.filter((call) => call.url.startsWith('/api/wallet/transactions?')).length, 2);
  const withdrawal = harness.calls.find((call) => call.url === '/api/wallet/withdrawal-requests');
  assert.deepEqual(JSON.parse(JSON.stringify(withdrawal.options.body)), { amountMinor: 2500 });
  assert.equal(withdrawal.options.headers['Idempotency-Key'], '11111111-1111-4111-8111-111111111111');
  assert.equal(harness.elements.get('#wallet-balance').textContent, '₹1,209.56');
  assert.match(harness.withdrawForm.children.get('[data-wallet-feedback]').textContent, /reserved pending review/i);
});

test('invalid amounts and insufficient-balance conflicts never mutate browser storage', async () => {
  const harness = createHarness(async ({ url }) => {
    if (url === '/api/wallet') return { wallet: wallet() };
    if (url.startsWith('/api/wallet/transactions?')) return { transactions: [] };
    if (url === '/api/wallet/withdrawal-requests') {
      throw Object.assign(new Error('Available wallet balance is insufficient.'), { code: 'INSUFFICIENT_FUNDS' });
    }
    throw new Error(`Unexpected API request ${url}`);
  });
  await flush();
  const submit = harness.withdrawForm.listeners.get('submit');
  harness.withdrawForm.value = '1.001';
  await submit({ preventDefault() {}, currentTarget: harness.withdrawForm });
  assert.equal(harness.calls.some((call) => call.url === '/api/wallet/withdrawal-requests'), false);
  assert.match(harness.withdrawForm.children.get('[data-wallet-feedback]').textContent, /up to two decimal places/i);

  harness.withdrawForm.value = '5000';
  await submit({ preventDefault() {}, currentTarget: harness.withdrawForm });
  assert.equal(harness.calls.at(-1).url, '/api/wallet/withdrawal-requests');
  assert.match(harness.withdrawForm.children.get('[data-wallet-feedback]').textContent, /insufficient/i);
  assert.equal(harness.elements.get('#wallet-balance').textContent, '₹1,234.56');
});

test('backend-unavailable and unauthenticated reads show error states without stale local fallback', async () => {
  const failed = createHarness(async () => {
    throw Object.assign(new Error('The backend is unavailable. Please try again later.'), { code: 'BACKEND_UNAVAILABLE' });
  });
  await flush();
  assert.match(failed.elements.get('#wallet-error').textContent, /backend is unavailable/i);
  assert.match(failed.elements.get('#wallet-transactions-error').textContent, /backend is unavailable/i);
  assert.equal(failed.elements.get('#wallet-balance').textContent, '—');
  assert.equal(failed.elements.get('#wallet-transactions').innerHTML, '');

  const unauthenticated = createHarness(async () => {
    throw Object.assign(new Error('Your session is missing or expired. Log in and try again.'), { code: 'UNAUTHORIZED' });
  });
  await flush();
  assert.match(unauthenticated.elements.get('#wallet-error').textContent, /session is missing/i);
  assert.match(unauthenticated.elements.get('#wallet-transactions-error').textContent, /session is missing/i);
});

test('money formatting and decimal conversion are safe in integer paise', () => {
  const harness = createHarness();
  assert.equal(harness.sandbox.ArenaMoney.formatPaise(0), '₹0.00');
  assert.equal(harness.sandbox.ArenaMoney.formatPaise(123456789), '₹12,34,567.89');
  assert.equal(harness.sandbox.ArenaMoney.formatPaise(-1), '—');
  assert.equal(harness.sandbox.ArenaMoney.formatPaise(Number.MAX_SAFE_INTEGER + 1), '—');
  assert.equal(harness.sandbox.ArenaWallet.parseAmountMinor('0.01'), 1);
  assert.equal(harness.sandbox.ArenaWallet.parseAmountMinor('1000000.00'), 100000000);
  assert.equal(harness.sandbox.ArenaWallet.parseAmountMinor('1.001'), null);
  assert.equal(harness.sandbox.ArenaWallet.parseAmountMinor('-1'), null);
  assert.equal(harness.sandbox.ArenaWallet.parseAmountMinor('1000000.01'), null);
});

test('API client maps withdrawal and wallet error contracts to safe messages', async () => {
  const apiSource = fs.readFileSync(path.join(root, 'js/api.js'), 'utf8');
  const sandbox = {
    document: { baseURI: 'https://example.test/wallet.html' },
    URL,
    Headers,
    async fetch() {
      return {
        ok: false,
        status: 409,
        async text() { return JSON.stringify({ error: { code: 'INSUFFICIENT_FUNDS', message: 'private database detail' } }); }
      };
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(apiSource, sandbox);
  await assert.rejects(sandbox.ArenaApi.request('/api/wallet/withdrawal-requests', { method: 'POST', body: { amountMinor: 1 } }), (error) => {
    assert.equal(error.code, 'INSUFFICIENT_FUNDS');
    assert.equal(error.message, 'Available wallet balance is insufficient.');
    assert.doesNotMatch(error.message, /private database detail/i);
    return true;
  });
});

test('Add Money is disabled and has no success-shaped deposit operation', () => {
  assert.match(walletMarkup, /Real deposits will be enabled with a payment provider in a later step/);
  assert.match(walletMarkup, /button class="button button-primary" type="submit" disabled aria-disabled="true">Deposits unavailable/);
  assert.doesNotMatch(walletSource, /creditWallet|depositWallet|POST.*\/api\/wallet/);
  assert.doesNotMatch(walletMarkup, /Add Demo Funds|DEMO CREDIT|simulated browser credits/i);
});

test('admin wallet totals and cross-user ledger remain explicitly unavailable, not localStorage-backed', () => {
  const sandbox = {
    ArenaAuth: { isAdmin: () => true, getUsers: () => [] },
    ArenaTournaments: { getTournaments: () => [] },
    ArenaTeams: { getTeams: () => [] },
    ArenaMatches: { getMatches: () => [] },
    localStorage: { getItem(key) { throw new Error(`Unexpected local read: ${key}`); } }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(adminSource, sandbox, { filename: 'js/admin.js' });
  const summary = sandbox.ArenaAdmin.getSummary();
  assert.equal(summary.totalUsers, null);
  assert.equal(summary.totalWalletBalance, null);
  assert.equal(summary.totalWalletTransactions, null);
  assert.equal(sandbox.ArenaAdmin.getUsers(), null);
  assert.equal(sandbox.ArenaAdmin.getWalletTransactions(), null);
  const markup = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  assert.match(markup, /current backend API does not provide an admin user directory or account-status management/);
  assert.match(markup, /Cross-user wallet and transaction data is not available to admins/);
  assert.doesNotMatch(adminSource, /arenaX_wallets|arenaX_transactions/);
});

test('paid tournament registration checks backend wallet availability and submits to the authoritative API', () => {
  const source = fs.readFileSync(path.join(root, 'js/tournament-pages.js'), 'utf8');
  assert.match(source, /ArenaApi\.request\('\/api\/wallet'\)/);
  assert.match(source, /wallet\.availableBalanceMinor >= feeMinor/);
  assert.match(source, /store\.joinTournament\(pendingJoinId/);
  assert.match(source, /refreshWalletState\(\)/);
  assert.doesNotMatch(source, /paidEntryUnavailable|Paid registration is unavailable until backend wallet settlement/);
});
