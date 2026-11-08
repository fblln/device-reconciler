/**
 * devices.ts — durable device state, and the work claim.
 *
 * WHAT IS DURABLE AND WHY EACH PIECE HAS TO BE
 * --------------------------------------------
 *   phase        holds the in-flight command: its id, its generation, its
 *                deadline and the device-clock watermark. This is the single
 *                thing whose loss causes the failure the design exists to
 *                prevent — a restart that re-issues an outstanding command.
 *   clock        the minimum cross-clock delay sample, monotonically improving.
 *                Losing it is not a correctness bug but it is a real cost: the
 *                reconciler goes blind on every restart and answers `unknown`
 *                until a fresh sample arrives, which on a two-minute telemetry
 *                feed is minutes of degraded decisions per deploy.
 *   generation   a counter handed out twice makes a device's echo ambiguous,
 *                which is the one thing the counter exists to prevent
 *                (contract I8). It therefore cannot live in a process.
 *   wake_at      the durable timer. See src/core/schedule.ts.
 *
 * THE PARSE BOUNDARY
 * ------------------
 * `phase` and `clock` are jsonb, so they arrive as `unknown` and are cast once,
 * here, with the reasoning stated — rather than being `as`-cast at twenty call
 * sites. This is a trust boundary of a particular kind: the data was written by
 * an earlier version of THIS program, not by a stranger, so the risk is schema
 * drift across a deploy and not an attack. ponytail: a cast plus a shape check
 * on the discriminant, which is the field every variant depends on. Skipped a
 * schema validator; add one when the phase union is versioned across a rolling
 * deploy, where an old process really can read a new process's rows.
 *
 * BIGINT ARRIVES AS A STRING
 * --------------------------
 * node-postgres returns bigint as a string, because a 64-bit integer does not
 * fit in a JS number and silently rounding one is worse than making the caller
 * look. Every domain timestamp here is milliseconds since the epoch, which is
 * well inside Number.MAX_SAFE_INTEGER until the year 287396, so Number() is
 * exact for these columns and the conversion is explicit at every read.
 */

import type { ClockModel } from '../core/clock.ts';
import { generation as asGeneration, type Generation } from '../core/correlate.ts';
import type { CommandReport, Observation, Phase, PowerDeliveryState } from '../core/reconcile.ts';
import type { IntentSource, StoredIntent } from '../core/override.ts';
import { deviceInstant, instant, type Instant } from '../core/time.ts';
import type { Policy } from '../core/presentation.ts';
import { rows, type Queryable } from './db.ts';

export type DeviceWork = Readonly<{
  deviceId: string;
  vendor: string;
  /** Desired state WITH its provenance, because precedence needs the source. */
  stored: StoredIntent;
  /** When a third party was last seen to move this device. See core/override.ts. */
  localChangeAt: Instant | null;
  phase: Phase;
  clock: ClockModel;
  /** The highest generation already handed out for this device. */
  generation: Generation;
  /** Monotonic per-device counter behind the command id. */
  commandSeq: number;
  activeOperationId: string | null;
  obs: Observation;
  report: CommandReport | null;
}>;

type Row = {
  device_id: string;
  vendor: string;
  intent_charging: boolean;
  intent_source: string;
  intent_set_at: string;
  local_change_at: string | null;
  phase: unknown;
  clock: unknown;
  generation: string;
  command_seq: string;
  active_operation_id: string | null;
  is_reachable: boolean | null;
  device_time: string | null;
  received_at: string | null;
  power_delivery_state: string | null;
  observed_generation: string | null;
  report_command_id: string | null;
  report_state: string | null;
  report_at: string | null;
};

const PHASES = new Set(['IDLE', 'CONVERGED', 'ISSUED', 'SUSPENDED', 'FAILED']);

function parsePhase(value: unknown, deviceId: string): Phase {
  // Only the discriminant is checked. Every field the decision function reads
  // hangs off it, so a row with a known phase name and a missing field is a bug
  // in this program's own writer, which a validator would catch no earlier than
  // the first test run does.
  if (typeof value !== 'object' || value === null || !('phase' in value)) {
    throw new Error(`device ${deviceId}: stored phase is not a phase object`);
  }
  const name = (value as { phase: unknown }).phase;
  if (typeof name !== 'string' || !PHASES.has(name)) {
    throw new Error(`device ${deviceId}: unknown stored phase ${JSON.stringify(name)}`);
  }
  return value as Phase;
}

