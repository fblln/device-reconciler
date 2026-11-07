/*
 * PORTED, DELIBERATELY DUPLICATED.
 *
 * This module is the pure correlation core, carried over unchanged from the
 * sibling `device-reconciler` repository (see README, "Two repositories"). It is
 * copied rather than depended on, and that is a decision rather than laziness:
 * the sibling repo's whole claim is that it has NO dependencies, no I/O and no
 * build step, so publishing it as a package to be consumed here would destroy
 * the property it exists to demonstrate. A vendored copy of five files with a
 * single-direction flow (core never imports from the shell) is cheaper than a
 * package boundary, and the drift risk is bounded by the fact that the core is
 * finished: its invariants are pinned by contracts and property tests that came
 * across with it.
 *
 * Re-port procedure, because a vendored copy that nobody knows how to refresh
 * is a fork: copy the file from the sibling, re-apply this banner, and re-apply
 * the two additions marked ADDED HERE (Step.correlation in reconcile.ts and
 * contract I9 in contracts.ts). Nothing else in these five files may be edited
 * locally; a change belongs upstream, in the sibling, where the property tests
 * that pin it live.
 *
 * Everything below this banner is the pure, deterministic, clock-free half of
 * the system. Nothing in src/core may import from src/store, src/adapter,
 * src/platform or src/service. That rule is what keeps the hard part testable
 * with a virtual clock while the operational half talks to Postgres and HTTP.
 */

/**
 * correlate.ts — "did this telemetry post-date my command?", two ways.
 *
 * THE QUESTION
 * ------------
 * Commands and state travel on separate channels. To know whether a snapshot is
 * evidence about a command, we must order an event on OUR clock against an
 * event on the DEVICE's. There are exactly two honest ways to do that, and they
 * are not equally good.
 *
 * STRATEGY 1 — GENERATION (exact, preferred)
 * ------------------------------------------
 * If the device echoes back which instruction it last acted on, the question
 * becomes integer comparison: no clocks, no skew, no bounds, no ambiguity. This
 * is not a trick I invented; it is the standard answer, arrived at independently
 * across the industry:
 *
 *   Kubernetes   `metadata.generation` is a monotonically increasing sequence
 *                number for the desired state, set by the API server. A
 *                controller writes back `status.observedGeneration`, and a
 *                status whose observedGeneration is behind the generation is
 *                known to be stale. Conditions carry their own, so staleness is
 *                tracked per condition. The Gateway API conformance suite
 *                asserts the counter advances after a spec change.
 *   AWS IoT      Device Shadow documents carry a `version` that increments on
 *                every update, and the service processes an update only if the
 *                version supplied matches the current one — optimistic
 *                concurrency rather than timestamps. A `clientToken` ties a
 *                response back to the request that caused it.
 *
 * The lesson from both: do not order distributed events by wall clock when a
 * counter is available. A counter is set by one writer, cannot go backwards,
 * cannot collide, and survives a clock correction.
 *
 * STRATEGY 2 — CLOCK BOUNDS (inexact, fallback)
 * ---------------------------------------------
 * Most consumer energy hardware offers no such counter — you get a timestamp
 * from the device's own clock and nothing else. Then the best available answer
 * is an interval, and the interval sometimes straddles the instant we care
 * about, which is why `Correlation` has three values and not two. See clock.ts
 * for the derivation.
 *
 * WHY BOTH, RANKED
 * ----------------
 * Shipping only strategy 2 would mean throwing away exactness on the devices
 * that offer it. Shipping only strategy 1 would mean not supporting most of the
 * fleet. So the reconciler asks for the best answer available and is told which
 * kind it got — and the fallback is visible in the decision's reason string, so
 * an operator can see when they are relying on an estimate.
 */

import { capturedAfter, type Bounds, type ClockModel } from './clock.ts';
import type { DeviceInstant, Instant } from './time.ts';

/**
 * A monotonic counter for desired state, minted by us. Branded so it cannot be
 * confused with a timestamp, a count of commands, or an array index — all of
 * which are also numbers and none of which order anything.
 */
export type Generation = number & { readonly __kind: 'Generation' };

export const generation = (n: number): Generation => n as Generation;
export const nextGeneration = (g: Generation): Generation => (g + 1) as Generation;

export type Correlation = 'after' | 'before' | 'unknown';

/** Which strategy produced an answer. Surfaced so reasons can say so out loud. */
export type CorrelationSource = 'generation' | 'clock';

export type CorrelationResult = Readonly<{
  correlation: Correlation;
  source: CorrelationSource;
}>;

/**
 * Exact. `observed` is the generation the device says it last applied.
 *
 * Note the >=, not ==: a device may skip generations if commands superseded each
 * other in flight, and demanding equality would wait forever for a generation
 * the device has already moved past.
 */
export function byGeneration(observed: Generation, target: Generation): Correlation {
  return observed >= target ? 'after' : 'before';
}

/**
 * The best answer available for this device, and which kind it is.
 *
 * `observedGeneration` is null for the many devices that do not report one; that
 * is the normal case, not an error, and it selects the fallback.
 */
export function correlate(
  observedGeneration: Generation | null,
  commandGeneration: Generation,
  deviceTime: DeviceInstant,
  actedAt: Instant,
  clock: ClockModel,
  bounds: Bounds,
): CorrelationResult {
  if (observedGeneration !== null) {
    return { correlation: byGeneration(observedGeneration, commandGeneration), source: 'generation' };
  }
  return { correlation: capturedAfter(deviceTime, actedAt, clock, bounds), source: 'clock' };
}
