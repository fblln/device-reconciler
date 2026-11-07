/**
 * project.ts — publishing a decision to the twin store, and the no-op that
 * stands in when there is no twin store.
 *
 * WHY A SEPARATE FILE FROM ditto.ts
 * ---------------------------------
 * ditto.ts knows about HTTP and Ditto's resource paths. This knows about the
 * reconciler's phases. Keeping them apart means the mapping from "what the loop
 * decided" to "what a twin should say" is readable on its own, and swapping the
 * twin store for another one (an AWS Device Shadow, Kanto's local twin, a thing
 * that writes to stdout) is a change to one file.
 *
 * WHY A NO-OP RATHER THAN AN `if` AT EVERY CALL SITE
 * -------------------------------------------------
 * The twin is optional: `npm test` and a plain `node src/app.ts` must not
 * require a five-container Ditto stack. A null object keeps the worker free of
 * `if (twin !== null)` at four call sites, and — more usefully — it makes the
 * disabled path exercise exactly the same code shape as the enabled one, so
 * "works without Ditto" and "works with Ditto" are not two different programs.
 */

import { log } from '../telemetry.ts';
import type { Phase } from '../core/reconcile.ts';
import type { Observation } from '../core/reconcile.ts';
import { ackFor, type TwinStore } from './ditto.ts';

/** Everything a twin publication needs from a decision, and nothing more. */
export type Projection = Readonly<{
  deviceId: string;
  vendor: string;
  phase: Phase;
  obs: Observation;
  /** The decision's reason, which becomes PnP's `ad`. */
  why: string;
  /** The desired state and the counter we minted for it. */
  desired: Readonly<{ charging: boolean; generation: number; source: string }>;
}>;

export type Projector = Readonly<{
  ensure: (deviceId: string, vendor: string) => Promise<void>;
  publish: (p: Projection) => Promise<void>;
  enabled: boolean;
}>;

/** The twin is optional and its absence must be ordinary, not a special case. */
export const noTwin: Projector = {
  ensure: async () => {},
  publish: async () => {},
  enabled: false,
};

/**
 * The target the twin reports, which is NOT always the intent.
 *
 * A phase that is asserting or confirming something carries its own target, and
 * that is what the ack is about. A phase that is asserting nothing — IDLE,
 * SUSPENDED — has no target, so the honest thing to report is what the device
 * was last observed doing. Reporting the intent there would make the twin claim
 * a command that was never issued.
 */
function reportedTarget(phase: Phase, obs: Observation): boolean {
  return 'target' in phase ? phase.target : obs.powerDeliveryState === 'PLUGGED_IN:CHARGING';
}

function generationOf(phase: Phase, fallback: number): number {
  if (phase.phase === 'ISSUED') return phase.generation;
  if (phase.phase === 'CONVERGED' && phase.generation !== null) return phase.generation;
  return fallback;
}

export function createProjector(store: TwinStore): Projector {
  /*
   * Every failure is logged and swallowed, which is a deliberate choice and the
   * reason it is concentrated here rather than left to callers.
   *
   * These writes publish CURRENT STATE, not events: idempotent, last-write-wins,
   * and re-published by the next decision for that device — so a write lost to a
   * Ditto restart is repaired by the next sweep rather than lost. Actuation goes
   * through the outbox, which is transactional and does not consult the twin at
   * all. A reconciler that stopped controlling devices because a twin store was
   * down would have chosen the wrong thing to be strict about.
   *
   * What this costs: the twin can lag, and during a Ditto outage anything
   * reading the twin instead of the reconciler's own API sees stale state. That
   * is visible — `twin.publish.failed` in the logs — rather than silent, which
   * is the most that can be had without making the twin a critical path.
   */
  const guard = async (what: string, deviceId: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      log('twin.publish.failed', { what, deviceId, error: String(error) });
    }
  };

  return {
    enabled: true,

    ensure: (deviceId, vendor) => guard('ensure', deviceId, () => store.ensure(deviceId, vendor)),

    publish: (p) =>
      guard('publish', p.deviceId, async () => {
        const target = reportedTarget(p.phase, p.obs);
        const generation = generationOf(p.phase, p.desired.generation);
        const failReason = p.phase.phase === 'FAILED' ? p.phase.reason : undefined;
        await store.publishDesired(p.deviceId, {
          value: p.desired.charging,
          version: p.desired.generation,
          source: p.desired.source,
        });
        await store.publishReported(
          p.deviceId,
          ackFor(p.phase.phase, target, generation, p.why, failReason),
          {
            powerDeliveryState: p.obs.powerDeliveryState,
            deviceTime: p.obs.deviceTime,
            observedGeneration: p.obs.observedGeneration,
          },
        );
      }),
  };
}