function parseClock(value: unknown, deviceId: string): ClockModel {
  if (typeof value !== 'object' || value === null || !('samples' in value)) {
    throw new Error(`device ${deviceId}: stored clock model is malformed`);
  }
  return value as ClockModel;
}

/**
 * A device with no telemetry row yet. Modelled as UNREACHABLE rather than as
 * "plugged in and idle", because that is the truth: we have heard nothing from
 * it. The decision function refuses to issue a command while telemetry is dark,
 * which is exactly the behaviour wanted for a device that has just been
 * registered and has never reported — guessing a state and acting on it is how
 * a reconciler commands a device it has never seen.
 */
function observationFrom(row: Row, now: Instant): Observation {
  if (row.device_time === null || row.received_at === null || row.power_delivery_state === null) {
    return {
      deviceId: row.device_id,
      isReachable: false,
      deviceTime: deviceInstant(now),
      receivedAt: now,
      powerDeliveryState: 'UNPLUGGED',
      observedGeneration: null,
    };
  }
  return {
    deviceId: row.device_id,
    isReachable: row.is_reachable === true,
    deviceTime: deviceInstant(Number(row.device_time)),
    receivedAt: instant(Number(row.received_at)),
    powerDeliveryState: row.power_delivery_state as PowerDeliveryState,
    observedGeneration:
      row.observed_generation === null ? null : asGeneration(Number(row.observed_generation)),
  };
}

function reportFrom(row: Row): CommandReport | null {
  if (row.report_command_id === null || row.report_state === null || row.report_at === null) return null;
  return {
    commandId: row.report_command_id,
    state: row.report_state as CommandReport['state'],
    at: instant(Number(row.report_at)),
  };
}

/**
 * Claim up to `limit` devices that are due, and lease them.
 *
 * `for update skip locked` is the whole work-distribution mechanism: no broker,
 * no partition assignment, no leader election. N identical reconciler processes
 * run the same statement and each gets a disjoint batch, because a row another
 * transaction has locked is skipped rather than waited for. This is the standard
 * Postgres queue pattern and it is the right amount of machinery for a fleet
 * this size.
 *
 * The LEASE is separate from the row lock and outlives the transaction. The lock
 * is released at commit, a few milliseconds later; the work of talking to a
 * vendor cloud takes seconds. Without a lease, a second worker would claim the
 * same device the instant the first one committed its claim, and both would
 * reconcile it. A lease that EXPIRES rather than a flag that is cleared, because
 * a worker killed mid-reconcile cannot clear anything — and a device whose flag
 * is stuck set stops reconciling silently, which is the worst failure shape
 * available.
 *
 * ponytail: the lease is a timestamp, so a worker paused longer than the lease
 * can still commit a decision for a device someone else now owns — last writer
 * wins. That is tolerable here because a decision is derived from stored
 * observations and is idempotent in the outbox (same generation, same command
 * id), so the duplicate is deduplicated downstream. Fencing tokens are the
 * upgrade path if a decision ever becomes non-idempotent.
 */
