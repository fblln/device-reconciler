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
 * reconcile.ts — the whole idea, in one pure function.
 *
 * WHY THIS EXISTS
 * ---------------
 * Consumer energy hardware — EV chargers, inverters, batteries, heat pumps, and
 * the cars themselves — is not reachable directly. You talk to a platform, which
 * talks to a manufacturer's cloud, which talks to the device. And it does so over
 * TWO SEPARATE CHANNELS:
 *
 *   command channel   you send an instruction and get an acknowledgement.
 *                     Stamped by you. Tells you the instruction was RECEIVED.
 *   telemetry channel state arrives on its own schedule, stamped by the DEVICE's
 *                     clock. Tells you what the device was doing at some past
 *                     moment, as measured by a clock that is not yours.
 *
 * Almost every bug in this domain comes from treating those as one channel.
 * They have independent latency, independent failure, independent ordering and
 * independent clocks. Specifically:
 *
 *   1. An ack is not an actuation. "ACCEPTED" means the instruction reached the
 *      device, not that the relay moved. Plenty of commands are accepted and
 *      never applied, and that is indistinguishable from slow until it isn't.
 *   2. Telemetry is POLLED or pushed on the device's terms, typically a minute
 *      or two behind, and sometimes out of order.
 *   3. The two timestamps are not comparable. The command's time is on our
 *      clock; the snapshot's capture time is on the device's. Comparing them
 *      directly is the original sin, and it is why time.ts brands them as
 *      different types so the compiler refuses.
 *
 * Which gives the question this module answers:
 *
 *      I asked the charger to start 90 seconds ago. Telemetry says "stopped",
 *      captured at a device time I cannot directly compare to my own.
 *      Is the command failing, is my data stale, or can I simply not tell yet?
 *
 * Guess "failing" and you re-send, hammering a rate-limited API that is already
 * retrying for you. Guess "stale" forever and the car silently does not charge
 * and nobody is told. Guess "it worked" because an ack came back and you will
 * report success for a command that never moved anything.
 *
 * THE RULES
 * ---------
 * Three, and the third is the one that most implementations lack:
 *
 *   R1. Evidence must post-date the action. A reading taken before the command
 *       says nothing about the command.
 *   R2. Evidence from the command channel (APPLIED / REJECTED) is authoritative
 *       and needs no correlation; evidence from telemetry needs R3.
 *   R3. Correlating telemetry with an action crosses two clocks, so it yields
 *       three answers — after, before, and CANNOT TELL. "Cannot tell" is a
 *       legitimate outcome that must be waited out, not guessed past.
 *
 * DESIGN
 * ------
 * Functional core, imperative shell. This module is pure: no clock, no I/O, no
 * randomness, no mutation of inputs, and the clock model is threaded in rather
 * than held. That is why every pathology in scenarios.ts is reproducible in a
 * unit test instead of requiring a car and a patient afternoon.
 */

import {
  assertNever,
  elapsed,
  laterDevice,
  plus,
  seconds,
  type DeviceInstant,
  type Duration,
  type Instant,
} from './time.ts';
import { type Bounds, type ClockModel } from './clock.ts';
import { correlate, type CorrelationResult, type Generation } from './correlate.ts';

export type PowerDeliveryState = 'UNPLUGGED' | 'PLUGGED_IN:STOPPED' | 'PLUGGED_IN:CHARGING';

/**
 * A telemetry snapshot. Two timestamps, deliberately, because they answer
 * different questions and conflating them is the bug:
 *
 *   deviceTime  WHEN THE STATE WAS TRUE, on the device's clock. Use for
 *               correlation and for comparing against other snapshots.
 *   receivedAt  when it reached us, on ours. Use for clock estimation and for
 *               detecting a dead feed. NEVER as a proxy for deviceTime: a
 *               snapshot received now can describe five minutes ago.
 */
export type Observation = Readonly<{
  deviceId: string;
  /** Whether the telemetry channel is live. Command-channel health shows up as reports. */
  isReachable: boolean;
  deviceTime: DeviceInstant;
  receivedAt: Instant;
  powerDeliveryState: PowerDeliveryState;
  /**
   * The generation the device says it last applied, when it reports one at all.
   * null for the many devices that do not — which selects the clock-bounds
   * fallback rather than being an error. See correlate.ts.
   */
  observedGeneration: Generation | null;
}>;

