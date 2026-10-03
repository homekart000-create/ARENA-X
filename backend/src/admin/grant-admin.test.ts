import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { buildApp } from '../app.js';
import { parseEnvironment } from '../config/env.js';
import { AdminGrantError, grantAdminByIdentifier, parseAdminGrantArguments } from './grant-admin.js';

interface TestAccount {
  readonly id: string;
  readonly email: string;
  readonly username: string;
  status: string;
  adminRevokedAt: Date | null | undefined;
  activeAdminAssignments: number;
}

function makePool(accounts: TestAccount[]) {
  const queries: string[] = [];
  const pool = {
    async connect() {
      const client = {
        async query(sql: string, values: readonly unknown[] = []) {
          queries.push(sql);
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
          if (sql.includes('FROM users')) {
            const identifier = String(values[0]);
            const matched = accounts.filter((account) =>
              account.email.toLowerCase() === identifier || account.username.toLowerCase() === identifier
            );
            return {
              rows: matched.map(({ id, username, status }) => ({ id, username, status })),
              rowCount: matched.length
            };
          }
          if (sql.includes('FROM user_role_assignments')) {
            const account = accounts.find(({ id }) => id === values[0]);
            return account?.adminRevokedAt === undefined
              ? { rows: [], rowCount: 0 }
              : { rows: [{ revoked_at: account.adminRevokedAt }], rowCount: 1 };
          }
          if (sql.startsWith('INSERT INTO user_role_assignments')) {
            const account = accounts.find(({ id }) => id === values[0]);
            assert.ok(account);
            account.adminRevokedAt = null;
            account.activeAdminAssignments += 1;
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('UPDATE user_role_assignments')) {
            const account = accounts.find(({ id }) => id === values[0]);
            assert.ok(account);
            account.adminRevokedAt = null;
            account.activeAdminAssignments = 1;
            return { rows: [], rowCount: 1 };
          }
          throw new Error(`Unexpected test query: ${sql}`);
        },
        release() {}
      };
      return client as unknown as PoolClient;
    }
  };
  return { pool: pool as Pick<Pool, 'connect'>, queries };
}

function account(overrides: Partial<TestAccount> = {}): TestAccount {
  return {
    id: 'user-1',
    email: 'homekart@example.test',
    username: 'homekart',
    status: 'active',
    adminRevokedAt: undefined,
    activeAdminAssignments: 0,
    ...overrides
  };
}

test('operator grant requires explicit confirmation and one exact identifier', () => {
  assert.equal(parseAdminGrantArguments(['--confirm', ' HomeKart@Example.Test ']), 'homekart@example.test');
  assert.throws(() => parseAdminGrantArguments([]), /Usage:/);
  assert.throws(() => parseAdminGrantArguments(['homekart@example.test']), /Usage:/);
  assert.throws(() => parseAdminGrantArguments(['--confirm', 'one@example.test', 'extra']), /Usage:/);
  assert.throws(() => parseAdminGrantArguments(['--confirm', '  ']), /exact email address or username/);
});

test('grants admin to the exact active account through a transaction', async () => {
  const target = account();
  const { pool, queries } = makePool([target]);
  const result = await grantAdminByIdentifier(pool, '  HOMEKART@EXAMPLE.TEST ');
  const repeatedResult = await grantAdminByIdentifier(pool, target.email);

  assert.deepEqual(result, { status: 'granted' });
  assert.deepEqual(repeatedResult, { status: 'already-admin' });
  assert.equal(target.activeAdminAssignments, 1);
  assert.ok(queries[0] === 'BEGIN');
  assert.ok(queries.some((query) => query.includes('FOR UPDATE')));
  assert.ok(queries.some((query) => query.startsWith('INSERT INTO user_role_assignments')));
  assert.equal(queries.at(-1), 'COMMIT');
});

test('fails safely when the account does not exist', async () => {
  const { pool, queries } = makePool([]);
  await assert.rejects(grantAdminByIdentifier(pool, 'missing@example.test'), (error: unknown) => {
    assert.ok(error instanceof AdminGrantError);
    assert.match(error.message, /No account matches/);
    return true;
  });
  assert.equal(queries.at(-1), 'ROLLBACK');
});

for (const status of ['suspended', 'closed']) {
  test(`does not grant admin to a ${status} account`, async () => {
    const target = account({ status });
    const { pool } = makePool([target]);
    await assert.rejects(grantAdminByIdentifier(pool, target.email), /matching account is not active/);
    assert.equal(target.activeAdminAssignments, 0);
  });
}

test('is idempotent for an account that already has an active admin assignment', async () => {
  const target = account({ adminRevokedAt: null, activeAdminAssignments: 1 });
  const { pool, queries } = makePool([target]);
  const result = await grantAdminByIdentifier(pool, target.email);

  assert.deepEqual(result, { status: 'already-admin' });
  assert.equal(target.activeAdminAssignments, 1);
  assert.equal(queries.some((query) => query.startsWith('INSERT INTO user_role_assignments')), false);
});

test('reactivates an existing revoked assignment without creating another row', async () => {
  const target = account({ adminRevokedAt: new Date(), activeAdminAssignments: 0 });
  const { pool, queries } = makePool([target]);
  const result = await grantAdminByIdentifier(pool, target.email);

  assert.deepEqual(result, { status: 'granted' });
  assert.equal(target.adminRevokedAt, null);
  assert.equal(target.activeAdminAssignments, 1);
  assert.equal(queries.some((query) => query.startsWith('INSERT INTO user_role_assignments')), false);
});

test('fails safely if an identifier matches multiple accounts', async () => {
  const first = account();
  const second = account({ id: 'user-2', email: 'different@example.test', username: 'homekart@example.test' });
  const { pool } = makePool([first, second]);
  await assert.rejects(grantAdminByIdentifier(pool, first.email), /matches multiple accounts/);
  assert.equal(first.activeAdminAssignments, 0);
  assert.equal(second.activeAdminAssignments, 0);
});

test('admin grants are not exposed through a public API route', async (context) => {
  const authRepository = {
    async createUser() { throw new Error('Not used by this route check.'); },
    async findByIdentifier() { return null; },
    async createSession() {},
    async findSessionUser() { return null; },
    async revokeSession() {},
    async closeOwnAccount() { return false; }
  };
  const app = buildApp(parseEnvironment({ NODE_ENV: 'test' }), authRepository);
  context.after(async () => app.close());

  for (const url of ['/api/admin/roles', '/api/admin/users/user-1/role']) {
    const response = await app.inject({ method: 'POST', url, payload: { role: 'admin' } });
    assert.equal(response.statusCode, 404);
  }
});
