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
import { movedByOther, resolve, type OverrideConfig } from '../core/override.ts';
import { observedCharging } from '../core/reconcile.ts';
import { mint } from '../core/identity.ts';
import { nextWake, type ScheduleConfig } from '../core/schedule.ts';
import type { Bounds } from '../core/clock.ts';
import type { Duration, Instant } from '../core/time.ts';
import { tx, type Db } from '../store/db.ts';
import { claim, persist } from '../store/devices.ts';
import { enqueue } from '../store/outbox.ts';
import { record } from '../store/decisions.ts';
import type { Projector } from '../twin/project.ts';
import { mapWithLimit } from './queue.ts';
import { log, type Instruments } from '../telemetry.ts';

export type WorkerConfig = Readonly<{
  override: OverrideConfig;
  commandTimeout: Duration;
  bounds: Bounds;
  schedule: ScheduleConfig;
  batchSize: number;
  concurrency: number;
  lease: Duration;
}>;

export type WorkerDeps = Readonly<{
  db: Db;
  cfg: WorkerConfig;
  instruments: Instruments;
  /** The twin projection. `noTwin` when no twin store is configured. */
  twin: Projector;
}>;

/** Devices processed in this pass. Zero means the loop should pause. */
export async function reconcileBatch(deps: WorkerDeps, now: Instant): Promise<number> {
  const { db, cfg, instruments, twin } = deps;
  const batch = await claim(db, now, cfg.batchSize, cfg.lease);
  if (batch.length === 0) return 0;

  const settled = await mapWithLimit(batch, cfg.concurrency, async (device) => {
    const started = performance.now();

    /*
     * PRECEDENCE FIRST, DECISION SECOND.
     *
     * The decision function has no opinion about where an intent came from, and
     * should not — mixing "what do I want" with "did I get it" is how a control
     * loop becomes untestable. So the effective intent is resolved here and
     * handed over as data (src/core/override.ts).
     *
     * The third-party signal is checked BEFORE reconciling, because reconciling
     * destroys it: the evidence is the device still reporting the generation we
     * converged at, and the moment we issue a command the generation advances
     * and that evidence is gone. Once observed it is persisted, so the hold
     * window survives restarts and the device is not re-asserted at the first
     * wake after a deploy.
     */
    const localChangeAt = movedByOther(device.phase, device.obs) ? now : device.localChangeAt;
    const resolution = resolve(device.stored, localChangeAt, observedCharging(device.obs), now, cfg.override);

    const step = reconcileChecked({
      now,
      intent: resolution.intent,
      obs: device.obs,
      report: device.report,
      clock: device.clock,
      state: device.phase,
      opts: { commandTimeout: cfg.commandTimeout, bounds: cfg.bounds },
      next: mint(device.deviceId, device.commandSeq, device.generation),
    });

    const committed = await tx(db, async (client) => {
      // A user action may have changed after claim. Fence stale decisions before
      // either the phase or its outbox command can overwrite that newer action.
      const current = await client.query(
        'select active_operation_id from device where device_id=$1 for update',
        [device.deviceId],
      );
      if (current.rows[0]?.active_operation_id !== device.activeOperationId) return false;
      await persist(client, device.deviceId, {
        phase: step.state,
        clock: device.clock,
        // Cleared once the hold lapses, so the row does not keep a stale
        // override around forever and a later genuine local change is not read
        // as a continuation of one from last week.
        localChangeAt: resolution.outcome === 'assert' ? null : localChangeAt,
        // Only advance the counters when a command was actually minted.
        // Advancing them on every wake would burn generations, and a generation
        // the device never sees is a generation it can never echo — the
        // correlation would then be permanently 'before' and the device would
        // look stuck forever.
        generation: step.command?.generation ?? device.generation,
        commandSeq: step.command === null ? device.commandSeq : device.commandSeq + 1,
        // A hold has to end on its own, so the device is woken when it expires
        // rather than waiting for the next sweep to notice. `least` so this never
        // pushes a nearer deadline out.
        wakeAt: earliest(nextWake(step.state, now, cfg.schedule), resolution.holdUntil),
        // The same sentence the audit log gets, so the view model's fault
        // string and the log never disagree about why a device is where it is.
        why: resolution.outcome === 'assert' ? step.why : `${resolution.why}; ${step.why}`,
      });
      if (step.command !== null) await enqueue(client, device.deviceId, step.command, now);
      // The override's reasoning goes in the audit log alongside the decision's.
      // A device that is deliberately not being asserted looks identical to one
      // that is stuck unless the log says which.
      await record(
        client,
        device.deviceId,
        device.vendor,
        now,
        resolution.outcome === 'assert' ? step : { ...step, why: `${resolution.why}; ${step.why}` },
      );
      return true;
    });
    if (!committed) return;

    instruments.decisions.add(1, {
      phase: step.state.phase,
      vendor: device.vendor,
      override: resolution.outcome,
    });
    if (resolution.outcome === 'conflict') {
      // An alert, not a statistic: two deliberate writers disagree and the
      // resolution is a human decision. A hold is routine and stays a counter.
      log('override.conflict', {
        deviceId: device.deviceId,
        storedSource: device.stored.source,
        why: resolution.why,
      });
    }
    if (step.correlation !== null) {
      instruments.correlations.add(1, {
        outcome: step.correlation.correlation,
        strategy: step.correlation.source,
        vendor: device.vendor,
      });
    }
    /*
     * The twin, AFTER the transaction. Deliberately outside it: Ditto is not a
     * participant in the atomic write that makes a restart safe, and awaiting an
     * HTTP call inside a database transaction holds a Postgres connection open
     * for the duration of somebody else's outage. The projection is
     * last-write-wins and self-healing, so publishing a committed decision late
     * is fine and publishing an uncommitted one would not be.
     */
    await twin.publish({
      deviceId: device.deviceId,
      vendor: device.vendor,
      phase: step.state,
      obs: device.obs,
      why: step.why,
      desired: {
        charging: device.stored.charging,
        generation: step.command?.generation ?? device.generation,
        source: device.stored.source,
      },
    });

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

/** The nearer of two wake instants, ignoring a null. */
const earliest = (a: Instant, b: Instant | null): Instant => (b !== null && b < a ? b : a);