/**
 * The lifecycle the command channel reports. The ordering is meaningful and the
 * gap between ACCEPTED and APPLIED is where this domain hides its failures.
 *
 *   PENDING      queued by the platform; the device may not know yet
 *   ACCEPTED     the device acknowledged the instruction. NOT an actuation.
 *   IN_PROGRESS  the device says it is working on it and expects to finish.
 *   REJECTED     refused. The one failure the channel can state outright.
 *   APPLIED      the device says it did the thing. Authoritative when offered —
 *                and many real platforms never offer it at all, which is
 *                exactly why the telemetry path below cannot be skipped.
 *
 * IN_PROGRESS is borrowed from Azure IoT Plug and Play, whose convention has a
 * device write back a status code `ac` alongside the acknowledged version: 200
 * for accepted, 400 or 500 for refused or failed, and 202 for an update still
 * in progress that should later finish at 200. It is a real improvement on a
 * binary ack, and not because it confirms anything — it does not. Its value is
 * diagnostic. A command that times out having only ever been ACCEPTED and one
 * that times out after the device said it was working on it are different
 * faults with different owners, and a timeout that cannot tell them apart sends
 * somebody to read the wrong logs.
 *
 * The same distinction exists at the protocol level in Z-Wave's Supervision
 * command class, where a supervised SET is answered with a status saying whether
 * the command was understood AND executed; zwave-js separates "never sent",
 * "received but not executed" and "invalid value" for exactly this reason.
 */
export type CommandReportState = 'PENDING' | 'ACCEPTED' | 'IN_PROGRESS' | 'REJECTED' | 'APPLIED';

export type CommandReport = Readonly<{
  commandId: string;
  state: CommandReportState;
  at: Instant;
}>;

/**
 * Commands carry two identities, for two different jobs:
 *
 *   commandId   matches a report on the command channel to the command that
 *               caused it (the role of AWS IoT's `clientToken`).
 *   generation  monotonic desired-state counter, echoed back by devices that
 *               support it, giving exact clock-free correlation against
 *               telemetry (the role of Kubernetes' `metadata.generation`).
 */
export type Command = Readonly<{ commandId: string; generation: Generation; target: boolean }>;

export type Intent = Readonly<{ charging: boolean }>;

export type FailReason = 'timeout-unconfirmed' | 'rejected-by-vendor';

/**
 * Two timestamps per phase, on two different clocks, for two different jobs.
 *
 *   since   OUR clock: when we acted or last learned something. Used to measure
 *           deadlines and to correlate against commands.
 *   seen    the DEVICE's clock: a watermark of the newest telemetry capture this
 *           phase has already accounted for.
 *
 * The watermark is the trick that keeps most of this system exact. "Is there
 * anything new from the device?" is a question entirely inside the telemetry
 * channel, so comparing capture times answers it precisely, with no skew and no
 * 'unknown'. The lossy cross-clock estimate is then needed in exactly ONE place
 * — correlating a snapshot against a command we sent — rather than everywhere.
 *
 * `seen` is null only when we have never held a snapshot (cold start), or when
 * the command channel confirmed us without one. Those two cases are not
 * interchangeable and are handled separately below.
 */
export type Phase = Readonly<
  | { phase: 'IDLE'; since: Instant; seen: DeviceInstant | null }
  | {
      /**
       * `generation` is null when we never commanded this state — the device
       * simply already matched intent when we first looked. There is then no
       * instruction of ours for a device to echo, and claiming one would let a
       * later command appear not to advance the counter.
       *
       * `seen` and `generation` are never both null: converging from a snapshot
       * always records the snapshot, and converging from the command channel
       * always records the command.
       */
      phase: 'CONVERGED';
      since: Instant;
      target: boolean;
      seen: DeviceInstant | null;
      generation: Generation | null;
    }
  | {
      phase: 'ISSUED';
      since: Instant;
      target: boolean;
      deadline: Instant;
      commandId: string;
      generation: Generation;
    }
  | { phase: 'SUSPENDED'; since: Instant; seen: DeviceInstant | null }
  | { phase: 'FAILED'; since: Instant; target: boolean; reason: FailReason }
>;

export type PhaseName = Phase['phase'];

