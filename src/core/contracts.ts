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
 * contracts.ts — the invariants, as executable postconditions.
 *
 * WHY NOT JUST TESTS
 * ------------------
 * Line coverage proves a branch ran; it does not prove a test would have failed
 * if the branch were wrong. The properties below are the ones that actually
 * matter — "never issue into an unreachable cloud", "never claim convergence
 * without evidence" — and they must hold on EVERY decision, not just the dozen
 * a unit test happens to construct.
 *
 * So they live here as assertions and run on every tick of every scenario and
 * every one of the thousands of randomly generated traces in the property test.
 * That turns an aspirational comment into something that fails CI. A mutation
 * to the evidence comparison in reconcile.ts does not merely fail one assertion
 * in one test — it fails here, on whichever of the generated traces reaches it
 * first.
 *
 * COST
 * ----
 * These are deliberately O(1) and allocation-free, but they are still work, so
 * the hot path can opt out: engine.ts runs checked (correctness matters more
 * than speed in a 90-tick simulation), the benchmark runs raw. The budget test
 * measures the raw path, which is what production would use.
 */

import assert from 'node:assert/strict';
import { plus } from './time.ts';
import { reconcile, type Input, type Step } from './reconcile.ts';
import { correlate } from './correlate.ts';

/**
 * Preconditions on what the shell feeds us. An observation dated in the future
 * means the caller's clock and the API's clock disagree — a real and nasty bug,
 * because it makes every observation look like valid evidence.
 */
export function checkInput(input: Input): void {
  // `receivedAt` is on our clock, so this is a real check. `deviceTime` is on
  // the device's and is deliberately NOT compared here: a device clock ahead of
  // ours is normal, not a bug, and asserting on it would be the very
  // cross-clock comparison this codebase exists to avoid.
  assert.ok(
    input.obs.receivedAt <= input.now,
    `observation received in the future: receivedAt=${input.obs.receivedAt} now=${input.now}`,
  );
  assert.ok(input.opts.commandTimeout > 0, 'commandTimeout must be positive');
  assert.ok(input.state.since <= input.now, 'phase entered in the future');
}

