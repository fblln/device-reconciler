/// <reference lib="dom" />
// MQTT.js publishes browser worker types alongside its Node client types.
/** Real MQTT -> Hono -> Kafka -> Ditto and return-path checks; opt-in stack. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { connectAsync } from 'mqtt';
import { ADMIN, DEVICE, provision } from '../../src/edge/provision.ts';

const enabled = process.env['HONO_TEST'] === '1';
const ditto = process.env['DITTO_URL'] ?? 'http://localhost:8080';
const mqtt = process.env['HONO_MQTT_URL'] ?? 'mqtt://localhost:1883';
const headers = { 'x-ditto-pre-authenticated': ADMIN, 'content-type': 'application/json' };

async function eventually(check: () => Promise<boolean>, description: string): Promise<void> {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(250);
  }
  assert.fail(`Timed out: ${description}`);
}

async function properties(device = DEVICE): Promise<Record<string, unknown>> {
  const response = await fetch(`${ditto}/api/2/things/${device}/features/charging/properties`, {
    headers,
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>;
}

// This uses a dedicated device session; do not run concurrently with Kanto's
// session for the same identity. hono:test starts before hono:edge.
test(
  'Hono authenticates, isolates twins, persists telemetry and returns commands',
  { skip: !enabled, timeout: 120_000 },
  async () => {
    await provision();
    await assert.rejects(
      connectAsync(mqtt, {
        username: 'edge_0001@energy',
        password: 'wrong',
        reconnectPeriod: 0,
        connectTimeout: 5_000,
      }),
    );
    const client = await connectAsync(mqtt, {
      username: 'edge_0001@energy',
      password: 'secret',
      reconnectPeriod: 0,
      connectTimeout: 10_000,
    });
    try {
      const messages: Array<{ topic: string; payload: Record<string, unknown> }> = [];
      client.on('message', (topic, payload) => {
        messages.push({ topic, payload: JSON.parse(payload.toString()) as Record<string, unknown> });
      });
      await client.subscribeAsync('command///req/#', { qos: 1 });
      const marker = randomUUID();
      await client.publishAsync(
        'e',
        JSON.stringify({
          topic: 'energy/edge-0001/things/twin/commands/modify',
          headers: {
            'content-type': 'application/vnd.eclipse.ditto+json',
            'correlation-id': marker,
            'response-required': false,
          },
          path: '/features/charging/properties',
          value: { charging: true, marker },
        }),
        { qos: 1 },
      );
      await eventually(
        async () => (await properties())['marker'] === marker,
        'reported state persisted in Ditto',
      );

      // Provisioning twice must not reset the reported state of a live device.
      await provision();
      assert.equal((await properties())['marker'], marker);

      const desired = randomUUID();
      const response = await fetch(`${ditto}/api/2/things/${DEVICE}/features/charging/desiredProperties`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ charging: false, marker: desired }),
        signal: AbortSignal.timeout(10_000),
      });
      assert.ok(response.ok, await response.text());
      await eventually(
        async () =>
          messages.some(({ payload }) => {
            const value = payload['value'] as Record<string, unknown> | undefined;
            return (
              payload['path'] === '/features/charging/desiredProperties' && value?.['marker'] === desired
            );
          }),
        'desired state returned over Hono command channel',
      );
      assert.equal((await properties())['charging'], true, 'delivery must not manufacture actuation');

      // Use the same policy intentionally: policy authorization alone would allow
      // this write. The authenticated Hono device_id must reject the forged topic.
      const victim = 'energy:edge-other';
      const created = await fetch(`${ditto}/api/2/things/${victim}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          policyId: DEVICE,
          features: { charging: { properties: { marker: 'unchanged' } } },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      assert.ok(created.ok, await created.text());
      try {
        await client.publishAsync(
          'e',
          JSON.stringify({
            topic: 'energy/edge-other/things/twin/commands/modify',
            headers: { 'correlation-id': 'forged', 'response-required': true },
            path: '/features/charging/properties',
            value: { marker: 'forged' },
          }),
          { qos: 1 },
        );
        const barrier = randomUUID();
        await client.publishAsync(
          'e',
          JSON.stringify({
            topic: 'energy/edge-0001/things/twin/commands/modify',
            headers: { 'response-required': false },
            path: '/features/charging/properties/marker',
            value: barrier,
          }),
          { qos: 1 },
        );
        await eventually(
          async () => (await properties())['marker'] === barrier,
          'valid event following forged event processed',
        );
        assert.equal((await properties(victim))['marker'], 'unchanged');
      } finally {
        await fetch(`${ditto}/api/2/things/${victim}`, {
          method: 'DELETE',
          headers,
          signal: AbortSignal.timeout(10_000),
        });
      }
    } finally {
      await client.endAsync();
    }
  },
);
