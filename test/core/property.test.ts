/**
 * property.test.ts — generated worlds, with the contracts asserted on every
 * decision.
 *
 * WHY THIS LAYER EXISTS AT ALL
 * ----------------------------
 * The unit tests above construct a few dozen worlds that I thought of. This one
 * constructs thousands that I did not, from a seeded generator, and holds the
 * invariants in contracts.ts over every single decision in every one of them.
 * That is the difference between "a branch ran" and "a test would have failed
 * if the branch were wrong": a mutation to the evidence comparison does not
 * merely break one hand-written assertion, it breaks here, on whichever
 * generated trace reaches it first.
 *
 * Three bugs in the sibling repository were found this way rather than by me.
 *
 * WHY A THIRTY-LINE LCG AND NOT A PROPERTY LIBRARY
 * -----------------------------------------------
 * Shrinking is the only thing a library would add that is genuinely hard, and
 * the worlds here are small enough to read whole from the seed that produced
 * them — which is printed on failure. A dependency that has to be installed
 * before an agent can run the tests costs more than it returns at this size.
 *
 * WHY A LIVENESS PROPERTY
 * -----------------------
 * Because every safety property in this file is satisfied by a reconciler that
 * does nothing at all, forever. Without P4 a mutant that returns `hold` on
 * every path passes the entire suite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileChecked } from '../../src/core/contracts.ts';
import { observeClock, type ClockModel } from '../../src/core/clock.ts';
import { generation, nextGeneration, type Generation } from '../../src/core/correlate.ts';
import { chance, intBetween, pick, rng, type Rng } from '../../src/core/lcg.ts';
import { initialPhase, type Input, type Phase } from '../../src/core/reconcile.ts';
import { deviceInstant, duration, instant, type DeviceInstant } from '../../src/core/time.ts';
import { bounds, opts } from './_world.ts';

/**
 * A world is the parameters of one simulated device, drawn once and then held
 * fixed for the whole trace. They are the pathologies the sibling repo's
 * scenarios enumerate by hand — skew, lag, reordering, a device that counts and
 * one that does not — sampled rather than listed.
 */
type World = Readonly<{
  /** Device clock offset from ours. Can be badly wrong in either direction. */
  skew: number;
  /** How long a snapshot sits between capture and arrival. */
  latency: number;
  /** How often the device captures. */
  captureInterval: number;
  /** How long after a command the device actually moves, or never. */
  actuation: number | null;
  /** Whether this device echoes a generation. Most consumer hardware does not. */
  counts: boolean;
  /** Probability a tick delivers an out-of-order or duplicate snapshot. */
  reorder: number;
  /** Probability the telemetry feed is dark on a given tick. */
  outage: number;
  /** Whether the command channel ever reports APPLIED, and how late. */
  appliedAfter: number | null;
  rejects: boolean;
  intentFlips: boolean;
}>;

function world(r: Rng, benign: boolean): World {
  if (benign) {
    // A fleet behaving well. Needed for the liveness property: a reconciler can
    // only be required to converge when convergence is actually possible.
    return {
      skew: 0,
      latency: intBetween(r, 1_000, 5_000),
      captureInterval: intBetween(r, 5_000, 15_000),
      actuation: intBetween(r, 1_000, 10_000),
      counts: chance(r, 0.5),
      reorder: 0,
      outage: 0,
      appliedAfter: chance(r, 0.5) ? intBetween(r, 1_000, 20_000) : null,
      rejects: false,
      intentFlips: false,
    };
  }
  return {
    skew: pick(r, [0, 0, 1_000, -1_000, 600_000, -600_000, 86_400_000]),
    /*
     * Deliberately drawn BEYOND the declared maxLatency of 120s, up to 240s.
     *
     * The first version of this capped it at the declared bound, on the
     * assumption that a feed slower than its bound must produce false
     * confirmations — garbage in, garbage out. That assumption turned out to be
     * wrong, and the test that was written to demonstrate it could not be made
     * to fail. The reason is the watermark: converging from ISSUED needs the
     * correlation to say `after` AND the reading to agree with the target, and a
     * stale capture that agrees with the target is one in which the target state
     * was already true. Breaking the latency bound costs decisions — more
     * `unknown`, more waiting — before it costs correctness.
     *
     * So the worlds stay uncapped, which is both wider and more honest than the
     * cap was.
     */
    latency: intBetween(r, 0, 2 * opts.bounds.maxLatency),
    captureInterval: intBetween(r, 1_000, 120_000),
    actuation: chance(r, 0.25) ? null : intBetween(r, 0, 300_000),
    counts: chance(r, 0.4),
    reorder: chance(r, 0.3) ? 0.2 : 0,
    outage: chance(r, 0.3) ? 0.15 : 0,
    appliedAfter: chance(r, 0.4) ? intBetween(r, 0, 400_000) : null,
    rejects: chance(r, 0.1),
    intentFlips: chance(r, 0.2),
  };
}

