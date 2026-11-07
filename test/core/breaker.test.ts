/**
 * The per-vendor circuit breaker. The property that matters is that half-open
 * admits a BOUNDED number of probes — admitting one is itself a state change,
 * and forgetting that is how a half-open breaker lets the whole herd through at
 * the moment a recovering vendor can least take it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admit, closedBreaker, fail, succeed, type BreakerConfig } from '../../src/core/breaker.ts';
import { D, T } from './_world.ts';

const cfg: BreakerConfig = { threshold: 3, cooloff: D(15_000), probes: 1 };

const failTimes = (n: number, at = T(0)) => {
  let b = closedBreaker;
  for (let i = 0; i < n; i++) b = fail(b, at, cfg);
  return b;
};

test('a closed breaker admits freely and changes nothing', () => {
  const a = admit(closedBreaker, T(0), cfg);
  assert.deepEqual(a, { breaker: closedBreaker, admitted: true, retryAt: null });
});

test('failures below the threshold count without tripping', () => {
  assert.deepEqual(failTimes(2), { state: 'closed', failures: 2, openedAt: null, inFlight: 0 });
});

test('the threshold trips it open and records when the cooloff started', () => {
  assert.deepEqual(failTimes(3, T(5_000)), {
    state: 'open',
    failures: 3,
    openedAt: 5_000,
    inFlight: 0,
  });
});

test('an open breaker refuses immediately and says when to come back', () => {
  const a = admit(failTimes(3, T(5_000)), T(10_000), cfg);
  assert.equal(a.admitted, false);
  assert.equal(a.retryAt, 20_000);
});

test('the cooloff elapsing admits exactly one probe and spends it', () => {
  // The admitted call IS the probe. Returning the breaker unchanged here would
  // let every waiting caller through at once.
  const a = admit(failTimes(3, T(5_000)), T(20_000), cfg);
  assert.equal(a.admitted, true);
  assert.deepEqual(a.breaker, { state: 'half-open', failures: 3, openedAt: 5_000, inFlight: 1 });
});

test('a half-open breaker refuses beyond its probe budget', () => {
  const halfOpen = admit(failTimes(3, T(5_000)), T(20_000), cfg).breaker;
  const second = admit(halfOpen, T(20_000), cfg);
  assert.equal(second.admitted, false);
  assert.equal(second.retryAt, 35_000);
});

test('a bigger probe budget admits that many and no more', () => {
  const wide: BreakerConfig = { ...cfg, probes: 3 };
  let b = admit(failTimes(3, T(0)), T(15_000), wide).breaker;
  assert.equal(b.inFlight, 1);
  for (const expected of [2, 3]) {
    const a = admit(b, T(15_000), wide);
    assert.equal(a.admitted, true);
    b = a.breaker;
    assert.equal(b.inFlight, expected);
  }
  assert.equal(admit(b, T(15_000), wide).admitted, false);
});

test('any success fully closes, carrying no failure history forward', () => {
  // Carrying the count would let a breaker healthy for a day trip on its next
  // single error.
  assert.deepEqual(succeed(), closedBreaker);
});

test('a failed probe re-opens at once and restarts the cooloff from now', () => {
  // The probe exists to answer "is it back?", and the answer was no. Counting
  // it toward the threshold again would need two more failures to re-open a
  // vendor we have just confirmed is still down.
  const halfOpen = admit(failTimes(3, T(0)), T(15_000), cfg).breaker;
  assert.deepEqual(fail(halfOpen, T(15_000), cfg), {
    state: 'open',
    failures: 3,
    openedAt: 15_000,
    inFlight: 0,
  });
});

test('an open breaker with no recorded opening still cools off from now, rather than forever', () => {
  // Not reachable through `fail`, which always stamps `openedAt`. Handled
  // because a control loop should degrade to a delay, not to admitting
  // everything, if a row is ever deserialised without it.
  const odd = { state: 'open', failures: 9, openedAt: null, inFlight: 0 } as const;
  assert.equal(admit(odd, T(1_000), cfg).retryAt, 16_000);
});
