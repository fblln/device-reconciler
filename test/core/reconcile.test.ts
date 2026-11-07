/**
 * The decision function, one world and one decision per test, every test named
 * after the RULE it pins rather than the mechanics it exercises.
 *
 * Every case runs through `reconcileChecked`, so the contracts in contracts.ts
 * are asserted on every decision here as well as in the property test. A unit
 * test that passed while violating an invariant would be worse than no test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileChecked } from '../../src/core/contracts.ts';
import { explainTimeout, initialPhase, observedCharging } from '../../src/core/reconcile.ts';
import {
  charging,
  clockWith,
  converged,
  D,
  DT,
  G,
  idle,
  input,
  issued,
  obs,
  report,
  stopped,
  T,
  unplugged,
} from './_world.ts';

test('a cold start holds no watermark, so any first reading is admissible', () => {
  assert.deepEqual(initialPhase(T(7)), { phase: 'IDLE', since: 7, seen: null });
});

test('observedCharging reads only the charging state, not merely being plugged in', () => {
  assert.equal(observedCharging(obs({ powerDeliveryState: charging })), true);
  assert.equal(observedCharging(obs({ powerDeliveryState: stopped })), false);
  assert.equal(observedCharging(obs({ powerDeliveryState: unplugged })), false);
});

// ---------------------------------------------------------------------------
// Telemetry down. The asymmetry is the rule: nothing new is started, and
// nothing in flight is abandoned.
// ---------------------------------------------------------------------------

test('a dark feed never issues a command, however far the device is from intent', () => {
  const step = reconcileChecked(
    input({ obs: obs({ isReachable: false, powerDeliveryState: stopped }), intent: { charging: true } }),
  );
  assert.equal(step.command, null);
  assert.equal(step.state.phase, 'SUSPENDED');
});

test('going dark carries the watermark into the outage', () => {
  // This is what makes recovery exact rather than hopeful: on the way out we can
  // tell a genuinely new capture from the frozen pre-outage one.
  const step = reconcileChecked(
    input({ state: idle(DT(500)), obs: obs({ isReachable: false, deviceTime: DT(200) }) }),
  );
  assert.deepEqual(step.state, { phase: 'SUSPENDED', since: 1_000, seen: 500 });
});

test('a dark feed does not abandon an in-flight command or its deadline', () => {
  const step = reconcileChecked(input({ state: issued(), obs: obs({ isReachable: false }) }));
  assert.equal(step.command, null);
  assert.deepEqual(step.state, issued(), 'the phase, deadline and command id must all survive');
});

test('the command channel outranks a telemetry outage in both directions', () => {
  const dark = obs({ isReachable: false });
  const applied = reconcileChecked(
    input({ state: issued(), obs: dark, report: report({ state: 'APPLIED' }) }),
  );
  assert.equal(applied.state.phase, 'CONVERGED');
  const rejected = reconcileChecked(
    input({ state: issued(), obs: dark, report: report({ state: 'REJECTED' }) }),
  );
  assert.equal(rejected.state.phase, 'FAILED');
});

test('a deadline still expires while telemetry is down', () => {
  const step = reconcileChecked(
    input({ now: T(180_000), state: issued(), obs: obs({ isReachable: false }) }),
  );
  assert.equal(step.state.phase, 'FAILED');
  assert.match(step.why, /telemetry was down/);
});

test('a second dark tick holds SUSPENDED rather than re-entering it', () => {
  const prior = { phase: 'SUSPENDED', since: T(0), seen: DT(500) } as const;
  const step = reconcileChecked(input({ state: prior, obs: obs({ isReachable: false }) }));
  assert.equal(step.state, prior, 'holding must not re-date the phase');
});

test('recovery waits for a capture newer than the one we went dark holding', () => {
  // Deliberately NOT acting on the held snapshot: it may predate the outage
  // entirely. One telemetry cycle is the price of not acting on stale data.
  const step = reconcileChecked(
    input({ state: { phase: 'SUSPENDED', since: T(0), seen: DT(500) }, obs: obs({ deviceTime: DT(500) }) }),
  );
  assert.deepEqual(step.state, { phase: 'IDLE', since: 1_000, seen: 500 });
  assert.equal(step.command, null);
});

// ---------------------------------------------------------------------------
// Awaiting confirmation.
// ---------------------------------------------------------------------------

test('an intent change mid-flight is the only thing that supersedes a command', () => {
  const step = reconcileChecked(
    input({
      state: issued({ target: true }),
      intent: { charging: false },
      next: { commandId: 'dev-1/2', generation: G(2) },
    }),
  );
  assert.deepEqual(step.command, { commandId: 'dev-1/2', generation: 2, target: false });
});

test('an ack is not an actuation: ACCEPTED confirms nothing', () => {
  const step = reconcileChecked(input({ state: issued(), report: report({ state: 'ACCEPTED' }) }));
  assert.equal(step.state.phase, 'ISSUED');
  assert.equal(step.command, null);
});

test('a report for a different command is noise, not evidence', () => {
  // A late report from a superseded command would otherwise converge or fail
  // the one currently in flight.
  const step = reconcileChecked(
    input({
      state: issued({ commandId: 'dev-1/2' }),
      report: report({ commandId: 'dev-1/1', state: 'APPLIED' }),
    }),
  );
  assert.equal(step.state.phase, 'ISSUED');
});

test('APPLIED converges without any telemetry at all', () => {
  const step = reconcileChecked(input({ state: issued(), report: report({ state: 'APPLIED' }) }));
  assert.deepEqual(step.state, {
    phase: 'CONVERGED',
    since: 1_000,
    target: true,
    // No snapshot was involved, so there is no watermark to claim. Claiming the
    // current capture here would let a reading from before the command pass as
    // the one that confirmed it.
    seen: null,
    generation: 1,
  });
});

test('telemetry provably after the command, and agreeing, confirms it', () => {
  const step = reconcileChecked(
    input({
      now: T(400_000),
      state: issued({ since: T(1_000), deadline: T(900_000) }),
      obs: obs({ deviceTime: DT(300_000), receivedAt: T(400_000), powerDeliveryState: charging }),
      clock: clockWith(1_000),
      // Tight bounds, so the interval is decidable at all. See clock.test.ts.
      opts: { commandTimeout: D(900_000), bounds: { skewBound: D(1_000), maxLatency: D(10_000) } },
    }),
  );
  assert.equal(step.state.phase, 'CONVERGED');
  assert.equal(step.correlation?.source, 'clock');
});

test('a generation echo confirms exactly, and says which generation', () => {
  const step = reconcileChecked(
    input({
      state: issued({ generation: G(4) }),
      obs: obs({ observedGeneration: G(4), powerDeliveryState: charging }),
    }),
  );
  assert.equal(step.state.phase, 'CONVERGED');
  assert.deepEqual(step.correlation, { correlation: 'after', source: 'generation' });
  assert.match(step.why, /applied generation 4; confirmed exactly/);
});

test('a device that applied our generation and still disagrees is not converged', () => {
  // The platform is still retrying; the deadline is what ends this, not a guess.
  const step = reconcileChecked(
    input({
      state: issued({ generation: G(4), target: true }),
      obs: obs({ observedGeneration: G(4), powerDeliveryState: stopped }),
    }),
  );
  assert.equal(step.state.phase, 'ISSUED');
  assert.equal(step.command, null);
  assert.match(step.why, /still disagrees/);
});

test('a device still behind our generation is not evidence and is not re-issued', () => {
  const step = reconcileChecked(
    input({ state: issued({ generation: G(4) }), obs: obs({ observedGeneration: G(3) }) }),
  );
  assert.equal(step.state.phase, 'ISSUED');
  assert.match(step.why, /only applied up to generation 3, not 4/);
});

test('telemetry predating the command is named as such, not treated as failure', () => {
  const step = reconcileChecked(
    input({
      now: T(200_000),
      state: issued({ since: T(190_000), deadline: T(370_000) }),
      obs: obs({ deviceTime: DT(0), receivedAt: T(199_000) }),
      clock: clockWith(1_000),
    }),
  );
  assert.equal(step.state.phase, 'ISSUED');
  assert.match(step.why, /telemetry predates the command/);
  assert.deepEqual(step.correlation, { correlation: 'before', source: 'clock' });
});

test('an undecidable interval is reported as undecidable, with the bounds named', () => {
  const step = reconcileChecked(
    input({
      now: T(100_000),
      state: issued({ since: T(100_000), deadline: T(280_000) }),
      obs: obs({ deviceTime: DT(99_000), receivedAt: T(100_000) }),
      clock: clockWith(1_000),
    }),
  );
  assert.deepEqual(step.correlation, { correlation: 'unknown', source: 'clock' });
  assert.match(step.why, /±30s skew and 120s latency bounds/);
});

test('with no clock sample yet, the indecision says so specifically', () => {
  const step = reconcileChecked(input({ state: issued(), obs: obs({ deviceTime: DT(0) }) }));
  assert.match(step.why, /no clock estimate from this device/);
});

// ---------------------------------------------------------------------------
// Timeouts. Three faults with three different owners.
// ---------------------------------------------------------------------------

test('each timeout names which of the three faults it was', () => {
  assert.match(explainTimeout(undefined), /no confirmation from either channel/);
  assert.match(explainTimeout('PENDING'), /no confirmation from either channel/);
  assert.match(explainTimeout('ACCEPTED'), /acknowledged but never observed to take effect/);
  assert.match(explainTimeout('IN_PROGRESS'), /was working on the command and never finished/);
  // Both of these leave ISSUED the moment they are seen, so reconcile can never
  // reach them. Tested directly because a total function is cheaper to test
  // than a state machine contorted into an impossible state.
  assert.match(explainTimeout('APPLIED'), /should not happen/);
  assert.match(explainTimeout('REJECTED'), /should not happen/);
});

test('explainTimeout is total: an unknown report state throws rather than guessing', () => {
  assert.throws(() => explainTimeout('TELEPORTED' as never), /explainTimeout/);
});

test('a timeout after only an ack points at the device, not the network', () => {
  const step = reconcileChecked(
    input({ now: T(180_000), state: issued(), report: report({ state: 'ACCEPTED' }) }),
  );
  assert.deepEqual(step.state, {
    phase: 'FAILED',
    since: 180_000,
    target: true,
    reason: 'timeout-unconfirmed',
  });
});

test('a rejection is the one crisp failure the system can observe', () => {
  const step = reconcileChecked(input({ state: issued(), report: report({ state: 'REJECTED' }) }));
  assert.deepEqual(step.state, {
    phase: 'FAILED',
    since: 1_000,
    target: true,
    reason: 'rejected-by-vendor',
  });
});

// ---------------------------------------------------------------------------
// Terminal and steady state.
// ---------------------------------------------------------------------------

test('a failure is terminal until the intent changes — no silent retry', () => {
  const failed = { phase: 'FAILED', since: T(0), target: true, reason: 'timeout-unconfirmed' } as const;
  const held = reconcileChecked(input({ state: failed, intent: { charging: true } }));
  assert.equal(held.command, null);
  assert.equal(held.state, failed);

  const retried = reconcileChecked(
    input({ state: failed, intent: { charging: false }, next: { commandId: 'dev-1/2', generation: G(2) } }),
  );
  assert.deepEqual(retried.command, { commandId: 'dev-1/2', generation: 2, target: false });
});

test('a device already matching intent needs no command', () => {
  const step = reconcileChecked(
    input({ obs: obs({ powerDeliveryState: charging }), intent: { charging: true } }),
  );
  assert.equal(step.command, null);
  assert.deepEqual(step.state, {
    phase: 'CONVERGED',
    since: 1_000,
    target: true,
    seen: 0,
    // No command was issued to reach this, so there is no generation to claim.
    generation: null,
  });
});

test('a device differing from intent is converged with a fresh command', () => {
  const step = reconcileChecked(
    input({ obs: obs({ powerDeliveryState: stopped }), intent: { charging: true } }),
  );
  assert.deepEqual(step.command, { commandId: 'dev-1/1', generation: 1, target: true });
  assert.equal(step.state.phase, 'ISSUED');
  assert.match(step.why, /state differs from intent/);
});

test('an unplugged device is not our failure and is not commanded', () => {
  const step = reconcileChecked(input({ obs: obs({ powerDeliveryState: unplugged }) }));
  assert.equal(step.command, null);
  assert.match(step.why, /unplugged; nothing to converge/);
});

test('nothing newer than the watermark is not news, and costs no decision', () => {
  const prior = converged({ seen: DT(500) });
  const step = reconcileChecked(
    input({ state: prior, obs: obs({ deviceTime: DT(500), powerDeliveryState: stopped }) }),
  );
  assert.equal(step.state, prior);
  assert.match(step.why, /nothing captured since the snapshot we already acted on/);
});

test('an out-of-order snapshot cannot lower the watermark', () => {
  const step = reconcileChecked(
    input({
      state: converged({ seen: DT(500), target: true }),
      obs: obs({ deviceTime: DT(900), powerDeliveryState: 'PLUGGED_IN:CHARGING' }),
    }),
  );
  assert.equal(step.state.phase, 'CONVERGED');
  // Then an older capture arrives and must change nothing.
  const back = reconcileChecked(
    input({ state: step.state, obs: obs({ deviceTime: DT(600), powerDeliveryState: stopped }) }),
  );
  assert.equal(back.command, null);
});

test('drift away from a confirmed state is re-issued', () => {
  const step = reconcileChecked(
    input({
      state: converged({ seen: DT(0), target: true, generation: null }),
      obs: obs({ deviceTime: DT(500), powerDeliveryState: stopped }),
      intent: { charging: true },
    }),
  );
  assert.match(step.why, /drifted away from a confirmed state/);
  assert.equal(step.state.phase, 'ISSUED');
});

test('a device still on the generation we converged at was moved by somebody else', () => {
  // The exact evidence: a command advances the generation, a human at the panel
  // does not. Same channel, same clock, no estimate involved.
  const step = reconcileChecked(
    input({
      state: converged({ seen: DT(0), target: true, generation: G(3) }),
      obs: obs({ deviceTime: DT(500), powerDeliveryState: stopped, observedGeneration: G(3) }),
      intent: { charging: true },
      next: { commandId: 'dev-1/4', generation: G(4) },
    }),
  );
  assert.match(step.why, /still on generation 3, so something other than us moved it/);
});

test('a command-channel confirmation with no snapshot still refuses stale telemetry', () => {
  // CONVERGED via APPLIED holds a generation and no watermark, so freshness has
  // to fall back to the cross-clock estimate. Treating "any reading" as fresh
  // here would read a snapshot captured BEFORE the command as drift and
  // re-issue a command that already worked.
  const step = reconcileChecked(
    input({
      now: T(200_000),
      state: { phase: 'CONVERGED', since: T(190_000), target: true, seen: null, generation: G(2) },
      obs: obs({ deviceTime: DT(0), receivedAt: T(199_000), powerDeliveryState: stopped }),
      clock: clockWith(1_000),
      intent: { charging: true },
    }),
  );
  assert.equal(step.command, null);
  assert.match(step.why, /no snapshot is provably newer than that confirmation/);
});

test('a re-confirmation from a newer capture keeps the generation it was confirmed at', () => {
  const step = reconcileChecked(
    input({
      state: converged({ seen: DT(0), target: true, generation: G(2) }),
      obs: obs({ deviceTime: DT(500), powerDeliveryState: charging, observedGeneration: G(2) }),
      intent: { charging: true },
    }),
  );
  assert.deepEqual(step.state, {
    phase: 'CONVERGED',
    since: 1_000,
    target: true,
    seen: 500,
    generation: 2,
  });
  assert.match(step.why, /still converged/);
});

test('an unhandled phase throws rather than silently doing nothing', () => {
  assert.throws(
    () => reconcileChecked(input({ state: { phase: 'ASLEEP', since: T(0) } as never })),
    /reconcile/,
  );
});

test('a CONVERGED row with neither a watermark nor a generation degrades to doing nothing', () => {
  /*
   * `reconcile` calls this combination unreachable by construction, and in the
   * sibling repository it is: converging from a snapshot always records the
   * snapshot, and converging from the command channel always records the
   * command. Here it is weaker than that, which is why this test exists.
   *
   * In this repository the phase is jsonb, parsed back out of Postgres (see
   * src/store/devices.ts), so it was written by an EARLIER VERSION of this
   * program. A rolling deploy, or a phase variant that gains a field, can
   * produce a row no current code path would ever construct. The defensive
   * branch is the right call for a control loop — degrade to doing nothing
   * rather than throw — and a branch that cannot be reached from the type
   * system can still be reached from the database, so it gets a test.
   */
  const step = reconcileChecked(
    input({
      state: { phase: 'CONVERGED', since: T(0), target: true, seen: null, generation: null },
      obs: obs({ deviceTime: DT(500), powerDeliveryState: stopped }),
      intent: { charging: true },
    }),
  );
  assert.equal(step.command, null, 'a row we cannot judge must not be commanded');
  assert.match(step.why, /neither a watermark nor a generation/);
});
