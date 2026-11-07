/**
 * VENDORED FROM THE SIBLING REPOSITORY — `device-reconciler/src/presentation.ts`.
 *
 * RE-PORT PROCEDURE: copy the file from the sibling, re-apply this banner, and
 * re-apply the one thing marked ADDED HERE (`optimistic` sourced per device and
 * the `assumed` note about durability). Nothing else here may be edited
 * locally; a change belongs upstream, in the sibling, where the unit tests that
 * pin the view-model vocabulary live.
 *
 * Everything below this banner is the pure, deterministic, clock-free half of
 * the system. Nothing in src/core may import from src/store, src/adapter,
 * src/platform or src/service.
 */

/**
 * presentation.ts — turning a reconciler phase into something a UI can show
 * without lying to the person reading it.
 *
 * WHY THIS IS A SEPARATE MODULE
 * -----------------------------
 * The decision function answers "what should I do?". A UI needs a different
 * question answered: "what may I tell the user, and how sure am I?" Those are
 * not the same, and collapsing them is how interfaces end up showing a
 * confident toggle for a device nobody has heard from in an hour.
 *
 * Home Assistant arrived at the useful vocabulary here, and it is worth taking
 * rather than reinventing. It separates two ideas that look alike:
 *
 *   assumed_state   we never get a state report from this device at all. The UI
 *                   then shows separate on/off buttons instead of a toggle,
 *                   because a toggle implies you know the current state and are
 *                   flipping it. The widget shape carries the uncertainty.
 *   optimistic      on sending a command, show the new state immediately rather
 *                   than waiting for confirmation. A separate choice, and one
 *                   HA lets you force on even when state reporting exists.
 *
 * A core Home Assistant developer put the distinction as: "optimistic !=
 * assumed. Assumed: we never get a state reported. Be optimistic when sending
 * commands."
 *
 * WHERE THIS GOES FURTHER, AND WHY IT CAN
 * ---------------------------------------
 * Home Assistant makes you DECLARE `assumed_state` in configuration. This
 * reconciler can work it out, because it already tracks whether anything from
 * this device has ever been correlatable. A device that has never produced a
 * reading we could place in time is, precisely, a device whose state we never
 * really get — so `assumed` is derived here rather than configured, and it
 * cannot drift out of date the way a hand-written flag does.
 *
 * ADDED HERE, and it is the reason this file is worth more in this repository
 * than in the sibling: the clock model `assumed` is derived from is DURABLE
 * (`device.clock`, see src/store/devices.ts). In the sibling it lives in
 * memory, so every restart re-reports a correlatable device as `assumed` until
 * a fresh telemetry sample lands — on a two-minute feed, minutes of showing
 * buttons instead of a toggle after every deploy. Persisting the clock model is
 * what makes a derived flag actually better than a declared one rather than
 * merely cleverer.
 *
 * `optimistic` stays configuration, because it is not derivable from anything.
 * It is a product decision about which lie is worse. For a charger on a cheap
 * tariff, showing "charging" a little early is harmless. For a door lock it is
 * not acceptable at any latency, and no amount of telemetry quality changes
 * that. ADDED HERE: it is therefore a per-device COLUMN rather than one global
 * setting, because a fleet is mixed — the same reconciler runs chargers, where
 * the optimistic lie is kind, and heat pumps, where a user who sees "heating"
 * and feels cold stops trusting the app.
 *
 * The other thing available here that a boolean cannot express: this loop holds
 * a DEADLINE. So a UI can show "confirming, 2:47 left" instead of a spinner
 * with no end, and can say which of three faults happened instead of "failed".
 * That is the whole argument for modelling the uncertainty rather than hiding
 * it — it is the only reason the interface has anything honest to say.
 */

import { elapsed, type Duration, type Instant } from './time.ts';
import type { ClockModel } from './clock.ts';
import { observedCharging, type Observation, type Phase } from './reconcile.ts';

/**
 * Where the shown state came from. Ordered loosely from most to least
 * trustworthy, so a UI can caption it rather than presenting all five alike.
 */
export type Confidence =
  /** The device echoed the generation we commanded. Exact, no clocks involved. */
  | 'confirmed-exact'
  /** Telemetry provably post-dated the command, within the declared bounds. */
  | 'confirmed-estimated'
  /** A command is in flight and nothing has confirmed it yet. */
  | 'unconfirmed'
  /** Nothing from this device has ever been correlatable. HA's assumed_state. */
  | 'assumed'
  /** The feed is down; this is the last thing we heard, and it is old. */
  | 'stale'
  /** The last command could not be confirmed, and we stopped pretending. */
  | 'failed';

