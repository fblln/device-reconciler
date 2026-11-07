/**
 * The audited clock crossing. These tests are the derivation in clock.ts turned
 * into assertions, because the asymmetry it describes — a minimum delay sample
 * bounds the offset from ABOVE only, so proving "after" needs a declared max
 * latency and proving "before" does not — is the single easiest thing in this
 * codebase to get backwards, and it was got backwards once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capturedAfter, crossClockDelay, observeClock, unknownClock } from '../../src/core/clock.ts';
import { bounds, clockWith, D, DT, T } from './_world.ts';

test('an unsampled clock cannot decide anything', () => {
  // Not 'before' and not 'after': with no sample there is no relation between
  // the two clocks at all, and guessing either way is the bug this file exists
  // to prevent.
  assert.equal(capturedAfter(DT(0), T(0), unknownClock, bounds), 'unknown');
});

test('the first sample becomes the estimate', () => {
  const m = observeClock(unknownClock, T(1_000), DT(400));
  assert.deepEqual(m, { minDelay: 600, samples: 1 });
});

test('the estimate keeps the minimum sample and counts every one', () => {
  // Minimum, because sample = offset + latency and latency >= 0, so the
  // smallest sample is the tightest upper bound on the offset available.
  const a = observeClock(unknownClock, T(1_000), DT(400));
  const b = observeClock(a, T(2_000), DT(1_600));
  assert.deepEqual(b, { minDelay: 400, samples: 2 });
  const c = observeClock(b, T(3_000), DT(2_000));
  assert.deepEqual(c, { minDelay: 400, samples: 3 }, 'a worse sample must not widen the estimate');
});

test('crossClockDelay is the one place two clocks are subtracted', () => {
  assert.equal(crossClockDelay(T(5_000), DT(4_250)), 750);
});

test('a capture well past the action, under tight bounds, is provably after it', () => {
  // lower = deviceTime + minDelay - maxLatency - skewBound
  //       = 300_000 + 1_000 - 10_000 - 1_000 = 290_000 > 100_000
  const tight = { skewBound: D(1_000), maxLatency: D(10_000) };
  assert.equal(capturedAfter(DT(300_000), T(100_000), clockWith(1_000), tight), 'after');
});

test('a capture well before the action is provably before it, with no latency bound needed', () => {
  // upper = deviceTime + minDelay + skewBound = 0 + 1_000 + 30_000 <= 200_000.
  // Note this holds under the LOOSE default bounds: 'before' needs only the
  // upper bound on the offset, which one sample gives.
  assert.equal(capturedAfter(DT(0), T(200_000), clockWith(1_000), bounds), 'before');
});

test('loose bounds turn a decidable capture into "cannot tell"', () => {
  // The same world as the 'after' case above, but with the default fleet
  // bounds: the interval now straddles the instant we acted at. This is the
  // trade-off config.ts documents — looser bounds decide less often and are
  // wrong less often — and it is why `unknown` is a legitimate outcome rather
  // than a failure.
  assert.equal(capturedAfter(DT(300_000), T(290_500), clockWith(1_000), bounds), 'unknown');
});

test('a capture simultaneous with the action is not evidence for it', () => {
  // With both bounds at zero the interval collapses to a point, so there is no
  // ambiguity left and the only question is which way the boundary falls. It
  // falls against us: `after` needs lower > t strictly, so a capture at exactly
  // the instant we acted reads as 'before'.
  //
  // That is the conservative direction, and it is rule R1 — evidence must
  // post-date the action. A snapshot captured at the same millisecond as the
  // command was issued cannot describe a device that had not yet received it,
  // and treating it as confirmation is precisely how a reconciler credits its
  // own command for something it did not cause.
  const b = { skewBound: D(0), maxLatency: D(0) };
  const m = clockWith(0);
  assert.equal(capturedAfter(DT(100), T(100), m, b), 'before');
  assert.equal(capturedAfter(DT(101), T(100), m, b), 'after');
});

test('with zero bounds the answer is never "unknown"', () => {
  // `unknown` is the width of the interval, nothing else. Declaring perfect
  // knowledge of the clock and the feed removes it entirely — which is the
  // trade-off stated the other way round, and the reason the bounds are
  // operator-supplied rather than constants: somebody who sets them to zero
  // gets a decision every time and is wrong whenever they were optimistic.
  const b = { skewBound: D(0), maxLatency: D(0) };
  for (const dt of [0, 50, 100, 150, 200]) {
    assert.notEqual(capturedAfter(DT(dt), T(100), clockWith(0), b), 'unknown');
  }
});

test('a negative minimum delay — a device clock ahead of ours — is handled, not rejected', () => {
  // A device clock running ten minutes fast gives samples below zero. That is a
  // misconfigured device, not a bug in us, and the estimate still works: it
  // just shifts the whole interval. Rejecting it would mean the devices most in
  // need of correlation are the ones we refuse to correlate.
  const m = clockWith(-600_000);
  assert.equal(capturedAfter(DT(1_000_000), T(100_000), m, { skewBound: D(0), maxLatency: D(0) }), 'after');
});
