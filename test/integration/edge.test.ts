/** The persisted twin is a cache, not a stream of fresh observations. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startPostgres } from './_stack.ts';
import { connect, migrate, rows } from '../../src/store/db.ts';
import { register } from '../../src/store/devices.ts';
import { initialPhase } from '../../src/core/reconcile.ts';
import { unknownClock } from '../../src/core/clock.ts';
import { instant } from '../../src/core/time.ts';
import { createEdgeAdapter } from '../../src/edge/adapter.ts';
import { DEVICE } from '../../src/edge/provision.ts';

test('polling the same Hono capture never refreshes liveness or counts another clock sample', async () => {
  const pg = await startPostgres();
  const db = connect(pg.getConnectionUri());
  let value: unknown = {
    sampleId: 'one',
    deviceTime: 9000,
    powerDeliveryState: 'PLUGGED_IN:STOPPED',
    observedGeneration: null,
  };
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  });
  try {
    await migrate(db, new URL('../../db/schema.sql', import.meta.url).pathname);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const edge = createEdgeAdapter(db, url);
    assert.equal(await edge.ingest(instant(10_000)), false, 'telemetry cannot register a device');
    await register(db, DEVICE, 'hono', initialPhase(instant(10_000)), unknownClock, instant(10_000));
    assert.equal(await edge.ingest(instant(10_000)), true);
    // Reconstruct the adapter too: deduplication must survive process restart.
    assert.equal(await createEdgeAdapter(db, url).ingest(instant(20_000)), false);
    const [stored] = await rows<{ received_at: string; device_time: string; clock: { samples: number } }>(
      db,
      'select received_at, device_time, clock from observation join device using (device_id)',
    );
    assert.equal(Number(stored?.received_at), 10_000);
    assert.equal(Number(stored?.device_time), 9000);
    assert.equal(stored?.clock.samples, 1);
    value = {
      sampleId: 'two',
      deviceTime: 8000,
      powerDeliveryState: 'PLUGGED_IN:CHARGING',
      observedGeneration: 7,
    };
    assert.equal(
      await edge.ingest(instant(21_000)),
      true,
      'out-of-order capture is left to the core watermark',
    );
    value = { sampleId: 'bad', deviceTime: 'server-clock', observedGeneration: '7' };
    assert.equal(await edge.ingest(instant(22_000)), false);
    const [count] = await rows<{ n: string }>(
      db,
      'select count(*)::text as n from inbox where processed_at is not null',
    );
    assert.equal(count?.n, '2');
  } finally {
    if (server.listening)
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await db.end();
    await pg.stop();
  }
});
