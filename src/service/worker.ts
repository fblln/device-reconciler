/**
 * worker.ts — one pass of the reconciliation loop.
 *
 * THE SHAPE, AND WHY IT IS THIS SHAPE
 * -----------------------------------
 *   1. CLAIM a batch of due devices, with a lease. Its own transaction, which
 *      must commit before any work starts — a claim that is still open is a
 *      claim no other worker can see, and the whole point is that they can.
 *   2. DECIDE, purely, per device. No I/O inside the decision. The clock model,
 *      the observation and the report all arrive as data.
 *   3. COMMIT the decision: new phase, intent to send, and the audit row, in
 *      ONE transaction. This is the atomic write the design is built around.
 *
 * Note what is NOT here: sending the command. Step 3 writes an outbox row and
 * stops. Dispatch is a separate drain, because deciding and sending cannot be
 * made atomic and pretending otherwise is how a restart duplicates an
 * actuation. See the long note in db/schema.sql.
 *
 * WHY THE CLOCK MODEL IS NOT UPDATED HERE
 * ---------------------------------------
 * It is folded at ingest (src/service/ingest.ts), once per deduplicated
 * snapshot. Doing it here would fold the SAME snapshot on every wake — the
 * minimum-delay estimate would survive that, since a repeated minimum is still
 * the minimum, but the sample count would become a count of wakes rather than a
 * count of snapshots, and the sample count is how an operator judges whether to
 * trust the estimate at all.
 *
 * WHY reconcileChecked AND NOT reconcile
 * --------------------------------------
 * The contracts (I1–I9) run on every decision in production, not only in tests.
 * They are O(1) and allocation-free, the perf budget covers the cost, and a
 * violated invariant here means the system is about to command a device on
 * reasoning it cannot justify — which is worth crashing over. A contract that
 * only runs in tests is a comment.
 */

import { reconcileChecked } from '../core/contracts.ts';
import { mint } from '../core/identity.ts';
import { nextWake, type ScheduleConfig } from '../core/schedule.ts';
import type { Bounds } from '../core/clock.ts';
import type { Duration, Instant } from '../core/time.ts';
import { tx, type Db } from '../store/db.ts';
import { claim, persist } from '../store/devices.ts';
import { enqueue } from '../store/outbox.ts';
import { record } from '../store/decisions.ts';
import { mapWithLimit } from './queue.ts';
import { log, type Instruments } from '../telemetry.ts';

export type WorkerConfig = Readonly<{
  commandTimeout: Duration;
  bounds: Bounds;
  schedule: ScheduleConfig;
  batchSize: number;
  concurrency: number;
  lease: Duration;
}>;

export type WorkerDeps = Readonly<{ db: Db; cfg: WorkerConfig; instruments: Instruments }>;

/** Devices processed in this pass. Zero means the loop should pause. */
export async function reconcileBatch(deps: WorkerDeps, now: Instant): Promise<number> {
  const { db, cfg, instruments } = deps;
  const batch = await claim(db, now, cfg.batchSize, cfg.lease);
  if (batch.length === 0) return 0;

  const settled = await mapWithLimit(batch, cfg.concurrency, async (device) => {
    const started = performance.now();
    const step = reconcileChecked({
      now,
      intent: device.intent,
      obs: device.obs,
      report: device.report,
      clock: device.clock,
      state: device.phase,
      opts: { commandTimeout: cfg.commandTimeout, bounds: cfg.bounds },
      next: mint(device.deviceId, device.commandSeq, device.generation),
    });

    await tx(db, async (client) => {
      await persist(client, device.deviceId, {
        phase: step.state,
        clock: device.clock,
        // Only advance the counters when a command was actually minted.
        // Advancing them on every wake would burn generations, and a generation
        // the device never sees is a generation it can never echo — the
        // correlation would then be permanently 'before' and the device would
        // look stuck forever.
        generation: step.command?.generation ?? device.generation,
        commandSeq: step.command === null ? device.commandSeq : device.commandSeq + 1,
        wakeAt: nextWake(step.state, now, cfg.schedule),
      });
      if (step.command !== null) await enqueue(client, device.deviceId, step.command, now);
      await record(client, device.deviceId, device.vendor, now, step);
    });

    instruments.decisions.add(1, { phase: step.state.phase, vendor: device.vendor });
    if (step.correlation !== null) {
      instruments.correlations.add(1, {
        outcome: step.correlation.correlation,
        strategy: step.correlation.source,
        vendor: device.vendor,
      });
    }
    instruments.reconcileDuration.record(performance.now() - started, { vendor: device.vendor });
    return step;
  });

  // A device whose decision threw keeps its lease until it expires, then gets
  // claimed again — which is the right default: a transient database error must
  // not strand a device, and a deterministic one (a contract violation) will
  // keep failing visibly rather than silently skipping the device forever.
  for (const [i, result] of settled.entries()) {
    if (!result.ok) {
      log('reconcile.failed', { deviceId: batch[i]?.deviceId, error: String(result.error) });
    }
  }
  return batch.length;
}