/** Postconditions. Each one is a sentence from the README, mechanically enforced. */
export function checkStep(input: Input, step: Step): void {
  const { now, obs, state: prior, opts, clock } = input;
  const next = step.state;

  // I1. Nothing is ever issued into a cloud we cannot reach.
  if (!obs.isReachable) {
    assert.equal(step.command, null, 'I1 violated: command issued while unreachable');
  }

  // I2. A command and an ISSUED phase are inseparable, and its deadline is
  // exactly one timeout from now. A command without a deadline is a leak.
  if (step.command !== null) {
    assert.equal(next.phase, 'ISSUED', 'I2 violated: command issued without entering ISSUED');
    if (next.phase === 'ISSUED') {
      assert.equal(next.target, step.command.target, 'I2 violated: command disagrees with target');
      assert.equal(next.commandId, step.command.commandId, 'I2 violated: phase and command disagree on id');
      assert.equal(
        next.generation,
        step.command.generation,
        'I2 violated: phase and command disagree on generation',
      );
      assert.equal(next.since, now, 'I2 violated: command not dated now');
      assert.equal(next.deadline, plus(now, opts.commandTimeout), 'I2 violated: wrong deadline');
    }

    // I8. Generations only ever move forward. A reused or lowered generation
    // would make a device's echo ambiguous, which is the single thing the
    // counter exists to prevent.
    // A CONVERGED phase reached without a command holds no generation, so there
    // is nothing for a new command to have to advance past.
    const held = prior.phase === 'ISSUED' || prior.phase === 'CONVERGED' ? prior.generation : null;
    if (held !== null) {
      assert.ok(
        step.command.generation > held,
        `I8 violated: generation ${step.command.generation} does not advance past ${held}`,
      );
    }
  }

  /*
   * I3. Convergence is never CLAIMED without evidence — and the two ways of
   * claiming it need different evidence, so they are checked separately rather
   * than through one re-derived predicate. An earlier version of this contract
   * applied the cross-clock rule to both and was wrong: it rejected a perfectly
   * sound re-confirmation that the decision had made from the exact watermark.
   * The property test found it. Hence the split below.
   *
   * Holding in CONVERGED across a quiet tick returns the very same phase object,
   * so reference identity separates a hold from a fresh claim exactly, with no
   * field comparison to get wrong.
   */
  if (next.phase === 'CONVERGED' && next !== prior) {
    if (prior.phase === 'ISSUED') {
      // The one that matters: never report that a command worked without either
      // the command channel saying so, or telemetry provably post-dating it.
      const mine = input.report;
      const applied = mine !== null && mine.commandId === prior.commandId && mine.state === 'APPLIED';
      const correlated =
        correlate(obs.observedGeneration, prior.generation, obs.deviceTime, prior.since, clock, opts.bounds)
          .correlation === 'after';
      assert.ok(
        applied || correlated,
        `I3 violated: converged a command with neither channel supporting it (deviceTime=${obs.deviceTime} since=${prior.since})`,
      );
    } else if (prior.phase === 'CONVERGED' && prior.seen !== null) {
      // A re-confirmation must be based on something the device captured after
      // the snapshot we already counted. Same clock, so this is exact.
      assert.ok(
        obs.deviceTime > prior.seen,
        `I3 violated: re-claimed convergence without a newer capture (${obs.deviceTime} <= ${prior.seen})`,
      );
    }
    // From IDLE any reading is admissible by design — there is no action of ours
    // to correlate against. See telemetryFreshness in reconcile.ts.
  }

  // I4. Failure is never inferred from a disagreeing reading. There are exactly
  // two ways to fail, and each must be backed by the thing that justifies it:
  // a deadline that has actually passed, or a rejection actually reported for
  // THIS command. Anything else is a guess dressed up as a verdict.
  if (next.phase === 'FAILED' && prior.phase !== 'FAILED') {
    assert.equal(prior.phase, 'ISSUED', 'I4 violated: failed from a phase with no command in flight');
    if (prior.phase === 'ISSUED') {
      if (next.reason === 'rejected-by-vendor') {
        const mine = input.report;
        assert.ok(
          mine !== null && mine.commandId === prior.commandId && mine.state === 'REJECTED',
          'I4 violated: claimed a vendor rejection with no matching REJECTED report',
        );
      } else {
        assert.ok(now >= prior.deadline, 'I4 violated: failed before the deadline');
      }
    }
  }

  // I5. No duplicate commands while one is in flight. Only an intent change may
  // supersede, and then the target must actually differ.
  if (prior.phase === 'ISSUED' && step.command !== null) {
    assert.notEqual(
      step.command.target,
      prior.target,
      'I5 violated: re-issued the same target while in flight',
    );
  }

  // I6. No phase is ever dated in the future; `since` is evidence, not a plan.
  assert.ok(next.since <= now, 'I6 violated: next phase dated in the future');

  /*
   * I9. ADDED HERE. A reported correlation agrees with the device's own report
   * about whether it counts. The strategy choice is a one-line conditional in
   * correlate.ts and it is the most consequential line in the system: taking the
   * clock fallback on a device that echoes a generation throws away exactness
   * for no reason, and claiming a generation for a device that reports none is a
   * confident answer derived from nothing. Asserted on every decision, so a
   * mutant that inverts that conditional cannot survive — which matters more
   * here than in the sibling repo, because the readout this repository exists to
   * produce reports the fallback rate as a fact about the fleet.
   */
  if (step.correlation !== null) {
    assert.equal(
      step.correlation.source,
      obs.observedGeneration === null ? 'clock' : 'generation',
      'I9 violated: correlation source disagrees with whether the device reported a generation',
    );
  }

  // I7. Every decision is explicable. An empty reason means a path was added
  // without thinking about what to tell the user, which is how silent failures
  // get shipped.
  assert.ok(step.why.length > 0, 'I7 violated: decision without a reason');
}

/** reconcile(), with its contract enforced. Same signature, so it is a drop-in. */
export function reconcileChecked(input: Input): Step {
  checkInput(input);
  const step = reconcile(input);
  checkStep(input, step);
  return step;
}
