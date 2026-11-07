/**
 * db.ts — the connection pool, the migration, and the transaction helper.
 *
 * WHY THE SCHEMA IS APPLIED BY THE APPLICATION
 * --------------------------------------------
 * `schema.sql` is idempotent (`create table if not exists`) and is applied on
 * startup. That is a deliberate choice for this repository rather than a general
 * recommendation: the agentic-devex requirement is that `docker compose up`
 * followed by one test command works from a clean machine with no migration
 * step to remember, and a test that spins up a throwaway Postgres must not need
 * a separate tool in its path. The cost is that there is no migration HISTORY —
 * no way to express "rename this column" — and the moment a second version of
 * this schema has to coexist with the first, this needs to become a real
 * migration tool. Noted here rather than discovered later.
 *
 * ponytail: `if not exists` instead of a migration framework. The upgrade path
 * is any ordinary migration runner reading the same file as its first revision.
 */

import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

export type Db = Pool;

export function connect(databaseUrl: string): Db {
  return new Pool({
    connectionString: databaseUrl,
    // Small on purpose. The work queue bounds concurrency (src/service/queue.ts)
    // and a pool larger than the queue only buys the ability to open more
    // connections than the process can use — which is how a handful of
    // reconcilers exhaust a Postgres connection limit while all of them are
    // idle. Sized from the queue, not from hope.
    max: 10,
    // A connection that hangs forever turns one network glitch into a worker
    // that never returns to the loop. Everything here is local, so these are
    // generous and still finite.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

export async function migrate(db: Db, schemaPath: string): Promise<void> {
  await db.query(await readFile(schemaPath, 'utf8'));
}

/**
 * Run a unit of work in one transaction, rolling back on any throw.
 *
 * THIS IS THE LOAD-BEARING ABSTRACTION OF THE WHOLE REPOSITORY. The one thing
 * that must be atomic is "write the new phase AND the intent to send a command"
 * — see the outbox note in db/schema.sql. Everything else can be retried.
 * Getting this wrong by leaking a client on the error path is also the classic
 * way to exhaust a pool, hence the `finally`.
 */
export async function tx<T>(db: Db, work: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    // Rollback can itself fail if the connection died, and that must not mask
    // the original error — which is the one that says what actually went wrong.
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type Queryable = Pick<PoolClient, 'query'>;

/** Rows, typed at the one boundary where SQL results enter the program. */
export async function rows<T extends QueryResultRow>(
  q: Queryable,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await q.query<T>(sql, params as unknown[]);
  return result.rows;
}
