/**
 * The real edge adapter: commands become desired properties and observations
 * come from device-owned reported properties. Neither a Ditto write receipt,
 * a Hono MQTT PUBACK, nor Kanto synchronizing desired state proves actuation.
 *
 * This lab polls the persisted twin. A stable sampleId prevents polling cached
 * state from refreshing liveness or adding clock samples. Capture time remains
 * on the device clock. Polling can miss intermediate observations; a durable
 * Kafka consumer is the fleet-scale upgrade, not timestamp normalization.
 */
import type { PlatformClient } from '../adapter/client.ts';
import { duration, deviceInstant, instant, type Instant } from '../core/time.ts';
import { parseRetryAfter } from '../core/ratelimit.ts';
import type { PowerDeliveryState } from '../core/reconcile.ts';
import type { Db } from '../store/db.ts';
import { tx } from '../store/db.ts';
import { accept, markProcessed } from '../store/inbox.ts';
import { recordTelemetry } from '../store/channels.ts';
import { isManaged, wake } from '../store/devices.ts';
import { foldClock } from '../service/ingest.ts';
import type { Projector } from '../twin/project.ts';
import { ADMIN, DEVICE } from './provision.ts';

export type EdgeSample = Readonly<{
  sampleId: string;
  deviceTime: number;
  powerDeliveryState: PowerDeliveryState;
  observedGeneration: number | null;
}>;

/** Reject malformed evidence before it can enter the operational store. */
export function parseSample(value: unknown): EdgeSample | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v['sampleId'] !== 'string' ||
    v['sampleId'].length === 0 ||
    v['sampleId'].length > 200 ||
    !Number.isSafeInteger(v['deviceTime']) ||
    !['PLUGGED_IN:CHARGING', 'PLUGGED_IN:STOPPED', 'UNPLUGGED'].includes(String(v['powerDeliveryState'])) ||
    !(
      v['observedGeneration'] === null ||
      (Number.isSafeInteger(v['observedGeneration']) && Number(v['observedGeneration']) >= 0)
    )
  )
    return null;
  return v as EdgeSample;
}

export function createEdgeAdapter(db: Db, baseUrl: string) {
  const headers = { 'x-ditto-pre-authenticated': ADMIN, 'content-type': 'application/json' };
  const path = `/api/2/things/${DEVICE}/features/charging`;
  const request = (suffix: string, method = 'GET', body?: unknown) =>
    fetch(`${baseUrl}${path}${suffix}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
  const client: PlatformClient = {
    listDevices: async () => ({ ok: true, value: [{ deviceId: DEVICE, vendor: 'hono' }] }),
    async sendCommand(deviceId, command) {
      if (deviceId !== DEVICE)
        return { ok: false, kind: 'rejected', status: 404, detail: 'unknown edge device' };
      try {
        // Replacement is idempotent state assignment. The same commandId and
        // generation survive outbox redelivery; the device must dedupe side
        // effects by that identity, never by Ditto's unrelated revision.
        const res = await request('/desiredProperties', 'PUT', {
          charging: command.target,
          generation: command.generation,
          commandId: command.commandId,
        });
        if (res.status === 429)
          return {
            ok: false,
            kind: 'rate-limited',
            retryAfter: parseRetryAfter(res.headers.get('retry-after'), instant(Date.now()), duration(5_000)),
          };
        if (res.status >= 500) return { ok: false, kind: 'unavailable', detail: `Ditto ${res.status}` };
        if (!res.ok) return { ok: false, kind: 'rejected', status: res.status, detail: await res.text() };
        // Accepted by the transport only. No command_report is invented here.
        return { ok: true, value: 'PENDING' };
      } catch (error) {
        return { ok: false, kind: 'unavailable', detail: String(error) };
      }
    },
    fetchReport: async () => ({
      ok: false,
      kind: 'rejected',
      status: 404,
      detail: 'no device command report',
    }),
  };
  const twin: Projector = {
    enabled: false,
    // Provisioning owns the device policy and initial twin. Never replace it
    // from a fleet sweep or project inferred state over device-owned evidence.
    ensure: async () => {},
    publish: async () => {},
  };
  return {
    client,
    twin,
    async ingest(receivedAt?: Instant): Promise<boolean> {
      const res = await request('/properties');
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`Reading Hono twin: ${res.status}`);
      const sample = parseSample(await res.json());
      if (sample === null) return false;
      const now = receivedAt ?? instant(Date.now());
      return tx(db, async (q) => {
        if (!(await isManaged(q, DEVICE))) return false;
        const eventId = `hono:${DEVICE}:${sample.sampleId}`;
        if (
          !(await accept(q, {
            eventId,
            deviceId: DEVICE,
            kind: 'telemetry',
            payload: sample,
            // This legacy inbox column is arrival time here, not a claimed HMAC.
            // Authentication happened at Hono and identity enforcement at Ditto.
            signedAt: now,
            receivedAt: now,
          }))
        )
          return false;
        await recordTelemetry(q, {
          deviceId: DEVICE,
          isReachable: true,
          deviceTime: deviceInstant(sample.deviceTime),
          receivedAt: now,
          powerDeliveryState: sample.powerDeliveryState,
          observedGeneration: sample.observedGeneration,
        });
        await foldClock(q, DEVICE, now, sample.deviceTime);
        await wake(q, DEVICE, now);
        await markProcessed(q, eventId, now);
        return true;
      });
    },
  };
}