/**
 * A toggle is a claim that you know the current state and are flipping it.
 * Buttons make no such claim. Picking the widget from the confidence is the
 * cheapest honesty available in a UI.
 */
export type Widget = 'toggle' | 'buttons';

export type Policy = Readonly<{
  /**
   * While a command is in flight, show the target rather than the last known
   * state. Not derivable: it is a judgement about which lie is worse, and the
   * answer differs between a charger and a lock. Per device — see the header.
   */
  optimistic: boolean;
}>;

export type DeviceView = Readonly<{
  /** The state to display. */
  shown: boolean;
  confidence: Confidence;
  widget: Widget;
  /** Non-null while a command is in flight: enough for a countdown, not a spinner. */
  pending: Readonly<{ target: boolean; remaining: Duration }> | null;
  /** The reason the last command failed, ready to show. Null when nothing failed. */
  fault: string | null;
}>;

/**
 * Has anything from this device ever been placeable in time?
 *
 * A device with no telemetry at all never yields a clock sample, so the model
 * stays empty forever; one that reports a generation is correlatable by
 * definition. The conjunction is therefore a good proxy for "we never really
 * get this device's state", which is what `assumed_state` means.
 *
 * ponytail: a proxy, not a history. Tracking "ever correlated" properly would
 * mean another field threaded through the shell, and this answers the same
 * question from state we already hold. Revisit if a device appears that reports
 * telemetry we can never correlate for some other reason.
 */
function isAssumed(obs: Observation, clock: ClockModel): boolean {
  return obs.observedGeneration === null && clock.minDelay === null;
}

/**
 * Pure, like the decision function, and for the same reason: every combination
 * of phase, policy and evidence quality is then a unit test rather than a
 * screenshot somebody has to reproduce by hand.
 */
export function present(
  now: Instant,
  phase: Phase,
  obs: Observation,
  clock: ClockModel,
  policy: Policy,
  lastFault: string | null,
): DeviceView {
  const observed = observedCharging(obs);
  const assumed = isAssumed(obs, clock);
  const widget: Widget = assumed ? 'buttons' : 'toggle';

  switch (phase.phase) {
    case 'ISSUED': {
      // The deadline is the point. A countdown tells the user how long their
      // patience is expected to last; a spinner tells them nothing and never
      // stops. Clamped at zero because a tick can land past the deadline.
      const left = elapsed(now, phase.deadline);
      const remaining = (left > 0 ? left : 0) as Duration;
      return {
        shown: policy.optimistic ? phase.target : observed,
        confidence: 'unconfirmed',
        widget,
        pending: { target: phase.target, remaining },
        fault: null,
      };
    }

    case 'CONVERGED':
      return {
        shown: phase.target,
        // The distinction a UI should surface: an exact confirmation from a
        // device that counts, versus an inference from a clock estimate inside
        // bounds somebody declared. Both are "confirmed"; only one is certain.
        confidence:
          phase.generation !== null && obs.observedGeneration !== null
            ? 'confirmed-exact'
            : 'confirmed-estimated',
        widget,
        pending: null,
        fault: null,
      };

    case 'FAILED':
      // Show what the device last actually said, not what was asked for. A
      // failed command must not leave its target on screen looking like state.
      return { shown: observed, confidence: 'failed', widget, pending: null, fault: lastFault };

    case 'SUSPENDED':
      return { shown: observed, confidence: 'stale', widget, pending: null, fault: null };

    case 'IDLE':
      return {
        shown: observed,
        confidence: assumed ? 'assumed' : 'confirmed-estimated',
        widget,
        pending: null,
        fault: null,
      };
  }
}

/** One line for a terminal or a log. The UI gets the structure; humans get this. */
export function describe(view: DeviceView): string {
  const state = view.shown ? 'charging' : 'not charging';
  const pending =
    view.pending === null
      ? ''
      : `, confirming ${view.pending.target ? 'start' : 'stop'} (${Math.ceil(view.pending.remaining / 1000)}s left)`;
  const fault = view.fault === null ? '' : `, fault: ${view.fault}`;
  return `${state} [${view.confidence}, ${view.widget}]${pending}${fault}`;
}