export async function claim(
  q: Queryable,
  now: Instant,
  limit: number,
  leaseMs: number,
): Promise<DeviceWork[]> {
  const result = await rows<Row>(
    q,
    `with due as (
       select device_id from device
        where wake_at <= $1 and (leased_until is null or leased_until < $1)
        order by wake_at
        limit $2
        for update skip locked
     ), leased as (
       update device d set leased_until = $1 + $3
         from due where d.device_id = due.device_id
       returning d.*
     )
     select l.device_id, l.vendor, l.intent_charging, l.intent_source, l.intent_set_at,
            l.active_operation_id, l.local_change_at, l.phase, l.clock, l.generation, l.command_seq,
            o.is_reachable, o.device_time, o.received_at, o.power_delivery_state, o.observed_generation,
            r.command_id as report_command_id, r.state as report_state, r.at as report_at
       from leased l
       left join observation o on o.device_id = l.device_id
       left join command_report r on r.device_id = l.device_id`,
    [now, limit, leaseMs],
  );

  return result.map((row) => ({
    deviceId: row.device_id,
    vendor: row.vendor,
    stored: {
      charging: row.intent_charging,
      source: row.intent_source as IntentSource,
      setAt: instant(Number(row.intent_set_at)),
    },
    localChangeAt: row.local_change_at === null ? null : instant(Number(row.local_change_at)),
    phase: parsePhase(row.phase, row.device_id),
    clock: parseClock(row.clock, row.device_id),
    generation: asGeneration(Number(row.generation)),
    commandSeq: Number(row.command_seq),
    activeOperationId: row.active_operation_id,
    obs: observationFrom(row, now),
    report: reportFrom(row),
  }));
}

export type Persisted = Readonly<{
  phase: Phase;
  clock: ClockModel;
  generation: Generation;
  commandSeq: number;
  wakeAt: Instant;
  /** Null clears it: the override has lapsed or we have re-asserted past it. */
  localChangeAt: Instant | null;
  /** The decision's reason, kept on the row so the view model has a fault to show. */
  why: string;
}>;

/**
 * Write the decision back and release the lease. Called inside the same
 * transaction as the outbox insert — that single atomic write is what makes a
 * restart safe, and splitting it is the bug this file is designed around.
 */
export async function persist(q: Queryable, deviceId: string, next: Persisted): Promise<void> {
  await q.query(
    `update device
        set phase = $2, clock = $3, generation = $4, command_seq = $5,
            wake_at = $6, local_change_at = $7, last_why = $8,
            leased_until = null, updated_at_wall = now()
      where device_id = $1`,
    [
      deviceId,
      JSON.stringify(next.phase),
      JSON.stringify(next.clock),
      next.generation,
      next.commandSeq,
      next.wakeAt,
      next.localChangeAt,
      next.why,
    ],
  );
}

/**
 * Register a device, or leave it alone if it is already known.
 *
 * `on conflict do nothing` rather than an upsert, because re-running the device
 * sync must never reset a phase. An upsert here would wipe an in-flight
 * command's deadline every time the fleet was re-listed, which is the same
 * failure as losing the phase to a restart, just self-inflicted on a timer.
 */
export async function register(
  q: Queryable,
  deviceId: string,
  vendor: string,
  phase: Phase,
  clock: ClockModel,
  wakeAt: Instant,
): Promise<boolean> {
  const inserted = await rows<{ device_id: string }>(
    q,
    `insert into device (device_id, vendor, phase, clock, wake_at)
       values ($1, $2, $3, $4, $5)
       on conflict (device_id) do nothing
       returning device_id`,
    [deviceId, vendor, JSON.stringify(phase), JSON.stringify(clock), wakeAt],
  );
  return inserted.length === 1;
}

/**
 * Change desired state and wake the device at once.
 *
 * Pulling `wake_at` forward is the point: an intent change is the one event that
 * makes a terminally FAILED device interesting again, and leaving it on the
 * failed-interval sweep would mean a user flipping a switch waits minutes for
 * anything to happen. `least` so this never pushes a nearer deadline out.
 */
export async function setIntent(
  q: Queryable,
  deviceId: string,
  charging: boolean,
  source: IntentSource,
  now: Instant,
): Promise<void> {
  // Setting an intent also clears any local override. An explicit request is a
  // deliberate answer to the question the override was raising, so continuing to
  // hold against it would mean the operator's decision had no effect — which is
  // how people learn to distrust a control plane and start pulling breakers.
  await q.query(
    `update device set intent_charging = $2, intent_source = $3, intent_set_at = $4,
            local_change_at = null, wake_at = least(wake_at, $4)
      where device_id = $1`,
    [deviceId, charging, source, now],
  );
}

