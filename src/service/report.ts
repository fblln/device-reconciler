/**
 * report.ts — assembles the readout that is this repository's deliverable.
 *
 * The two headline numbers come from src/core/readout.ts, which is pure and
 * tested; this adds the operational context that makes them actionable rather
 * than merely interesting:
 *
 *   outbox      pending / dispatched / abandoned. A high unknown-correlation
 *               rate means something very different when commands are also
 *               piling up undelivered: in that case the problem is the
 *               dispatcher, not the clocks.
 *   gates       breaker state and remaining tokens per vendor. The reason a
 *               vendor's devices stopped converging is usually here.
 *   phases      the live phase census from the device table, as opposed to the
 *               decision log's history. A fleet reporting healthy rates while
 *               every device sits in FAILED is a fleet that is not working.
 */

import { render, summarise, type Readout } from '../core/readout.ts';
import type { Db } from '../store/db.ts';
import { rollup } from '../store/decisions.ts';
import { countAccepted } from '../store/inbox.ts';
import { stats as outboxStats, type OutboxStats } from '../store/outbox.ts';
import { countByPhase } from '../store/devices.ts';
import type { Gate } from '../adapter/gate.ts';

export type FullReport = Readonly<{
  correlation: Readout;
  outbox: OutboxStats;
  eventsAccepted: number;
  devicesByPhase: Record<string, number>;
  vendors: ReturnType<Gate['snapshot']>;
}>;

export async function buildReport(db: Db, gate: Gate): Promise<FullReport> {
  // Independent reads, so they go out together: a readout that takes five
  // sequential round trips is a readout nobody scrapes often enough to notice a
  // problem with.
  const [decisions, outbox, eventsAccepted, devicesByPhase] = await Promise.all([
    rollup(db),
    outboxStats(db),
    countAccepted(db),
    countByPhase(db),
  ]);
  return {
    correlation: summarise(decisions),
    outbox,
    eventsAccepted,
    devicesByPhase,
    vendors: gate.snapshot(),
  };
}

export function renderReport(r: FullReport): string {
  const vendors = Object.entries(r.vendors)
    .toSorted()
    .map(([name, s]) => `${name}=${s.breaker}/${s.tokens}t`)
    .join('  ');
  return [
    render(r.correlation),
    '',
    `devices        ${
      Object.entries(r.devicesByPhase)
        .map(([p, n]) => `${p} ${n}`)
        .join('  ') || '(none)'
    }`,
    `outbox         pending ${r.outbox.pending}  dispatched ${r.outbox.dispatched}  abandoned ${r.outbox.abandoned}`,
    `events         ${r.eventsAccepted} accepted (duplicates rejected by the inbox unique index)`,
    `vendors        ${vendors || '(no traffic yet)'}`,
  ].join('\n');
}
