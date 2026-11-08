/**
 * channels.ts — the latest word from each of the two channels, kept apart.
 *
 * TWO TABLES, ON PURPOSE
 * ----------------------
 * A single `device_state` row holding both the last telemetry snapshot and the
 * last command acknowledgement would be the original sin of this domain in
 * storage form (see src/core/reconcile.ts). They are two channels with two
 * clocks, two latencies, two failure modes and two meanings: one says what the
 * device was doing at a past moment on ITS clock, the other says an instruction
 * was received, stamped on OURS. Merging them invites a `where device_time >
 * report_at` that no compiler would ever catch.
 *
 * WHY THE TELEMETRY WRITE HAS NO OUT-OF-ORDER GUARD
 * -------------------------------------------------
 * This holds the latest ARRIVED snapshot, not the latest captured one.
 * Snapshots genuinely arrive out of order, and discarding the older one here
 * would look like a tidy fix while actually hiding the pathology from the only
 * component equipped to handle it: the decision function keeps a device-clock
 * watermark precisely so it can recognise a stale capture itself, exactly, on
 * one clock, with no estimate involved. Fixing reordering at the storage layer
 * would mean the watermark is never exercised, and the bug would reappear the
 * first time anything bypassed this table.
 */

import { rows, type Queryable } from './db.ts';
import type { CommandReportState, PowerDeliveryState } from '../core/reconcile.ts';
import { sequenceOf } from '../core/identity.ts';
import type { DeviceInstant, Instant } from '../core/time.ts';

export async function recordTelemetry(
  q: Queryable,
  snapshot: Readonly<{
    deviceId: string;
    isReachable: boolean;
    deviceTime: DeviceInstant;
    receivedAt: Instant;
    powerDeliveryState: PowerDeliveryState;
    observedGeneration: number | null;
  }>,
): Promise<void> {
  await q.query(
    `insert into observation (device_id, is_reachable, device_time, received_at, power_delivery_state, observed_generation)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (device_id) do update set
         is_reachable = excluded.is_reachable,
         device_time = excluded.device_time,
         received_at = excluded.received_at,
         power_delivery_state = excluded.power_delivery_state,
         observed_generation = excluded.observed_generation`,
    [
      snapshot.deviceId,
      snapshot.isReachable,
      snapshot.deviceTime,
      snapshot.receivedAt,
      snapshot.powerDeliveryState,
      snapshot.observedGeneration,
    ],
  );
}

/**
 * The latest report for ANY command, which is what the decision function's
 * `report` field means — matching it to the command in flight is the pure
 * core's job, by id, because a late report from a superseded command is noise
 * and discarding it here would need the storage layer to know which command is
 * current. It does not, and it should not.
 */
export async function recordReport(
  q: Queryable,
  report: Readonly<{ deviceId: string; commandId: string; state: CommandReportState; at: Instant }>,
): Promise<void> {
  // -1 for an id we cannot read: it may still fill an empty row, and it can
  // never evict a real one.
  const sequence = sequenceOf(report.commandId) ?? -1;
  await q.query(
    `insert into command_report (device_id, command_id, state, at, command_seq)
       values ($1, $2, $3, $4, $5)
       on conflict (device_id) do update set
         command_id = excluded.command_id, state = excluded.state, at = excluded.at,
         command_seq = excluded.command_seq
       where (excluded.command_seq, excluded.at) >= (command_report.command_seq, command_report.at)`,
    [report.deviceId, report.commandId, report.state, report.at, sequence],
  );
}

/**
 * Mark the telemetry channel dark for devices nothing has been heard from in a
 * while. Without this, a device whose feed dies keeps its last snapshot forever
 * and the reconciler goes on treating a frozen reading as current — it would
 * never enter SUSPENDED, so it would happily issue commands blind, which is the
 * one thing the unreachable branch exists to stop. `received_at` is on OUR
 * clock, so this comparison is sound; comparing `device_time` here would not be.
 */
export async function markStaleUnreachable(q: Queryable, before: Instant): Promise<number> {
  const stale = await rows<{ device_id: string }>(
    q,
    `update observation set is_reachable = false
      where received_at < $1 and is_reachable
      returning device_id`,
    [before],
  );
  return stale.length;
}
