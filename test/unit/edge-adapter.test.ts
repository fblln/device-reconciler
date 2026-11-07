/** Evidence validation and transport outcomes at the Hono adapter boundary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createEdgeAdapter, parseSample } from '../../src/edge/adapter.ts';
import { generation } from '../../src/core/correlate.ts';
import type { Db } from '../../src/store/db.ts';
import { DEVICE } from '../../src/edge/provision.ts';

const sample = {
  sampleId: 'capture-1',
  deviceTime: 123,
  powerDeliveryState: 'PLUGGED_IN:STOPPED',
  observedGeneration: null,
};

test('edge evidence requires a capture identity, device time, state and explicit generation availability', () => {
  assert.deepEqual(parseSample(sample), sample);
  assert.equal(parseSample({ ...sample, observedGeneration: 0 })?.observedGeneration, 0);
  for (const value of [
    null,
    false,
    [],
    {},
    { ...sample, sampleId: '' },
    { ...sample, sampleId: 'x'.repeat(201) },
    { ...sample, deviceTime: NaN },
    { ...sample, deviceTime: 1.2 },
    { ...sample, powerDeliveryState: 'APPLIED' },
    { ...sample, observedGeneration: undefined },
    { ...sample, observedGeneration: -1 },
    { ...sample, observedGeneration: '2' },
    { ...sample, observedGeneration: 1.5 },
  ])
    assert.equal(parseSample(value), null);
});

test('outbox transport preserves command identity and never reports APPLIED', async () => {
  const requests: unknown[] = [];
  let status = 204;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    requests.push({ method: req.method, path: req.url, body: JSON.parse(body) as unknown });
    res.writeHead(status, status === 429 ? { 'retry-after': '2' } : {});
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // These methods never use the database; fail if a future change does.
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error('unexpected database access');
      },
    },
  ) as Db;
  const { client } = createEdgeAdapter(db, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const command = { commandId: 'edge-command/7', generation: generation(7), target: true };
  try {
    assert.deepEqual(await client.listDevices(), { ok: true, value: [{ deviceId: DEVICE, vendor: 'hono' }] });
    assert.deepEqual(await client.sendCommand(DEVICE, command), { ok: true, value: 'PENDING' });
    assert.deepEqual(await client.sendCommand(DEVICE, command), { ok: true, value: 'PENDING' });
    assert.deepEqual(requests[0], requests[1], 'redelivery must preserve the same generation and command ID');
    assert.deepEqual(requests[0], {
      method: 'PUT',
      path: `/api/2/things/${DEVICE}/features/charging/desiredProperties`,
      body: { charging: true, generation: 7, commandId: 'edge-command/7' },
    });
    status = 429;
    assert.deepEqual(await client.sendCommand(DEVICE, command), {
      ok: false,
      kind: 'rate-limited',
      retryAfter: 2000,
    });
    status = 503;
    const unavailable = await client.sendCommand(DEVICE, command);
    assert.ok(!unavailable.ok && unavailable.kind === 'unavailable');
    status = 403;
    const rejected = await client.sendCommand(DEVICE, command);
    assert.ok(!rejected.ok && rejected.kind === 'rejected');
    const unknown = await client.sendCommand('other', command);
    assert.ok(!unknown.ok && unknown.kind === 'rejected' && unknown.status === 404);
    assert.equal((await client.fetchReport(command.commandId)).ok, false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  const disconnected = await client.sendCommand(DEVICE, command);
  assert.ok(!disconnected.ok && disconnected.kind === 'unavailable');
});
