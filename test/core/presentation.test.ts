/**
 * The view model. Every test here is a claim about what a UI is allowed to say,
 * which is a different question from what the loop should do — and the reason
 * these are separate modules.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe, present, type Policy } from '../../src/core/presentation.ts';
import { charging, clockWith, converged, DT, G, idle, issued, noClock, obs, stopped, T } from './_world.ts';

const careful: Policy = { optimistic: false };
const optimistic: Policy = { optimistic: true };

test('a device nothing has ever been correlatable from gets buttons, not a toggle', () => {
  // A toggle is a claim that you know the current state and are flipping it.
  // Buttons make no such claim, and the widget shape is the cheapest honesty
  // available in an interface.
  const view = present(T(0), idle(), obs({ observedGeneration: null }), noClock, careful, null);
  assert.equal(view.widget, 'buttons');
  assert.equal(view.confidence, 'assumed');
});

test('one clock sample is enough to stop assuming', () => {
  const view = present(T(0), idle(), obs(), clockWith(1_000), careful, null);
  assert.equal(view.widget, 'toggle');
  assert.equal(view.confidence, 'confirmed-estimated');
});

test('a device that reports a counter is never assumed, even with no clock sample', () => {
  const view = present(T(0), idle(), obs({ observedGeneration: G(1) }), noClock, careful, null);
  assert.equal(view.widget, 'toggle');
});

test('an in-flight command carries a countdown, not a spinner', () => {
  const view = present(T(10_000), issued({ deadline: T(300_000) }), obs(), clockWith(1), careful, null);
  assert.equal(view.confidence, 'unconfirmed');
  assert.deepEqual(view.pending, { target: true, remaining: 290_000 });
});

test('the countdown is clamped at zero, because a tick can land past the deadline', () => {
  const view = present(T(400_000), issued({ deadline: T(300_000) }), obs(), clockWith(1), careful, null);
  assert.deepEqual(view.pending, { target: true, remaining: 0 });
});

test('the two policies differ only mid-flight, and that is the whole product decision', () => {
  const state = issued({ target: true, deadline: T(300_000) });
  const stoppedObs = obs({ powerDeliveryState: stopped });
  assert.equal(present(T(0), state, stoppedObs, clockWith(1), careful, null).shown, false);
  assert.equal(present(T(0), state, stoppedObs, clockWith(1), optimistic, null).shown, true);
});

test('a generation echo is shown as exact, a clock inference as estimated', () => {
  const exact = present(
    T(0),
    converged({ generation: G(2) }),
    obs({ observedGeneration: G(2), powerDeliveryState: charging }),
    clockWith(1),
    careful,
    null,
  );
  assert.equal(exact.confidence, 'confirmed-exact');

  const estimated = present(
    T(0),
    converged({ generation: G(2) }),
    obs({ observedGeneration: null, powerDeliveryState: charging }),
    clockWith(1),
    careful,
    null,
  );
  assert.equal(estimated.confidence, 'confirmed-estimated');
});

test('a convergence we never commanded is estimated, not exact', () => {
  // generation null means the device simply already matched intent when we
  // first looked. There was no instruction of ours for it to echo, so there is
  // nothing exact about it.
  const view = present(
    T(0),
    converged({ generation: null }),
    obs({ observedGeneration: G(5), powerDeliveryState: charging }),
    clockWith(1),
    careful,
    null,
  );
  assert.equal(view.confidence, 'confirmed-estimated');
});

test('a failed command shows what the device last said, not what was asked for', () => {
  // Leaving the target on screen after a failure is the lie this guards
  // against: it looks exactly like state.
  const view = present(
    T(0),
    { phase: 'FAILED', since: T(0), target: true, reason: 'timeout-unconfirmed' },
    obs({ powerDeliveryState: stopped }),
    clockWith(1),
    optimistic,
    'acknowledged but never observed to take effect before the deadline',
  );
  assert.equal(view.shown, false);
  assert.equal(view.confidence, 'failed');
  assert.match(view.fault ?? '', /acknowledged but never observed/);
});

test('a dark feed is shown as stale, with the last thing we heard', () => {
  const view = present(
    T(0),
    { phase: 'SUSPENDED', since: T(0), seen: DT(0) },
    obs({ powerDeliveryState: charging }),
    clockWith(1),
    careful,
    null,
  );
  assert.deepEqual(view, {
    shown: true,
    confidence: 'stale',
    widget: 'toggle',
    pending: null,
    fault: null,
  });
});

test('describe renders the countdown a UI would show', () => {
  const view = present(T(10_000), issued({ deadline: T(300_000) }), obs(), clockWith(1), optimistic, null);
  assert.equal(describe(view), 'charging [unconfirmed, toggle], confirming start (290s left)');
});

test('describe names the fault when there is one', () => {
  const view = present(
    T(0),
    { phase: 'FAILED', since: T(0), target: false, reason: 'rejected-by-vendor' },
    obs({ powerDeliveryState: charging }),
    noClock,
    careful,
    'command channel rejected the command',
  );
  assert.equal(describe(view), 'charging [failed, buttons], fault: command channel rejected the command');
});

test('describe says "stop" for a command that is turning something off', () => {
  const view = present(
    T(0),
    issued({ target: false, deadline: T(1_000) }),
    obs(),
    clockWith(1),
    careful,
    null,
  );
  assert.match(describe(view), /confirming stop \(1s left\)/);
});
