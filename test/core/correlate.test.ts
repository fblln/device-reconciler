/**
 * The strategy choice: a counter when the device offers one, a clock estimate
 * when it does not. One conditional, and the most consequential line in the
 * system — taking the clock fallback on a device that counts throws away
 * exactness for nothing, and claiming a generation for a device that reports
 * none is a confident answer derived from thin air. Contract I9 asserts it on
 * every decision; these tests pin it directly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byGeneration, correlate, generation, nextGeneration } from '../../src/core/correlate.ts';
import { bounds, clockWith, DT, G, noClock, T } from './_world.ts';

test('generations advance by one and never repeat', () => {
  assert.equal(nextGeneration(generation(0)), 1);
  assert.equal(nextGeneration(generation(41)), 42);
});

test('a device at or past the target generation has acted on it', () => {
  assert.equal(byGeneration(G(1), G(1)), 'after');
  // >= and not ==: commands supersede each other in flight, so a device can
  // skip a generation entirely. Demanding equality would wait forever for one
  // the device has already moved past.
  assert.equal(byGeneration(G(5), G(3)), 'after');
  assert.equal(byGeneration(G(2), G(3)), 'before');
});

test('a generation echo is never "unknown" — that is the whole point of a counter', () => {
  for (const observed of [0, 1, 2, 3]) {
    const r = correlate(G(observed), G(2), DT(0), T(0), noClock, bounds);
    assert.equal(r.source, 'generation');
    assert.notEqual(r.correlation, 'unknown');
  }
});

test('a device reporting a counter is correlated exactly even with no clock estimate', () => {
  // The clock model is empty, which would force 'unknown' on the fallback path.
  // The counter decides anyway, which is the ranking this module exists for.
  const r = correlate(G(3), G(2), DT(0), T(500_000), noClock, bounds);
  assert.deepEqual(r, { correlation: 'after', source: 'generation' });
});

test('a device reporting no counter falls back to the clock, and says so', () => {
  const r = correlate(null, G(2), DT(0), T(500_000), clockWith(1_000), bounds);
  assert.deepEqual(r, { correlation: 'before', source: 'clock' });
});

test('generation 0 is a real echo, not a missing one', () => {
  // The trap in this signature: `observedGeneration` is `Generation | null`,
  // and a falsy check instead of a null check would send every device that
  // honestly reports 0 down the clock fallback. Zero is what a device that has
  // never been commanded reports, which is exactly when we most need to know it
  // has not acted.
  const r = correlate(G(0), G(1), DT(0), T(0), noClock, bounds);
  assert.deepEqual(r, { correlation: 'before', source: 'generation' });
});