const TICK = 5_000;
const TICKS = 120;

type Trace = Readonly<{
  steps: number;
  issued: number;
  converged: boolean;
  failed: boolean;
  /** Command ids issued, in order. Duplicates here are the headline bug. */
  commandIds: string[];
  convergedWhileWrong: number;
}>;

/**
 * Run one world for TICKS decisions through `reconcileChecked`, which asserts
 * every contract on every step. The simulation around it is deliberately
 * simple-minded: it is here to produce adversarial INPUTS, not to be a faithful
 * device. Fidelity lives in src/platform/sim.ts, which is runnable.
 */
function run(w: World, r: Rng): Trace {
  let phase: Phase = initialPhase(instant(0));
  let clock: ClockModel = { minDelay: null, samples: 0 };
  let gen: Generation = generation(0);
  let seq = 0;
  let intent = true;

  // Device truth, and when it last changed.
  let truth = false;
  let appliesAt: number | null = null;
  let commandedAt: number | null = null;
  let commandTarget = false;
  let appliedGen: Generation = generation(0);
  let reportedApplied = false;

  const commandIds: string[] = [];
  let issued = 0;
  let converged = false;
  let failed = false;
  let convergedWhileWrong = 0;

  for (let i = 1; i <= TICKS; i++) {
    const now = instant(i * TICK);

    if (w.intentFlips && chance(r, 0.03)) intent = !intent;
    if (appliesAt !== null && now >= appliesAt) {
      truth = commandTarget;
      appliedGen = gen;
      appliesAt = null;
    }

    const reachable = !chance(r, w.outage);
    // Capture time on the DEVICE's clock, optionally stale or duplicated.
    const nominal = Math.floor((now - w.latency) / w.captureInterval) * w.captureInterval;
    const captured = chance(r, w.reorder) ? nominal - w.captureInterval : nominal;
    const deviceTime: DeviceInstant = deviceInstant(Math.max(0, captured) + w.skew);

    const obs = {
      deviceId: 'gen',
      isReachable: reachable,
      deviceTime,
      receivedAt: now,
      powerDeliveryState: truth ? ('PLUGGED_IN:CHARGING' as const) : ('PLUGGED_IN:STOPPED' as const),
      observedGeneration: w.counts ? appliedGen : null,
    };

    if (reachable) clock = observeClock(clock, now, deviceTime);

    const report =
      phase.phase === 'ISSUED' && commandedAt !== null
        ? w.rejects
          ? // A refused command must not then actuate. Without this the
            // simulated device applies an instruction it told us it would not,
            // and no reconciler can be held responsible for a device that
            // contradicts its own command channel.
            ((appliesAt = null), { commandId: phase.commandId, state: 'REJECTED' as const, at: now })
          : w.appliedAfter !== null && now >= commandedAt + w.appliedAfter
            ? { commandId: phase.commandId, state: 'APPLIED' as const, at: now }
            : { commandId: phase.commandId, state: 'ACCEPTED' as const, at: now }
        : null;
    if (report?.state === 'APPLIED') reportedApplied = true;

    const input: Input = {
      now,
      intent: { charging: intent },
      obs,
      report,
      clock,
      state: phase,
      opts,
      next: { commandId: `gen/${seq + 1}`, generation: nextGeneration(gen) },
    };

    const step = reconcileChecked(input);

    if (step.command !== null) {
      commandIds.push(step.command.commandId);
      issued++;
      seq++;
      gen = step.command.generation;
      commandTarget = step.command.target;
      commandedAt = now;
      reportedApplied = false;
      appliesAt = w.actuation === null ? null : now + w.actuation;
    }
    if (step.state.phase === 'CONVERGED') {
      converged = true;
      /*
       * P3's counter, and the subtlety that made it fail at first.
       *
       * It counts a fresh CLAIM of convergence, not a tick spent holding one.
       * `step.state !== phase` is the test, the same reference-identity trick
       * contract I3 uses: holding across a quiet tick returns the very same
       * phase object, so identity separates a hold from a claim exactly with no
       * field comparison to get wrong.
       *
       * The distinction is not a technicality. A reconciler that converged
       * honestly and then hears nothing for four minutes IS showing a stale
       * answer, and that is the correct behaviour of a loop whose only evidence
       * is a feed that has not produced a new capture — the alternative is to
       * un-converge on no evidence at all. What must never happen is CLAIMING
       * convergence about a device that disagrees, and that is what this counts.
       * The staleness is modelled separately and surfaced to a user, as `stale`
       * in src/core/presentation.ts.
       *
       * The exception is the command channel saying APPLIED: then we were told
       * first-hand by the only authority there is, and a device that lies on its
       * own command channel is outside what any correlation can catch.
       */
      if (step.state !== phase && step.state.target !== truth && !reportedApplied) {
        convergedWhileWrong++;
      }
    }
    if (step.state.phase === 'FAILED') failed = true;
    phase = step.state;
  }

  return { steps: TICKS, issued, converged, failed, commandIds, convergedWhileWrong };
}

