/** Real HTTP and Postgres: concurrent clicks must commit one action and retain
 * override metadata; reconnecting the process must not lose request identity. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startPostgres } from './_stack.ts';
import { connect, migrate } from '../../src/store/db.ts';
import { register } from '../../src/store/devices.ts';
import { initialPhase } from '../../src/core/reconcile.ts';
import { unknownClock } from '../../src/core/clock.ts';
import { instant } from '../../src/core/time.ts';
import { handleIntent, operation, submitIntent, IntentError } from '../../src/service/intent.ts';

test('durable user actions: retries, coalescing, conflicts and explicit retry', async () => {
  const pg = await startPostgres();
  let db = connect(pg.getConnectionUri());
  let now = 1000;
  const server = createServer((req, res) => {
    void handleIntent(req, res, db, 'charger', req.method === 'POST', now).catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  try {
    await migrate(db, new URL('../../db/schema.sql', import.meta.url).pathname);
    await register(db, 'charger', 'hono', initialPhase(instant(0)), unknownClock, instant(0));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = async (key: string, body: unknown, method = 'PUT') => {
      const res = await fetch(url, {
        method,
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify(body),
      });
      return {
        status: res.status,
        location: res.headers.get('location'),
        body: (await res.json()) as {
          operationId: string;
          replayed: boolean;
          phase: unknown;
          status: string;
        },
      };
    };
    assert.equal((await request('', { charging: true })).status, 400);
    assert.equal((await request('bad', { charging: 'true' })).status, 400);
    const badJson = await fetch(url, { method: 'PUT', body: '{' });
    assert.equal(badJson.status, 400);
    const clicks = await Promise.all(Array.from({ length: 8 }, () => request('click-1', { charging: true })));
    const id = clicks[0]!.body.operationId;
    assert.ok(clicks.every((r) => r.status === 200 && r.body.operationId === id));
    assert.equal(clicks[0]!.location, `/v1/devices/charger/operations/${id}`);
    assert.equal(clicks.filter((r) => !r.body.replayed).length, 1);
    const issued = {
      phase: 'ISSUED',
      since: 1001,
      target: true,
      deadline: 5000,
      commandId: 'command-1',
      generation: 1,
    };
    await db.query('update device set phase=$1, local_change_at=1500 where device_id=$2', [
      issued,
      'charger',
    ]);
    now = 2000;
    const joined = await request('different-click', { charging: true });
    assert.equal(joined.body.operationId, id);
    assert.deepEqual(joined.body.phase, issued);
    let row = (await db.query('select * from device')).rows[0];
    assert.equal(Number(row.intent_set_at), 1000);
    assert.equal(Number(row.local_change_at), 1500);
    assert.equal((await request('click-1', { charging: false })).status, 409);
    assert.equal((await request('premature-retry', { retryOf: id }, 'POST')).status, 409);
    await db.end();
    db = connect(pg.getConnectionUri());
    assert.equal((await request('click-1', { charging: true })).body.operationId, id);
    await db.query('update device set phase=$1', [
      { phase: 'FAILED', since: 5000, target: true, reason: 'timeout-unconfirmed' },
    ]);
    const failed = await request('another-click', { charging: true });
    assert.equal(failed.body.status, 'FAILED');
    now = 6000;
    const retried = await request('retry-key', { retryOf: id }, 'POST');
    assert.equal(retried.status, 200);
    assert.notEqual(retried.body.operationId, id);
    assert.equal(retried.body.status, 'ACCEPTED');
    assert.equal(
      (await request('retry-key', { retryOf: id }, 'POST')).body.operationId,
      retried.body.operationId,
    );
    assert.equal((await request('second-retry', { retryOf: id }, 'POST')).status, 409);
    assert.equal((await operation(db, 'charger', id)).status, 'SUPERSEDED');
    assert.equal((await request('click-1', { charging: true })).body.status, 'SUPERSEDED');
    const stop = await request('stop', { charging: false });
    assert.notEqual(stop.body.operationId, retried.body.operationId);
    row = (await db.query('select * from device')).rows[0];
    assert.equal(row.intent_charging, false);
    assert.equal(row.local_change_at, null);
    assert.equal(Number(row.intent_set_at), 6000);
    await assert.rejects(
      operation(db, 'charger', 'missing'),
      (e: unknown) => e instanceof IntentError && e.status === 404,
    );
    await assert.rejects(
      submitIntent(db, 'missing', 'key', { charging: true, source: 'operator' }, 1),
      (e: unknown) => e instanceof IntentError && e.status === 404,
    );
    assert.equal((await db.query('select count(*)::int as n from intent_operation')).rows[0].n, 3);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await db.end();
    await pg.stop();
  }
});

test('explicit retry creates a fresh command, and a stale worker cannot overwrite a new action', async () => {
  const pg = await startPostgres();
  const db = connect(pg.getConnectionUri());
  const other = connect(pg.getConnectionUri());
  try {
    await migrate(db, new URL('../../db/schema.sql', import.meta.url).pathname);
    await register(db, 'charger', 'hono', initialPhase(instant(0)), unknownClock, instant(0));
    const { reconcileBatch } = await import('../../src/service/worker.ts');
    const { createInstruments } = await import('../../src/telemetry.ts');
    const { noTwin } = await import('../../src/twin/project.ts');
    const { loadConfig } = await import('../../src/config.ts');
    const cfg = loadConfig();
    const worker = {
      db,
      twin: noTwin,
      instruments: createInstruments(),
      cfg: { ...cfg, timing: cfg.timing },
    };
    await db.query(`insert into observation values ('charger',true,1000,1000,'PLUGGED_IN:STOPPED',0)`);
    const first = await submitIntent(db, 'charger', 'one', { charging: true, source: 'operator' }, 1000);
    await reconcileBatch(worker, instant(1001));
    let phase = (await db.query('select phase from device')).rows[0].phase;
    assert.equal(phase.phase, 'ISSUED');
    const oldCommand = phase.commandId;
    await db.query('update device set phase=$1', [
      { phase: 'FAILED', since: 2000, target: true, reason: 'timeout-unconfirmed' },
    ]);
    await submitIntent(db, 'charger', 'retry', { retryOf: first.operationId }, 2001);
    await reconcileBatch(worker, instant(2002));
    phase = (await db.query('select phase from device')).rows[0].phase;
    assert.equal(phase.phase, 'ISSUED');
    assert.notEqual(phase.commandId, oldCommand);
    assert.equal(phase.generation, 2);
    // Pause precisely between the real claim query and transaction acquisition.
    // A second connection commits a new user action while this worker is stale.
    await db.query('update device set wake_at=0');
    const originalQuery = db.query.bind(db);
    db.query = (async (sql: string, values: unknown[]) => {
      const result = await originalQuery(sql, values);
      if (sql.includes('with due as')) {
        db.query = originalQuery;
        await submitIntent(other, 'charger', 'stop', { charging: false, source: 'operator' }, 3000);
      }
      return result;
    }) as typeof db.query;
    const before = (await originalQuery('select count(*)::int n from decision')).rows[0].n;
    await reconcileBatch(worker, instant(3001));
    assert.equal((await db.query('select count(*)::int n from decision')).rows[0].n, before);
    assert.equal((await db.query('select count(*)::int n from outbox')).rows[0].n, 2);
    assert.equal((await db.query('select intent_charging from device')).rows[0].intent_charging, false);
    // Once the stale lease expires, a fresh worker can supersede the old target.
    await db.query('update device set leased_until=null');
    await reconcileBatch(worker, instant(3002));
    assert.equal((await db.query('select phase from device')).rows[0].phase.target, false);
  } finally {
    await db.end();
    await other.end();
    await pg.stop();
  }
});
