/**
 * override.ts — who wins when a human and a schedule disagree.
 *
 * WHY THIS IS A SEPARATE MODULE AND NOT PART OF THE DECISION FUNCTION
 * -------------------------------------------------------------------
 * `reconcile()` answers one question: given an intent, has the device reached it
 * and can I prove it. It deliberately has no opinion about where the intent came
 * from, and it should not — mixing "what do I want" with "did I get it" is how a
 * control loop becomes untestable. So precedence runs UPSTREAM: this module
 * picks the effective intent, and the decision function receives it as data.
 * That also means the ported core needs no change to support any of this.
 *
 * THE PROBLEM, WHICH THE SIBLING REPO NAMES AND DOES NOT SOLVE
 * -----------------------------------------------------------
 * The decision function can now identify a third-party change exactly: a
 * command advances the generation, a human at the panel does not, so a fresh
 * reading that disagrees with intent while still reporting the generation we
 * converged at is positive evidence that somebody else moved the device. That is
 * a fact. What to DO about it is a policy, and the sibling repo stops at the
 * fact on purpose — fighting a human is right for a charger on a tariff and
 * wrong for someone who just turned the heating up, and nothing in a state
 * machine can tell you which.
 *
 * Retrofitting a policy onto a loop that already re-asserts unconditionally is
 * painful, because by then every caller assumes intent is a single boolean. So
 * intent here has a SOURCE and a precedence from the start, which is the shape
 * Kubernetes server-side apply arrived at: field ownership, and a conflict
 * raised rather than silently resolved when two managers disagree.
 *
 * THE THREE OUTCOMES
 * ------------------
 *   assert    go ahead and converge on the stored intent. The normal case.
 *   hold      a local change outranks the stored intent for now. We stop
 *             asserting and let the device be. Bounded, so a schedule is not
 *             abandoned forever because somebody pressed a button once.
 *   conflict  two deliberate writers disagree and neither can be silently
 *             overridden. We stop asserting AND say so, because the resolution
 *             is a human decision and the only wrong move is to pick quietly.
 *
 * `hold` and `conflict` both stop asserting; they differ in whether anyone is
 * told. That distinction is the whole value: a hold is routine and a conflict is
 * an alert, and a system that cannot tell them apart either pages on every
 * button press or silently loses arguments with its operator.
 */

import { plus, type Duration, type Instant } from './time.ts';
import type { Intent, Observation, Phase } from './reconcile.ts';
import { observedCharging } from './reconcile.ts';

/**
 * Where an intent came from. Ordered by deliberateness, not by authority:
 *
 *   schedule  a tariff window, an optimiser, a recurring plan. Standing
 *             instruction, nobody is watching, lowest precedence.
 *   local     somebody physically at the device, or in the vendor's own app.
 *             Inferred from a third-party change, never written by us.
 *   operator  an explicit, recent, attributable request through our API.
 */
export type IntentSource = 'schedule' | 'local' | 'operator';

export type StoredIntent = Readonly<{
  charging: boolean;
  source: IntentSource;
  setAt: Instant;
}>;

export type Resolution = Readonly<{
  /** The intent to hand to the decision function. */
  intent: Intent;
  outcome: 'assert' | 'hold' | 'conflict';
  why: string;
  /**
   * When a hold expires, so the shell can set a durable timer and the schedule
   * resumes on its own. Null when nothing is being held.
   */
  holdUntil: Instant | null;
}>;

export type OverrideConfig = Readonly<{
  /**
   * How long a local change outranks a schedule. A deployment decision, not a
   * constant: minutes for a charger on a half-hourly tariff, hours for a heat
   * pump somebody has just turned up because they are cold.
   */
  localHold: Duration;
  /**
   * How recently an operator request counts as deliberate enough to outrank a
   * local change. Beyond this it has become a standing instruction like any
   * other and a person at the device wins.
   */
  operatorFreshness: Duration;
}>;

/**
 * Did somebody other than us move this device?
 *
 * EXACT, not inferred: a command advances the generation and a human does not,
 * so a device still reporting the generation we converged at, while showing a
 * state that disagrees with what we converged ON, cannot have been moved by us.
 * Same channel, same counter, no clock involved.
 *
 * This mirrors three lines inside reconcile.ts, which is a duplication I am
 * choosing: the alternative is adding a structural field to the ported core's
 * `Step` so the shell can read the signal, and the core must not grow a second
 * local modification for something that is this cheap to re-derive and this easy
 * to pin with a test. If the signal ever gets harder than one conjunction, it
 * moves upstream into the sibling.
 *
 * Returns false whenever the evidence is not exact — a device that reports no
 * generation can never produce this signal, and guessing from the state alone
 * cannot tell a third party apart from our own command finally landing.
 */
export function movedByOther(state: Phase, obs: Observation): boolean {
  return (
    state.phase === 'CONVERGED' &&
    state.generation !== null &&
    obs.observedGeneration !== null &&
    obs.observedGeneration === state.generation &&
    observedCharging(obs) !== state.target
  );
}

/**
 * Pick the effective intent.
 *
 * `localChangeAt` is when a third-party change was last observed, which the
 * shell persists — it cannot be re-derived later, because the moment we
 * re-assert, the generation advances and the evidence is gone. That is the one
 * piece of state this policy needs and the reason it is not a pure function of
 * the current observation alone.
 */
export function resolve(
  stored: StoredIntent,
  localChangeAt: Instant | null,
  observedNow: boolean,
  now: Instant,
  cfg: OverrideConfig,
): Resolution {
  const asserting: Resolution = {
    intent: { charging: stored.charging },
    outcome: 'assert',
    why: `asserting ${stored.source} intent`,
    holdUntil: null,
  };

  if (localChangeAt === null) return asserting;

  const holdUntil = plus(localChangeAt, cfg.localHold);
  if (now >= holdUntil) {
    // The hold has lapsed. The standing instruction resumes, which is the whole
    // reason the hold is bounded: a schedule abandoned forever by one button
    // press is a schedule that silently stops working.
    return { ...asserting, why: `local override expired; resuming ${stored.source} intent` };
  }

  // A local change that happens to agree with us is not an override at all.
  // Treating it as one would hold off a schedule for no reason, and the device
  // is already where we want it.
  if (observedNow === stored.charging) {
    return { ...asserting, why: 'local change agrees with intent; nothing to override' };
  }

  const operatorIsFresh = stored.source === 'operator' && now - stored.setAt <= cfg.operatorFreshness;

  if (operatorIsFresh) {
    /*
     * Two deliberate writers, both recent, disagreeing. Neither can be silently
     * overridden: asserting would fight a person standing at the device, and
     * holding would silently discard an explicit request somebody is waiting on.
     * So we do neither and raise it, which is the server-side-apply answer —
     * a conflict is reported to whoever owns the field, not resolved by
     * whichever writer happened to be last.
     *
     * The intent returned is the OBSERVED state, so the decision function sees
     * a converged device and takes no action. Returning the stored intent here
     * would make the loop keep issuing commands while we claim to be raising a
     * conflict, which is the worst of both.
     */
    return {
      intent: { charging: observedNow },
      outcome: 'conflict',
      why: `local change contradicts an operator request made ${Math.round((now - stored.setAt) / 1000)}s ago; not overriding either`,
      holdUntil,
    };
  }

  return {
    intent: { charging: observedNow },
    outcome: 'hold',
    why: `local change outranks ${stored.source} intent for another ${Math.round((holdUntil - now) / 1000)}s`,
    holdUntil,
  };
}
