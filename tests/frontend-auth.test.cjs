const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const apiSource = fs.readFileSync(path.join(root, 'js/api.js'), 'utf8');
const authSource = fs.readFileSync(path.join(root, 'js/auth.js'), 'utf8');

function createAuthHarness(handler, entries = {}) {
  const values = new Map(Object.entries(entries));
  const calls = [];
  const storage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
  const location = {
    pathname: '/login.html',
    search: '',
    replaced: null,
    assigned: null,
    replace(value) { this.replaced = value; },
    assign(value) { this.assigned = value; }
  };
  const document = {
    baseURI: 'https://example.test/ARENA-X/login.html',
    body: { dataset: {} },
    head: { append() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ addEventListener() {} }),
    addEventListener() {},
    dispatchEvent() {}
  };
  const sandbox = {
    document,
    localStorage: storage,
    location,
    URL,
    URLSearchParams,
    CustomEvent: class CustomEvent {},
    window: { setTimeout },
    ArenaApi: {
      async request(url, options = {}) {
        calls.push({ url, options });
        return handler(url, options);
      }
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(authSource, sandbox, { filename: 'js/auth.js' });
  return { auth: sandbox.ArenaAuth, calls, location, values };
}

function publicUser(overrides = {}) {
  return {
    userId: 'user-123',
    fullName: 'Arena Player',
    username: 'arena_player',
    email: 'player@example.test',
    avatar: 'AP',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

test('API helper uses project-relative paths, JSON, and credentialed cookies', async () => {
  let captured;
  const sandbox = {
    document: { baseURI: 'https://example.test/ARENA-X/login.html' },
    URL,
    Headers,
    async fetch(url, options) {
      captured = { url, options };
      return { ok: true, status: 200, text: async () => JSON.stringify({ user: publicUser() }) };
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(apiSource, sandbox);
  const result = await sandbox.ArenaApi.request('/api/auth/login', {
    method: 'POST',
    body: { identifier: 'arena_player', password: 'secret-value' }
  });

  assert.equal(captured.url, 'https://example.test/ARENA-X/api/auth/login');
  assert.equal(captured.options.credentials, 'include');
  assert.equal(captured.options.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(JSON.parse(captured.options.body), { identifier: 'arena_player', password: 'secret-value' });
  assert.equal(result.user.username, 'arena_player');
});

test('API helper does not expose raw server or database errors', async () => {
  const sandbox = {
    document: { baseURI: 'https://example.test/index.html' },
    URL,
    Headers,
    async fetch() {
      return { ok: false, status: 500, text: async () => '{"error":{"message":"password database-secret"}}' };
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(apiSource, sandbox);

  await assert.rejects(sandbox.ArenaApi.request('/api/auth/me'), (error) => {
    assert.equal(error.code, 'BACKEND_UNAVAILABLE');
    assert.doesNotMatch(error.message, /database-secret|password/);
    return true;
  });
});

test('login success verifies the backend session and stores no password or token', async () => {
  let authenticated = false;
  const { auth, calls, values } = createAuthHarness(async (url, options) => {
    if (url === '/api/auth/me') {
      if (!authenticated) throw Object.assign(new Error('Unauthorized'), { code: 'UNAUTHORIZED' });
      return { user: publicUser() };
    }
    if (url === '/api/auth/login') {
      assert.equal(options.method, 'POST');
      authenticated = true;
      return { user: publicUser() };
    }
    throw new Error(`Unexpected request ${url}`);
  });
  await auth.ready;
  const result = await auth.loginUser('arena_player', 'secret-value');

  assert.equal(result.success, true);
  assert.equal(auth.isLoggedIn(), true);
  assert.equal(auth.getCurrentUser().username, 'arena_player');
  assert.deepEqual(calls.map((call) => call.url), ['/api/auth/me', '/api/auth/login', '/api/auth/me']);
  const stored = [...values.values()].join(' ');
  assert.doesNotMatch(stored, /secret-value|passwordHash|sessionToken|arena_x_session/);
});

test('invalid and suspended-account login responses show a generic safe message', async () => {
  const { auth } = createAuthHarness(async (url) => {
    if (url === '/api/auth/me' || url === '/api/auth/login') {
      throw Object.assign(new Error('Email/username or password was not recognized.'), { code: 'UNAUTHORIZED' });
    }
  });
  await auth.ready;
  const result = await auth.loginUser('player@example.test', 'wrong-password');

  assert.equal(result.success, false);
  assert.match(result.message, /not recognized/);
  assert.doesNotMatch(result.message, /suspended|database|SQL/i);
});

test('signup calls register then verifies the cookie session without sending privilege fields', async () => {
  const calls = [];
  const { auth } = createAuthHarness(async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/auth/register') return { user: publicUser() };
    if (url === '/api/auth/me') return { user: publicUser() };
  });
  await auth.ready;
  const result = await auth.registerUser({
    fullName: 'Arena Player', username: 'arena_player', email: 'player@example.test',
    phone: '+91 98765 43210', password: 'secret-value', dateOfBirth: '2000-01-01',
    role: 'admin', isDemo: true, status: 'active'
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls.map((call) => call.url), ['/api/auth/me', '/api/auth/register', '/api/auth/me']);
  const submitted = calls.find((call) => call.url === '/api/auth/register').options.body;
  assert.deepEqual(Object.keys(submitted).sort(), ['dateOfBirth', 'email', 'fullName', 'password', 'phone', 'username']);
});

test('duplicate signup returns a safe conflict message', async () => {
  const { auth } = createAuthHarness(async (url) => {
    if (url === '/api/auth/me') throw Object.assign(new Error('Unauthorized'), { code: 'UNAUTHORIZED' });
    throw Object.assign(new Error('An account with those details already exists.'), { code: 'CONFLICT' });
  });
  await auth.ready;
  const result = await auth.registerUser({ username: 'taken', password: 'secret-value' });

  assert.equal(result.success, false);
  assert.match(result.message, /already exists/);
});

test('logout revokes via the backend and clears only in-memory session state', async () => {
  const { auth, calls } = createAuthHarness(async (url, options) => {
    if (url === '/api/auth/me') return { user: publicUser() };
    if (url === '/api/auth/logout') return { success: true };
  });
  await auth.ready;
  const result = await auth.logoutUser();

  assert.equal(result.success, true);
  assert.equal(auth.isLoggedIn(), false);
  assert.equal(calls.at(-1).url, '/api/auth/logout');
  assert.equal(calls.at(-1).options.method, 'POST');
});

test('expired sessions redirect protected pages and localStorage cannot grant admin', async () => {
  const existingUsers = [{ userId: 'legacy-user', username: 'old', password: 'old-password', role: 'admin', isDemo: true }];
  const { auth, location, values } = createAuthHarness(async (url) => {
    if (url === '/api/auth/me') return { user: publicUser({ role: 'admin', status: 'active' }) };
  }, {
    'arena-x-users-v1': JSON.stringify(existingUsers),
    'arena-x-session-v1': JSON.stringify({ userId: 'legacy-user', expiresAt: Date.now() + 3600000 })
  });
  await auth.ready;

  assert.equal(auth.isLoggedIn(), true);
  assert.equal(auth.isAdmin(), false);
  assert.equal(await auth.requireAdmin(), false);
  assert.equal(location.replaced, 'index.html');
  assert.equal(values.has('arena-x-session-v1'), false);
  const users = JSON.parse(values.get('arena-x-users-v1'));
  assert.equal(users[0].password, undefined);
  assert.equal(users[0].username, 'old');
  assert.equal(users.some((user) => user.role === 'admin' && user.userId === 'user-123'), false);
});

test('invalid sessions do not create a browser session', async () => {
  const { auth, location } = createAuthHarness(async () => {
    throw Object.assign(new Error('Unauthorized'), { code: 'UNAUTHORIZED' });
  });
  await auth.ready;

  assert.equal(auth.isLoggedIn(), false);
  assert.equal(await auth.requireLogin(), false);
  assert.equal(location.replaced, 'login.html');
});

test('static HTML script references resolve and PWA registration remains present', () => {
  const pages = fs.readdirSync(root).filter((file) => file.endsWith('.html'));
  assert.ok(pages.length > 0);
  for (const page of pages) {
    const markup = fs.readFileSync(path.join(root, page), 'utf8');
    for (const [, source] of markup.matchAll(/<script\s+src="([^"]+)"/g)) {
      assert.equal(fs.existsSync(path.join(root, source)), true, `${page} references missing ${source}`);
    }
    assert.match(markup, /js\/pwa\.js/);
  }
  assert.match(fs.readFileSync(path.join(root, 'js/pwa.js'), 'utf8'), /serviceWorker\.register/);
  assert.match(fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8'), /addEventListener\('fetch'/);
});