export type Step = Readonly<{
  state: Phase;
  command: Command | null;
  why: string;
  /**
   * ADDED HERE. Which correlation branch this decision took, or null if it
   * needed none.
   *
   * The one addition to the ported core, and the reason this repository exists.
   * The sibling repo can argue in a README that correlation is tri-state and
   * that a generation echo beats a clock estimate. An operational system has to
   * be able to show how often each branch actually fires, or the argument stays
   * an argument: a zero `unknown` rate means the third state was theatre, and a
   * high clock-fallback rate is the price of the fleet's hardware, in a number
   * someone can take to a procurement meeting. See src/core/readout.ts.
   *
   * Null is meaningful and is not "no data": it marks a decision that never
   * asked the question — a telemetry outage, a rejection on the command
   * channel, an unplugged cable. Counting those in the denominator would dilute
   * both rates with decisions that could not have had an opinion.
   */
  correlation: CorrelationResult | null;
}>;

export type Options = Readonly<{
  /**
   * How long to wait for confirmation before declaring failure. Must exceed the
   * worst-case telemetry interval by a comfortable margin, or confirmations that
   * were genuinely on their way get reported as failures. A promise to a user,
   * not a technical constant.
   */
  commandTimeout: Duration;
  /**
   * Declared bounds on the device clock and the telemetry feed. Tighter bounds
   * decide more often and are wrong more often; looser ones return 'unknown'
   * and lean on the command channel. A deployment choice, not a constant.
   */
  bounds: Bounds;
}>;

export type Input = Readonly<{
  now: Instant;
  intent: Intent;
  obs: Observation;
  /** The latest report for ANY command. Matching it to ours is this module's job. */
  report: CommandReport | null;
  clock: ClockModel;
  state: Phase;
  opts: Options;
  /**
   * Identities for the next command, supplied by the shell so this function
   * stays pure and still gets to mint them.
   *
   * WHO SHOULD MINT THE GENERATION, which this shape deliberately leaves open.
   * The counter belongs to whoever serialises commands to the device, and that
   * is the PLATFORM, not a client. Kubernetes sets `metadata.generation` on the
   * object, in the API server. Azure IoT Hub manages the desired section's
   * `$version` and the device echoes it back as `av`. Both put the counter at
   * the single point every writer passes through.
   *
   * This implementation mints it in the shell (`engine.ts`), which is correct
   * only while there is exactly one reconciler per device. Two reconcilers each
   * minting their own sequence produce counters that cannot be compared, and
   * each would read the other's work as a third-party change. Against a real
   * platform, take the counter from the platform and never invent one.
   */
  next: Readonly<{ commandId: string; generation: Generation }>;
}>;

export function observedCharging(obs: Observation): boolean {
  return obs.powerDeliveryState === 'PLUGGED_IN:CHARGING';
}

export function initialPhase(now: Instant): Phase {
  // seen: null means "we have never held a snapshot", which is the one state in
  // which any reading at all is useful. It is not the same as "we hold an old
  // snapshot", and conflating the two is how a reconciler ends up acting on
  // pre-outage data the moment a feed comes back.
  return { phase: 'IDLE', since: now, seen: null };
}

/** The newest capture we hold, kept monotonic against out-of-order delivery. */
function watermark(obs: Observation, seen: DeviceInstant | null): DeviceInstant {
  return seen === null ? obs.deviceTime : laterDevice(obs.deviceTime, seen);
}

/*
 * ADDED HERE. The four constructors below leave `correlation` null and
 * `reconcile` fills it in from what was actually computed. Threading it through
 * every call site instead would mean touching all twenty-odd return statements
 * in the decision function to add a field that none of them decide — a change
 * with real risk for no benefit, on the one file in this repository that must
 * not drift from the sibling's logic.
 */
const fail = (now: Instant, target: boolean, reason: FailReason, why: string): Step => ({
  state: { phase: 'FAILED', since: now, target, reason },
  command: null,
  why,
  correlation: null,
});

const issue = (input: Input, target: boolean, why: string): Step => ({
  state: {
    phase: 'ISSUED',
    since: input.now,
    target,
    deadline: plus(input.now, input.opts.commandTimeout),
    commandId: input.next.commandId,
    generation: input.next.generation,
  },
  command: { commandId: input.next.commandId, generation: input.next.generation, target },
  why,
  correlation: null,
});

const hold = (state: Phase, why: string): Step => ({ state, command: null, why, correlation: null });