/**
 * Make a device due now because something arrived about it. The whole reason the
 * system is webhook-driven rather than poll-driven: a snapshot that lands two
 * seconds after a command should be acted on in two seconds, not at the next
 * sweep. The sweeper still exists for devices that have gone quiet, because a
 * purely event-driven reconciler never revisits the device that stopped talking
 * — which is the one most likely to have drifted.
 */
export async function wake(q: Queryable, deviceId: string, at: Instant): Promise<void> {
  await q.query(`update device set wake_at = least(wake_at, $2) where device_id = $1`, [deviceId, at]);
}

export async function countByPhase(q: Queryable): Promise<Record<string, number>> {
  const result = await rows<{ phase: string; n: string }>(
    q,
    `select phase->>'phase' as phase, count(*)::text as n from device group by 1`,
  );
  return Object.fromEntries(result.map((r) => [r.phase, Number(r.n)]));
}

/** Every managed device. The demo needs ids to set intents on. */
export async function listManaged(
  q: Queryable,
): Promise<Array<Readonly<{ deviceId: string; vendor: string }>>> {
  const result = await rows<{ device_id: string; vendor: string }>(
    q,
    `select device_id, vendor from device order by device_id`,
  );
  return result.map((r) => ({ deviceId: r.device_id, vendor: r.vendor }));
}

/**
 * Every device as a view model, for the API.
 *
 * WHY THIS QUERY AND NOT THE WORK CLAIM
 * -------------------------------------
 * `claim` leases rows; this must not. A UI polling the device list has no
 * business taking devices away from the reconciler, and a read that mutates a
 * lease is the kind of thing that only shows up as a device that mysteriously
 * stops converging while somebody has a dashboard open.
 *
 * It shares the joins with `claim` and nothing else, deliberately: the shapes
 * look alike but they answer different questions, and factoring them together
 * would mean one query serving both a control loop and a human, which is how a
 * dashboard ends up able to break reconciliation.
 */
export type DeviceViewRow = Readonly<{
  deviceId: string;
  vendor: string;
  stored: StoredIntent;
  phase: Phase;
  clock: ClockModel;
  obs: Observation;
  policy: Policy;
  lastWhy: string | null;
}>;

export async function viewRows(q: Queryable, now: Instant): Promise<DeviceViewRow[]> {
  const result = await rows<Row & { optimistic: boolean; last_why: string | null }>(
    q,
    `select d.device_id, d.vendor, d.intent_charging, d.intent_source, d.intent_set_at,
            d.active_operation_id, d.local_change_at, d.phase, d.clock, d.generation, d.command_seq,
            d.optimistic, d.last_why,
            o.is_reachable, o.device_time, o.received_at, o.power_delivery_state, o.observed_generation,
            r.command_id as report_command_id, r.state as report_state, r.at as report_at
       from device d
       left join observation o on o.device_id = d.device_id
       left join command_report r on r.device_id = d.device_id
       order by d.device_id`,
  );
  return result.map((row) => ({
    deviceId: row.device_id,
    vendor: row.vendor,
    stored: {
      charging: row.intent_charging,
      source: row.intent_source as IntentSource,
      setAt: instant(Number(row.intent_set_at)),
    },
    phase: parsePhase(row.phase, row.device_id),
    clock: parseClock(row.clock, row.device_id),
    obs: observationFrom(row, now),
    policy: { optimistic: row.optimistic },
    lastWhy: row.last_why,
  }));
}

/** Per-device display policy. The demo sets it to show both lies side by side. */
export async function setOptimistic(q: Queryable, deviceId: string, optimistic: boolean): Promise<void> {
  await q.query(`update device set optimistic = $2 where device_id = $1`, [deviceId, optimistic]);
}

/**
 * Do we manage this device?
 *
 * Needed because `observation` and `command_report` reference `device`, so an
 * event for an unknown device is a foreign-key violation rather than a no-op.
 * Checking first turns that into an ordinary branch the ingest handler can
 * answer 2xx to — see the note at its call site for why a 5xx there is the
 * worst available answer.
 */
export async function isManaged(q: Queryable, deviceId: string): Promise<boolean> {
  const found = await rows<{ device_id: string }>(q, `select device_id from device where device_id = $1`, [
    deviceId,
  ]);
  return found.length === 1;
}
