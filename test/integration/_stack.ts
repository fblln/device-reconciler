/**
 * _stack.ts — bringing up the real dependencies for an integration test.
 *
 * WHY TESTCONTAINERS AND NOT THE COMPOSE FILE
 * -------------------------------------------
 * `npm run up` is for a human or an agent driving the system. A test needs a
 * database nobody else is using, on a port nobody else has, torn down
 * afterwards, with no `npm run down` to forget — otherwise the first failing run
 * leaves a dirty volume and every subsequent run is a liar. Testcontainers gives
 * exactly that, and it needs only the Docker daemon that is already required.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT
 * ---------------------------------
 *   Postgres    real, in a container. Everything this repository adds over its
 *               sibling lives in SQL: the outbox's primary key, `for update skip
 *               locked`, the durable timer. None of it can be tested against a
 *               fake, because the fake would be my belief about Postgres rather
 *               than Postgres.
 *   the platform real HTTP, in process. It is the simulated aggregator, which
 *               exists precisely so that clock skew, reordering, duplicate
 *               webhooks and devices that never apply a command can be injected
 *               on demand and replayed from a seed. Real vendor hardware does
 *               not do that when asked.
 *   Ditto       real, but out of process and optional — see twin.test.ts. A
 *               five-container JVM stack inside every test run would cost more
 *               than it proves; it is brought up by `npm run up` and the twin
 *               test runs against it when it is there.
 *
 * READINESS PROBES, DELIBERATELY NOT A SHELL
 * ------------------------------------------
 * Nothing here waits by opening a socket from a shell. Testcontainers' own
 * default wait strategy tries, in order, a /proc/net/tcp grep, `nc -vz`, and
 * then `/bin/bash -c '</dev/tcp/localhost/<port>'` — and that last one is
 * byte-for-byte the construct every reverse-shell detection rule is written
 * against, which is how a hermetic test suite raises a High-severity finding on
 * a CI runner. So the Postgres wait below is an explicit log-message strategy,
 * and the compose health checks are `pg_isready`, `mongosh --eval` and
 * `curl --fail`: real clients that prove a server answered, or a file read.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Wait } from 'testcontainers';
import { connect, migrate, type Db } from '../../src/store/db.ts';
import { startPlatform, type Platform } from '../../src/platform/server.ts';

export const SEED = 20261107;
export const WEBHOOK_SECRET = 'test-webhook-secret';
export const CLIENT_ID = 'reconciler';
export const CLIENT_SECRET = 'test-client-secret';

export type Stack = Readonly<{
  db: Db;
  databaseUrl: string;
  platform: Platform;
  stop: () => Promise<void>;
}>;

export async function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return (
    new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('reconciler')
      .withUsername('reconciler')
      .withPassword('reconciler')
      /*
       * An explicit log wait, replacing the default port-listening wait for the
       * reason in the header. Postgres prints this line twice — once when the
       * initdb bootstrap server comes up and once for the real one — so the
       * second occurrence is the one that means the database is actually
       * accepting client connections. Getting this wrong gives a connection
       * refused in roughly one run in ten, on a loaded machine only.
       */
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start()
  );
}

/**
 * A whole stack: a fresh database with the schema applied, and the simulated
 * platform listening on an ephemeral port.
 *
 * `fleetSize` is small by default. The point of an integration test is the
 * plumbing, and twenty-four devices make a failure harder to read without
 * testing anything the first two do not.
 */
export async function startStack(
  over: Partial<{ fleetSize: number; tickMs: number; webhookUrl: string }> = {},
): Promise<Stack> {
  const pg = await startPostgres();
  const databaseUrl = pg.getConnectionUri();
  const db = connect(databaseUrl);
  await migrate(db, new URL('../../db/schema.sql', import.meta.url).pathname);

  const platform = startPlatform({
    // Port 0: the OS picks a free one. A fixed port is how two test files run in
    // parallel on CI and one of them fails for reasons that look like a bug.
    port: 0,
    fleetSize: over.fleetSize ?? 2,
    seed: SEED,
    tickMs: over.tickMs ?? 250,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    webhookSecret: WEBHOOK_SECRET,
    webhookUrl: over.webhookUrl ?? '',
  });

  return {
    db,
    databaseUrl,
    platform,
    stop: async () => {
      await platform.stop();
      await db.end();
      await pg.stop();
    },
  };
}

/**
 * Poll until a condition holds, or fail with what was last seen.
 *
 * Every integration assertion here is eventual — the loop is asynchronous by
 * design — so the alternative to this is a sleep long enough to be reliable,
 * which is a suite nobody runs. The message matters as much as the waiting: a
 * bare "timed out" sends somebody to read the whole log, and the last observed
 * value usually says what went wrong on its own.
 */
export async function until<T>(
  what: string,
  probe: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await probe();
    if (ok(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