const converged = (
  now: Instant,
  target: boolean,
  seen: DeviceInstant | null,
  generation: Generation | null,
  why: string,
): Step => hold({ phase: 'CONVERGED', since: now, target, seen, generation }, why);

/** A report is ours only if the id matches. A late report from a superseded command is noise. */
function reportFor(report: CommandReport | null, commandId: string): CommandReport | null {
  return report !== null && report.commandId === commandId ? report : null;
}

/**
 * ADDED HERE. Records the correlation a decision performed, so `reconcile` can
 * report it without any call site having to carry it. A closure rather than a
 * mutable field on the input, so `reconcile` stays pure: the recorder is created
 * per call, never escapes, and the function is still a function of its
 * arguments.
 */
type Track = (r: CorrelationResult) => CorrelationResult;

/**
 * One decision. Pure, total, allocation-light.
 *
 * The wrapper exists only to attach the correlation branch taken; `decide`
 * below is the decision function as ported, unchanged.
 */
export function reconcile(input: Input): Step {
  let taken: CorrelationResult | null = null;
  const track: Track = (r) => {
    taken = r;
    return r;
  };
  const step = decide(input, track);
  return taken === null ? step : { ...step, correlation: taken };
}

function decide(input: Input, track: Track): Step {
  const { now, intent, obs, state, clock, opts } = input;

  /*
   * 1. TELEMETRY DOWN — handled before the phase switch, because it constrains
   * every phase identically: without a feed we cannot verify anything, so we
   * must not start anything new.
   *
   * Note the asymmetry. An in-flight command is NOT abandoned. The platform is
   * still retrying it, its deadline still applies, and the command channel may
   * still report on it. Dropping to IDLE on every blip would re-issue on
   * recovery and duplicate a command already in flight — the exact failure this
   * module exists to prevent.
   */
  if (!obs.isReachable) {
    if (state.phase === 'ISSUED') {
      const mine = reportFor(input.report, state.commandId);
      // The command channel can still speak while telemetry is dark, and when it
      // does it outranks everything: it is first-hand and needs no correlation.
      if (mine?.state === 'REJECTED') {
        return fail(
          now,
          state.target,
          'rejected-by-vendor',
          'command channel rejected it during a telemetry outage',
        );
      }
      if (mine?.state === 'APPLIED') {
        return converged(
          now,
          state.target,
          null,
          state.generation,
          'command channel confirmed it applied, despite the telemetry outage',
        );
      }
      return now >= state.deadline
        ? fail(now, state.target, 'timeout-unconfirmed', 'deadline passed while telemetry was down')
        : hold(state, 'telemetry down; command still in flight and its deadline still running');
    }
    return state.phase === 'SUSPENDED'
      ? hold(state, 'still no telemetry')
      : hold(
          // Carry the watermark into the outage. It is what makes recovery
          // exact: on the way out we can tell a genuinely new capture from the
          // frozen pre-outage one we have been staring at the whole time.
          { phase: 'SUSPENDED', since: now, seen: currentSeen(state, obs) },
          'no telemetry; refusing to issue blind',
        );
  }

  switch (state.phase) {
    /*
     * 2. RECOVERY. We deliberately do NOT act on the snapshot we are holding: it
     * may predate the outage entirely. Resetting `since` to now means the next
     * decision needs a genuinely new reading, which costs one telemetry cycle
     * and buys correctness.
     */
    case 'SUSPENDED':
      return hold(
        { phase: 'IDLE', since: now, seen: state.seen },
        'telemetry back; waiting for a capture newer than the one we went dark holding',
      );

    /*
     * 3. AWAITING CONFIRMATION — the whole reason for the module.
     */
    case 'ISSUED': {
      // An intent change supersedes. The ONLY path that issues while a command
      // is outstanding, and legitimate: the old target is no longer wanted.
      if (intent.charging !== state.target) {
        return issue(input, intent.charging, `intent changed to ${intent.charging} mid-flight; superseding`);
      }

      const mine = reportFor(input.report, state.commandId);

      // R2: the command channel is authoritative when it has something real to
      // say. REJECTED is the only crisp failure this system can ever observe —
      // everything else has to be inferred from a timeout.
      if (mine?.state === 'REJECTED') {
        return fail(now, state.target, 'rejected-by-vendor', 'command channel rejected the command');
      }
      if (mine?.state === 'APPLIED') {
        return converged(now, state.target, null, state.generation, 'command channel reports applied');
      }

      if (now >= state.deadline) {
        /*
         * Three different faults, three different messages. "Timeout" alone
         * sends an operator to the network; each of these points somewhere
         * specific, and the command channel is the only thing that can tell
         * them apart:
         *
         *   silence      the instruction may never have arrived. Look at
         *                connectivity and at the platform's queue.
         *   acknowledged it arrived and nothing happened. Look at the device.
         *   in progress  the device said it was working and never finished.
         *                Look at the device's own error state; it knows
         *                something it has not told us.
         */
        return fail(now, state.target, 'timeout-unconfirmed', explainTimeout(mine?.state));
      }

      /*
       * R3: correlate telemetry against the command. Exact if the device echoes
       * a generation, an interval estimate if it does not — and in the second
       * case the answer may legitimately be "cannot tell yet". Each outcome
       * gets its own explanation, because an operator debugging this needs to
       * know WHICH kind of ignorance they are in.
       */
      const result = track(
        correlate(obs.observedGeneration, state.generation, obs.deviceTime, state.since, clock, opts.bounds),
      );
      if (result.correlation === 'after') {
        return observedCharging(obs) === state.target
          ? converged(
              now,
              state.target,
              obs.deviceTime,
              state.generation,
              result.source === 'generation'
                ? `device reports it applied generation ${state.generation}; confirmed exactly`
                : 'telemetry provably captured after the command confirms it',
            )
          : hold(
              state,
              result.source === 'generation'
                ? `device applied generation ${state.generation} and still disagrees; platform retries until the deadline`
                : 'telemetry captured after the command still disagrees; platform retries until the deadline',
            );
      }
      return hold(state, explainIndecision(result, input, state.generation));
    }

    /*
     * 4. TERMINAL. A failure stays visible until the intent changes. No silent
     * retry: if neither channel could confirm inside a generous window, the
     * honest move is to surface it, not to keep poking and hope.
     */
    case 'FAILED':
      return intent.charging !== state.target
        ? issue(input, intent.charging, 'new intent after failure')
        : hold(state, `terminal: ${state.reason}; waiting for a new intent`);

    /*
     * 5. STEADY STATE, and drift detection — the case that justifies a loop over
     * a fire-and-forget call. A charger can stop on its own, or a human can
     * press a button, and nothing will tell us except the next snapshot.
     */
    case 'IDLE':
    case 'CONVERGED': {
      const freshness = telemetryFreshness(obs, state, clock, opts.bounds, track);
      if (freshness !== 'fresh') {
        return hold(state, freshness);
      }

      if (obs.powerDeliveryState === 'UNPLUGGED') {
        // Not our failure. The cable is a human's business, and reporting it as
        // a command failure trains people to ignore our alerts.
        return hold(state, 'unplugged; nothing to converge');
      }

      const seen = currentSeen(state, obs);

      if (observedCharging(obs) === intent.charging) {
        return converged(
          now,
          intent.charging,
          seen,
          // No command was issued to reach this, so there is no generation to
          // claim. See the note on the CONVERGED phase.
          state.phase === 'CONVERGED' ? state.generation : null,
          state.phase === 'CONVERGED' ? 'still converged' : 'already matches intent; nothing to do',
        );
      }

      /*
       * WHO MOVED IT. A command advances the generation; a human at the panel
       * does not. So a fresh reading that disagrees with intent while reporting
       * the SAME generation we last converged at is positive evidence that
       * somebody else changed the device — exact, same-channel, no clock
       * involved. It is strictly better than inferring "drift" from the state
       * alone, which cannot tell a third party apart from our own command
       * finally landing.
       *
       * This only names the cause. Deciding what to do about it is a policy
       * this module does not have: see the override note in the README. Fighting
       * a human is right for a charger on a tariff and wrong for someone who
       * just turned the heating up, and nothing in a state machine can tell you
       * which. Naming it is the honest half that can be done here.
       */
      const thirdParty =
        state.phase === 'CONVERGED' &&
        state.generation !== null &&
        obs.observedGeneration !== null &&
        obs.observedGeneration === state.generation;

      return issue(
        input,
        intent.charging,
        thirdParty
          ? `state changed while the device is still on generation ${state.generation}, so something other than us moved it; re-issuing intent`
          : state.phase === 'CONVERGED'
            ? 'device drifted away from a confirmed state; re-issuing'
            : 'state differs from intent; converging',
      );
    }

    default:
      return assertNever(state, 'reconcile');
  }
}

