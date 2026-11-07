/**
 * decisions.ts — the audit log, and the rollup the readout is built from.
 *
 * THIS IS A DELIVERABLE, NOT A DEBUG LOG
 * --------------------------------------
 * The design's central claim is that correlating a telemetry snapshot with a
 * command crosses two clocks, so the answer is tri-state, and that a generation
 * echo beats a clock estimate wherever a device offers one. That is an argument
 * until a running system can say how often each branch actually fired. These
 * rows are that measurement; src/core/readout.ts turns them into the two rates
 * that matter.
 *
 * WHY A GROUP BY AND NOT A STREAM OF ROWS
 * ---------------------------------------
 * The rollup is computed in the database and the readout aggregates the grouped
 * counts, so a scrape costs one indexed aggregate rather than a full scan of
 * every decision ever made. A readout that has to stream the audit log to
 * compute a percentage stops working at exactly the fleet size where the
 * percentage starts to matter.
 *
 * ponytail: append-only, no retention policy. One row per decision per device
 * per wake, which at a 30-second sweep is ~3k rows per device per day — fine for
 * a demo, not for a year. The upgrade path is a daily rollup table and a drop of
 * the detail, and the aggregate query above is already shaped for it.
 */

import type { Correlation, CorrelationSource } from '../core/correlate.ts';
import type { PhaseName, Step } from '../core/reconcile.ts';
import type { DecisionRow } from '../core/readout.ts';
import type { Instant } from '../core/time.ts';
import { rows, type Queryable } from './db.ts';

export async function record(
  q: Queryable,
  deviceId: string,
  vendor: string,
  at: Instant,
  step: Step,
): Promise<void> {
  await q.query(
    `insert into decision (device_id, vendor, at, phase, correlation, source, reason)
       values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      deviceId,
      vendor,
      at,
      step.state.phase,
      step.correlation?.correlation ?? null,
      step.correlation?.source ?? null,
      step.why,
    ],
  );
}

export async function rollup(q: Queryable): Promise<DecisionRow[]> {
  const result = await rows<{
    vendor: string;
    phase: string;
    correlation: string | null;
    source: string | null;
    n: string;
  }>(
    q,
    `select vendor, phase, correlation, source, count(*)::text as n
       from decision group by 1, 2, 3, 4`,
  );
  return result.map((r) => ({
    vendor: r.vendor,
    phase: r.phase as PhaseName,
    correlation: r.correlation as Correlation | null,
    source: r.source as CorrelationSource | null,
    count: Number(r.n),
  }));
}

/** The most recent decisions, newest first — what an operator reads to debug one device. */
export async function recent(
  q: Queryable,
  limit: number,
): Promise<Array<Readonly<{ deviceId: string; at: number; phase: string; why: string }>>> {
  const result = await rows<{ device_id: string; at: string; phase: string; reason: string }>(
    q,
    `select device_id, at, phase, reason from decision order by id desc limit $1`,
    [limit],
  );
  return result.map((r) => ({
    deviceId: r.device_id,
    at: Number(r.at),
    phase: r.phase,
    why: r.reason,
  }));
}
