/** Two vendors, one batch: the deadline a device is judged against must be its
 *  own. A fleet-wide timeout makes the fast vendor wait for the slow one. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPostgres } from './_stack.ts';
import { connect, migrate } from '../../src/store/db.ts';
import { register } from '../../src/store/devices.ts';
import { initialPhase } from '../../src/core/reconcile.ts';
import { unknownClock } from '../../src/core/clock.ts';
import { instant } from '../../src/core/time.ts';
import { reconcileBatch } from '../../src/service/worker.ts';
import { createInstruments } from '../../src/telemetry.ts';
import { noTwin } from '../../src/twin/project.ts';
import { loadConfig } from '../../src/config.ts';

test('each vendor is judged against its own deadline', async () => {
  const pg = await startPostgres();
  const db = connect(pg.getConnectionUri());
  process.env['VENDOR_TIMING'] = JSON.stringify({
    // A platform that echoes a generation: confirmation is exact, so a short
    // deadline is honest rather than impatient.
    quick: { commandTimeout: 10_000 },
  });
  try {
    await migrate(db, new URL('../../db/schema.sql', import.meta.url).pathname);
    for (const [id, vendor] of [
      ['fast', 'quick'],
      ['slow', 'patient'],
    ]) {
      await register(db, id!, vendor!, initialPhase(instant(0)), unknownClock, instant(0));
      await db.query(`insert into observation values ($1,true,1000,1000,'PLUGGED_IN:STOPPED',null)`, [id]);
      await db.query(
        `update device set intent_charging=true, intent_source='operator', intent_set_at=1000`,
        [],
      );
    }
    const cfg = loadConfig();
    const worker = { db, twin: noTwin, instruments: createInstruments(), cfg };

    await reconcileBatch(worker, instant(1001));
    const phases = async () =>
      Object.fromEntries(
        (await db.query('select device_id, phase from device')).rows.map((r) => [r.device_id, r.phase.phase]),
      );
    assert.deepEqual(await phases(), { fast: 'ISSUED', slow: 'ISSUED' });

    // Past the quick vendor's 10s deadline, nowhere near the fleet's 300s.
    await db.query('update device set wake_at=0');
    await reconcileBatch(worker, instant(1001 + 20_000));
    assert.deepEqual(
      await phases(),
      { fast: 'FAILED', slow: 'ISSUED' },
      'the fast vendor must fail on its own deadline while the slow one keeps waiting',
    );
  } finally {
    delete process.env['VENDOR_TIMING'];
    await db.end();
    await pg.stop();
  }
});
