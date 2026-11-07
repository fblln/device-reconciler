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
 * clock.ts — the one place where two clocks are allowed to touch.
 *
 * THE PROBLEM
 * -----------
 * We need to answer one question: "was this telemetry snapshot captured after I
 * sent my command?" If yes, it is evidence about the command. If no, it says
 * nothing. Get it wrong and you either re-send commands forever or credit your
 * command for something a human did.
 *
 * The command's time is on our clock. The snapshot's capture time is on the
 * device's clock. The two are related by an unknown offset and an unknown
 * transit delay, so the question is NOT directly answerable. What we can do is
 * bound it, and — crucially — admit when the bound is too loose to decide.
 *
 * HOW
 * ---
 * Each snapshot gives us a sample of `receivedAt - deviceTime`, which equals
 * (clock offset) + (transit delay). Transit delay is non-negative and varies,
 * so the MINIMUM sample observed is the tightest available estimate of the
 * offset — the same trick NTP uses, for the same reason. We keep that minimum
 * and nothing else: one number, monotonically improving, no history buffer.
 *
 * Converting a device time to our frame then gives an interval, not a point:
 *
 *     local ∈ [ deviceTime + minDelay - skewBound ,
 *               deviceTime + minDelay + skewBound ]
 *
 * which yields three honest answers rather than two: definitely after,
 * definitely before, and — the one most code forgets — cannot tell.
 *
 * WHY TRI-STATE MATTERS
 * ---------------------
 * 'unknown' is not a failure, it is information: it means "wait for better
 * evidence or for the command channel to speak". Collapsing it into a boolean
 * forces a guess at exactly the moment the system has least information, which
 * is where this class of bug is born.
 */

import type { DeviceInstant, Duration, Instant } from './time.ts';
import { duration, instant } from './time.ts';

export type ClockModel = Readonly<{
  /** Tightest observed (receivedAt - deviceTime). null until the first sample. */
  minDelay: Duration | null;
  samples: number;
}>;

export const unknownClock: ClockModel = { minDelay: null, samples: 0 };

/**
 * THE AUDITED CROSSING. The only function permitted to subtract a device time
 * from one of ours. It is a single expression so that reviewing the soundness of
 * this codebase's time handling means reading one line.
 *
 * The result mixes clock offset with transit delay and is therefore an estimate,
 * never a fact — which is why it is called a delay and not an offset.
 */
export function crossClockDelay(receivedAt: Instant, deviceTime: DeviceInstant): Duration {
  return duration(receivedAt - deviceTime);
}

/** Fold one new sample into the estimate. Pure; the shell threads the result. */
export function observeClock(model: ClockModel, receivedAt: Instant, deviceTime: DeviceInstant): ClockModel {
  const sample = crossClockDelay(receivedAt, deviceTime);
  return {
    minDelay: model.minDelay === null || sample < model.minDelay ? sample : model.minDelay,
    samples: model.samples + 1,
  };
}

export type Correlation = 'after' | 'before' | 'unknown';

/**
 * Declared assumptions about the device and its feed. Both belong to the caller
 * because only the operator knows their fleet, and both are ASSUMPTIONS: wrong
 * values here produce confident wrong answers, which is why they are named,
 * typed and passed in rather than hidden as constants.
 */
export type Bounds = Readonly<{
  /** How far the device's clock may have drifted since we last sampled it. */
  skewBound: Duration;
  /**
   * The longest a snapshot may sit between capture and arrival. Required to
   * conclude 'after' at all — see the derivation below.
   */
  maxLatency: Duration;
}>;

/**
 * Was a snapshot captured at `deviceTime` taken after the local instant `t`?
 *
 * THE DERIVATION, because the asymmetry here is easy to get wrong and I did get
 * it wrong first time round.
 *
 * Each snapshot gives one sample: `sample = receivedAt - deviceTime`, which
 * equals `offset + latency` where `offset` converts device time to ours and
 * `latency >= 0` is transit time. So from a sample alone:
 *
 *     offset = sample - latency  <=  sample          (since latency >= 0)
 *
 * The minimum sample is therefore an UPPER bound on the offset, and only an
 * upper bound. That is enough to prove a capture happened BEFORE some instant,
 * and not enough to prove it happened AFTER one — for that we need a lower
 * bound on the offset, which means an upper bound on latency. Hence `maxLatency`:
 *
 *     offset in [ minSample - maxLatency , minSample ]
 *     local capture in [ deviceTime + minSample - maxLatency - skewBound ,
 *                        deviceTime + minSample + skewBound ]
 *
 * Widening by `skewBound` on both sides covers drift since the estimate was
 * taken. The interval then gives three honest answers instead of two.
 *
 * WHY 'unknown' IS NOT A FAILURE
 * ------------------------------
 * It means "wait for a newer snapshot or for the command channel to speak".
 * Collapsing it into a boolean forces a guess at precisely the moment the
 * system has least information, which is where this entire class of bug lives.
 * A reconciler that cannot say "I do not know yet" will eventually tell a user
 * their car is charging when it is not.
 */
export function capturedAfter(
  deviceTime: DeviceInstant,
  t: Instant,
  model: ClockModel,
  bounds: Bounds,
): Correlation {
  if (model.minDelay === null) return 'unknown';
  const lower = instant(deviceTime + model.minDelay - bounds.maxLatency - bounds.skewBound);
  const upper = instant(deviceTime + model.minDelay + bounds.skewBound);
  if (lower > t) return 'after';
  if (upper <= t) return 'before';
  return 'unknown';
}
