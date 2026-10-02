import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { CompetitionError } from './contracts.js';
import { PostgresCompetitionRepository } from './postgres-repository.js';

test('PostgreSQL repository rejects paid registration before inserting it', async () => {
  const queries: string[] = [];
  let released = false;

  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('FROM tournaments WHERE id = $1 FOR UPDATE')) {
        return {
          rows: [{
            id: randomUUID(),
            participation_type: 'Solo',
            status: 'upcoming',
            max_slots: 10,
            registration_deadline: new Date(Date.now() + 60_000),
            entry_fee_minor: '1000'
          }],
          rowCount: 1
        };
      }
      throw new Error(`Unexpected query in paid-registration test: ${sql}`);
    },
    release() {
      released = true;
    }
  } as unknown as PoolClient;

  const pool = {
    async connect() {
      return client;
    }
  } as unknown as Pool;
  const repository = new PostgresCompetitionRepository(pool);

  await assert.rejects(
    repository.registerForTournament(randomUUID(), randomUUID()),
    (error: unknown) =>
      error instanceof CompetitionError
      && error.statusCode === 409
      && error.code === 'PAID_REGISTRATION_UNAVAILABLE'
  );

  assert.equal(queries[0], 'BEGIN');
  assert.ok(queries.includes('ROLLBACK'));
  assert.equal(queries.some((query) => query.startsWith('INSERT INTO tournament_registrations')), false);
  assert.equal(released, true);
});
