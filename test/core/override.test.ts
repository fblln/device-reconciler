/**
 * Override precedence — who wins when a human at the device disagrees with a
 * schedule. The policy itself is one defensible answer rather than the answer,
 * which is exactly why it is a pure function with its own tests: the behaviour
 * is arguable, so it had better be legible and changeable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { movedByOther, resolve, type OverrideConfig, type StoredIntent } from '../../src/core/override.ts';
import { charging, converged, D, DT, G, idle, obs, stopped, T } from './_world.ts';

const cfg: OverrideConfig = { localHold: D(900_000), operatorFreshness: D(300_000) };

const schedule = (chargingWanted: boolean, setAt = 0): StoredIntent => ({
  charging: chargingWanted,
  source: 'schedule',
  setAt: T(setAt),
});
const operator = (chargingWanted: boolean, setAt = 0): StoredIntent => ({
  charging: chargingWanted,
  source: 'operator',
  setAt: T(setAt),
});

// ---------------------------------------------------------------------------
// Detection. The evidence is exact and it is perishable, which is why the shell
// has to persist the moment it was seen.
// ---------------------------------------------------------------------------

test('a device still on the generation we converged at, now disagreeing, was moved by somebody else', () => {
  assert.equal(
    movedByOther(
      converged({ target: true, generation: G(3) }),
      obs({ observedGeneration: G(3), powerDeliveryState: stopped }),
    ),
    true,
  );
});

test('a device that agrees with us was not moved, whatever generation it reports', () => {
  assert.equal(
    movedByOther(
      converged({ target: true, generation: G(3) }),
      obs({ observedGeneration: G(3), powerDeliveryState: charging }),
    ),
    false,
  );
});

test('a device that has moved PAST our generation is our own command landing, not a third party', () => {
  assert.equal(
    movedByOther(
      converged({ target: true, generation: G(3) }),
      obs({ observedGeneration: G(4), powerDeliveryState: stopped }),
    ),
    false,
  );
});

test('a device reporting no counter can never be proved to have been moved by anyone', () => {
  // The honest answer, and the reason this is detection rather than inference:
  // without a counter, "somebody else moved it" and "our command finally
  // landed and then it drifted" are the same observation.
  assert.equal(
    movedByOther(
      converged({ target: true, generation: G(3) }),
      obs({ observedGeneration: null, powerDeliveryState: stopped }),
    ),
    false,
  );
});

test('only a CONVERGED phase carries the generation the evidence needs', () => {
  assert.equal(movedByOther(idle(DT(0)), obs({ observedGeneration: G(1) })), false);
  assert.equal(movedByOther(converged({ generation: null }), obs({ observedGeneration: G(1) })), false);
});

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

test('with no local change, intent is asserted and nothing is held', () => {
  const r = resolve(schedule(true), null, false, T(0), cfg);
  assert.deepEqual(r, {
    intent: { charging: true },
    outcome: 'assert',
    why: 'asserting schedule intent',
    holdUntil: null,
  });
});

test('a local change outranks a schedule for the hold window, and the loop stops fighting it', () => {
  const r = resolve(schedule(true), T(0), false, T(60_000), cfg);
  assert.equal(r.outcome, 'hold');
  // The intent handed to the decision function is the OBSERVED state, so the
  // device looks converged and no command is issued. Returning the stored
  // intent would mean the loop keeps commanding while we claim to be deferring.
  assert.deepEqual(r.intent, { charging: false });
  assert.equal(r.holdUntil, 900_000);
  assert.match(r.why, /outranks schedule intent for another 840s/);
});

test('the hold is bounded: a schedule abandoned forever by one button press is broken', () => {
  const r = resolve(schedule(true), T(0), false, T(900_000), cfg);
  assert.equal(r.outcome, 'assert');
  assert.deepEqual(r.intent, { charging: true });
  assert.equal(r.holdUntil, null);
  assert.match(r.why, /expired; resuming schedule intent/);
});

test('a local change that agrees with us is not an override at all', () => {
  // Holding here would defer a schedule for no reason — the device is already
  // where we want it.
  const r = resolve(schedule(true), T(0), true, T(60_000), cfg);
  assert.equal(r.outcome, 'assert');
  assert.match(r.why, /agrees with intent/);
});

test('a fresh operator request against a local change is a conflict, resolved by neither', () => {
  // Server-side apply's answer: two deliberate writers disagreeing is reported
  // to whoever owns the field, not settled by whichever wrote last.
  const r = resolve(operator(true, 0), T(0), false, T(120_000), cfg);
  assert.equal(r.outcome, 'conflict');
  assert.deepEqual(r.intent, { charging: false }, 'a conflict must issue no commands');
  assert.equal(r.holdUntil, 900_000);
  assert.match(r.why, /contradicts an operator request made 120s ago/);
});

test('an operator request that has gone stale is a standing instruction, and a person wins', () => {
  const r = resolve(operator(true, 0), T(0), false, T(300_001), cfg);
  assert.equal(r.outcome, 'hold');
});

test('freshness is inclusive at the boundary', () => {
  assert.equal(resolve(operator(true, 0), T(0), false, T(300_000), cfg).outcome, 'conflict');
});

test('a schedule is never fresh enough to outrank a person, however recently it was written', () => {
  // The source is what matters, not the timestamp: a tariff plan written one
  // second ago is still a machine's opinion about a device somebody is standing
  // next to.
  const r = resolve(schedule(true, 119_000), T(0), false, T(120_000), cfg);
  assert.equal(r.outcome, 'hold');
});