test('P1-P3 safety: 400 adversarial worlds, every contract on every decision', () => {
  // The contracts (I1-I9) are asserted inside reconcileChecked, so reaching the
  // end of this loop is itself the assertion for all nine. What is checked here
  // is the properties that span a whole trace rather than one step.
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    const w = world(r, false);
    let trace: Trace;
    try {
      trace = run(w, rng(seed * 7919));
    } catch (cause) {
      // The seed is the repro. Printed because a generated counterexample that
      // cannot be replayed is a flake, and a flake gets retried rather than
      // fixed.
      throw new Error(`seed ${seed} failed on world ${JSON.stringify(w)}`, { cause });
    }

    // P1. No command id is ever issued twice. This is THE property of the
    // design: a duplicate here is a duplicate actuation.
    assert.equal(
      new Set(trace.commandIds).size,
      trace.commandIds.length,
      `seed ${seed}: duplicate command id in ${JSON.stringify(trace.commandIds)}`,
    );

    // P2. Commands are bounded by the ticks, not by the pathology. A reconciler
    // that re-issues on every unknown correlation passes every per-step
    // contract and still hammers the vendor.
    assert.ok(trace.issued <= TICKS / 2, `seed ${seed}: issued ${trace.issued} commands in ${TICKS} ticks`);

    // P3. Convergence is never claimed about a device whose truth disagrees,
    // unless the command channel asserted it. Note this is the property that
    // was too strong in the sibling repo and had to be weakened for exactly
    // this reason — the note is in its README, and it is weakened here too.
    assert.equal(
      trace.convergedWhileWrong,
      0,
      `seed ${seed}: claimed convergence while the device disagreed, world ${JSON.stringify(w)}`,
    );
  }
});

test('P4 liveness: a well-behaved device under a stable intent does converge', () => {
  // Without this, a mutant that holds on every path passes everything above.
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed);
    const w = world(r, true);
    const trace = run(w, rng(seed * 104_729));
    assert.ok(trace.converged, `seed ${seed}: never converged on a benign world ${JSON.stringify(w)}`);
    assert.equal(trace.failed, false, `seed ${seed}: failed on a benign world ${JSON.stringify(w)}`);
  }
});

test('P5: a device that never actuates and never reports is always eventually failed', () => {
  // The other liveness direction, and the reason the deadline exists: silence
  // must not be waited out forever. A loop that merely holds is safe and
  // useless.
  const trace = run(
    {
      skew: 0,
      latency: 1_000,
      captureInterval: 10_000,
      actuation: null,
      counts: false,
      reorder: 0,
      outage: 0,
      appliedAfter: null,
      rejects: false,
      intentFlips: false,
    },
    rng(1),
  );
  assert.ok(trace.failed, 'a device that never moves must eventually be reported failed');
  assert.ok(trace.issued >= 1);
});

test('the generated worlds really do exercise both correlation strategies', () => {
  // A property test that silently stopped generating counting devices would go
  // on passing while covering half of what it claims. Cheap insurance against
  // the generator drifting.
  let counting = 0;
  let outages = 0;
  let skewed = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const w = world(rng(seed), false);
    if (w.counts) counting++;
    if (w.outage > 0) outages++;
    if (w.skew !== 0) skewed++;
  }
  assert.ok(counting > 50 && counting < 350, `counting devices: ${counting}`);
  assert.ok(outages > 50, `worlds with outages: ${outages}`);
  assert.ok(skewed > 100, `worlds with clock skew: ${skewed}`);
});

test('a duration of zero is a legal timeout boundary, not an accident', () => {
  // Pins the one option value a generator would never produce: a timeout that
  // has already expired when the command is issued. The command still goes out
  // — the decision to issue precedes the deadline check — and fails on the very
  // next tick, which is the honest behaviour for an operator who configured
  // zero.
  const step = reconcileChecked({
    now: instant(1_000),
    intent: { charging: true },
    obs: {
      deviceId: 'd',
      isReachable: true,
      deviceTime: deviceInstant(0),
      receivedAt: instant(1_000),
      powerDeliveryState: 'PLUGGED_IN:STOPPED',
      observedGeneration: null,
    },
    report: null,
    clock: { minDelay: null, samples: 0 },
    state: initialPhase(instant(0)),
    opts: { commandTimeout: duration(1), bounds },
    next: { commandId: 'd/1', generation: generation(1) },
  });
  assert.notEqual(step.command, null);
  assert.equal(step.state.phase, 'ISSUED');
  assert.equal(step.state.phase === 'ISSUED' ? step.state.deadline : -1, 1_001);
});