/** The watermark a phase is carrying, or the current capture if it carries none. */
function currentSeen(state: Phase, obs: Observation): DeviceInstant {
  return 'seen' in state ? watermark(obs, state.seen) : obs.deviceTime;
}

/**
 * Do we have telemetry worth acting on? Returns 'fresh', or the reason not.
 *
 * Three cases, and they are genuinely different questions rather than three
 * spellings of one:
 *
 *   watermark held   exact same-clock comparison. No skew, no ambiguity. This
 *                    is the common path, and the reason the watermark exists.
 *   cold start       we have never held a snapshot, so any reading tells us
 *                    something we did not know. Being strict here would stall
 *                    every boot for a full telemetry cycle for no benefit.
 *   confirmed by the the command channel told us the command applied, so there
 *   command channel  is no snapshot to compare against and we must fall back to
 *                    the cross-clock estimate. Treating "any reading" as fresh
 *                    here would let a snapshot captured BEFORE the command look
 *                    like drift and trigger a pointless re-issue.
 */
function telemetryFreshness(
  obs: Observation,
  state: Extract<Phase, { phase: 'IDLE' | 'CONVERGED' }>,
  clock: ClockModel,
  bounds: Bounds,
  track: Track,
): 'fresh' | string {
  if (state.seen !== null) {
    return obs.deviceTime > state.seen ? 'fresh' : 'nothing captured since the snapshot we already acted on';
  }
  if (state.phase === 'IDLE') return 'fresh';
  if (state.generation === null) {
    // Unreachable by construction: CONVERGED never holds both a null watermark
    // and a null generation. Handled rather than asserted because a control
    // loop should degrade to doing nothing, not throw, if that ever changes.
    return 'no basis to judge freshness: neither a watermark nor a generation';
  }
  return track(
    correlate(obs.observedGeneration, state.generation, obs.deviceTime, state.since, clock, bounds),
  ).correlation === 'after'
    ? 'fresh'
    : 'command channel confirmed us, and no snapshot is provably newer than that confirmation';
}

