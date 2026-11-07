/// <reference lib="dom" />
/**
 * All four layers, through their real processes. The test is the device
 * application: it reports controlled measurements, never claims real hardware.
 * Kanto owns the local twin; Hono owns transport; Ditto owns cloud state; the
 * existing Postgres-backed reconciler alone decides what the evidence proves.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { connectAsync } from 'mqtt';
import { ADMIN, DEVICE } from '../../src/edge/provision.ts';

const api = process.env['HONO_RECONCILER_URL'] ?? 'http://localhost:9920';
const ditto = process.env['DITTO_URL'] ?? 'http://localhost:8080';
const headers = { 'content-type': 'application/json', 'x-ditto-pre-authenticated': ADMIN };

async function until(check: () => Promise<boolean>, why: string) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(250);
  }
  assert.fail(why);
}

async function device() {
  const response = await fetch(`${api}/v1/devices`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    devices: Array<{ deviceId: string; phase: string; view: { confidence: string } }>;
  };
  return body.devices.find((d) => d.deviceId === DEVICE);
}

async function intent(charging: boolean) {
  const res = await fetch(`${api}/v1/devices/${encodeURIComponent(DEVICE)}/intent`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ charging }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(res.status, 200);
}

test(
  'Kanto twin synchronizes over Hono; durable reconciler waits for generation evidence',
  {
    skip: process.env['KANTO_TEST'] !== '1',
    timeout: 120_000,
  },
  async () => {
    const local = await connectAsync(process.env['KANTO_MQTT_URL'] ?? 'mqtt://localhost:1884', {
      reconnectPeriod: 0,
      connectTimeout: 5_000,
    });
    const messages: Array<Record<string, unknown>> = [];
    local.on('message', (_topic, body) =>
      messages.push(JSON.parse(body.toString()) as Record<string, unknown>),
    );
    await local.subscribeAsync('command///req/#', { qos: 1 });

    async function command(action: string, path: string, value?: unknown) {
      const id = randomUUID();
      await local.publishAsync(
        'e',
        JSON.stringify({
          topic: `energy/edge-0001/things/twin/commands/${action}`,
          headers: { 'correlation-id': id, 'response-required': true },
          path,
          ...(value === undefined ? {} : { value }),
        }),
        { qos: 1 },
      );
      return id;
    }
    async function localValue(path: string): Promise<Record<string, unknown>> {
      const id = await command('retrieve', path);
      let result: Record<string, unknown> | undefined;
      await until(async () => {
        result = messages.find(
          (m) =>
            (m['headers'] as Record<string, unknown> | undefined)?.['correlation-id'] === id &&
            m['status'] === 200,
        );
        return result !== undefined;
      }, 'Kanto must answer from its local twin');
      return result!['value'] as Record<string, unknown>;
    }

    // Deliberately far from the server clock. Generation evidence must still work.
    let deviceTime = Date.now() + 600_000;
    async function report(charging: boolean, observedGeneration: number | null) {
      const sampleId = randomUUID();
      await command('modify', '/features/charging/properties', {
        sampleId,
        deviceTime: ++deviceTime,
        powerDeliveryState: charging ? 'PLUGGED_IN:CHARGING' : 'PLUGGED_IN:STOPPED',
        observedGeneration,
      });
      await until(async () => {
        const res = await fetch(`${ditto}/api/2/things/${DEVICE}/features/charging/properties`, {
          headers,
          signal: AbortSignal.timeout(5_000),
        });
        return res.ok && ((await res.json()) as Record<string, unknown>)['sampleId'] === sampleId;
      }, 'Kanto reported properties must reach Ditto through Hono');
      return sampleId;
    }
    try {
      await until(async () => (await device()) !== undefined, 'edge fleet registered');
      await intent(false);
      // Device applications register their features in Kanto before updating
      // individual properties; a cloud-only feature does not create local state.
      await command('modify', '/features/charging', {
        properties: {
          sampleId: randomUUID(),
          deviceTime: ++deviceTime,
          powerDeliveryState: 'PLUGGED_IN:STOPPED',
          observedGeneration: null,
        },
        desiredProperties: { charging: false },
      });
      await until(async () => {
        const previous = await fetch(`${ditto}/api/2/things/${DEVICE}/features/charging/desiredProperties`, {
          headers,
          signal: AbortSignal.timeout(5_000),
        });
        const value = (await previous.json()) as Record<string, unknown>;
        await report(false, typeof value['generation'] === 'number' ? value['generation'] : 0);
        return (await device())?.phase === 'CONVERGED';
      }, 'baseline stopped state');
      await intent(true);
      await report(false, null);
      await until(async () => (await device())?.phase === 'ISSUED', 'durable command issued');
      let desired: Record<string, unknown> = {};
      await until(async () => {
        const message = messages.find(
          (m) =>
            m['path'] === '/features/charging/desiredProperties' &&
            String(m['topic']).endsWith('/events/modified') &&
            (m['value'] as Record<string, unknown>)?.['charging'] === true &&
            Number.isSafeInteger((m['value'] as Record<string, unknown>)?.['generation']),
        );
        if (message !== undefined) desired = message['value'] as Record<string, unknown>;
        return message !== undefined;
      }, 'outbox command must reach the Kanto local bus');
      // Kanto 1.0 forwards live desired events to applications. Its built-in
      // persisted desired-state synchronization runs when the hub reconnects.
      await promisify(execFile)(
        'docker',
        [
          'compose',
          '-f',
          'compose.yaml',
          '-f',
          'compose.hono.yaml',
          '--profile',
          'edge',
          'restart',
          'kanto-edge',
        ],
        { timeout: 30_000 },
      );
      await until(async () => {
        const stored = await localValue('/features/charging/desiredProperties');
        return stored['generation'] === desired['generation'];
      }, 'Kanto must synchronize persisted desired state after reconnect');
      assert.equal((await device())?.phase, 'ISSUED', 'syncing desired state is not actuation');
      assert.equal(
        (await localValue('/features/charging/properties'))['powerDeliveryState'],
        'PLUGGED_IN:STOPPED',
      );

      const readout = async () => {
        const response = await fetch(`${api}/readout`, { signal: AbortSignal.timeout(5_000) });
        assert.equal(response.status, 200);
        return (await response.json()) as { correlation: { overall: { unknown: number } } };
      };
      const beforeUnknown = (await readout()).correlation.overall.unknown;
      const ambiguous = await report(true, null);
      await until(
        async () => (await readout()).correlation.overall.unknown > beforeUnknown,
        'reconciler must record unknown correlation for the counterless capture',
      );
      assert.equal(
        (await device())?.phase,
        'ISSUED',
        `matching sample ${ambiguous} without a counter is ambiguous`,
      );
      assert.notEqual((await device())?.view.confidence, 'confirmed-exact');
      await report(true, Number(desired['generation']));
      await until(
        async () => (await device())?.view.confidence === 'confirmed-exact',
        'device-echoed generation confirms exactly despite clock skew',
      );
      assert.equal((await device())?.phase, 'CONVERGED');
    } finally {
      await local.endAsync();
    }
  },
);