/**
 * Names which of the three timeout faults this is. See the call site.
 *
 * Exported for its own unit test. Two of its arms are unreachable through
 * `reconcile`, because APPLIED and REJECTED leave ISSUED the moment they are
 * seen, and testing a total function directly is cheaper and clearer than
 * contorting the state machine to reach them.
 */
export function explainTimeout(reported: CommandReportState | undefined): string {
  switch (reported) {
    case 'IN_PROGRESS':
      return 'device reported it was working on the command and never finished before the deadline';
    case 'ACCEPTED':
      return 'acknowledged but never observed to take effect before the deadline';
    case 'APPLIED':
    case 'REJECTED':
      // Unreachable: both are handled above and leave ISSUED immediately.
      return 'reached the deadline despite a terminal report, which should not happen';
    case 'PENDING':
    case undefined:
      return 'no confirmation from either channel before the deadline';
    default:
      return assertNever(reported, 'explainTimeout');
  }
}

/**
 * Distinguishes the kinds of "I cannot act on this yet", which debug very
 * differently: a stale snapshot resolves itself on the next capture, while an
 * unresolvable interval means the declared bounds are too loose for this feed
 * and the operator should either tighten them or get a device that counts.
 */
function explainIndecision(result: CorrelationResult, input: Input, target: Generation): string {
  if (result.source === 'generation') {
    return `device has only applied up to generation ${input.obs.observedGeneration}, not ${target}; not evidence, not re-issuing`;
  }
  if (result.correlation === 'before') {
    const lag = seconds(elapsed(input.obs.receivedAt, input.now));
    return `telemetry predates the command (arrived ${lag}s ago, captured earlier still); not evidence, not re-issuing`;
  }
  return input.clock.minDelay === null
    ? 'cannot correlate telemetry with the command yet: no clock estimate from this device'
    : `cannot correlate telemetry with the command: its capture falls inside the ±${seconds(input.opts.bounds.skewBound)}s skew and ${seconds(input.opts.bounds.maxLatency)}s latency bounds around when we acted`;
}
