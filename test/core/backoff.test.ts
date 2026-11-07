/**
 * The retry schedule. The draw is an argument, so the growth law, the cap and
 * the attempt budget are asserted exactly with draws of 0 and 1 rather than
 * sampled and hoped about.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ceilingFor, delayFor, nextAttempt, type BackoffConfig } from '../../src/core/backoff.ts';
import { rng } from '../../src/core/lcg.ts';
import { D, T } from './_world.ts';

const cfg: BackoffConfig = { base: D(1_000), cap: D(60_000), maxAttempts: 5 };

test('the first retry waits the base, which is the off-by-one every backoff gets wrong', () => {
  assert.equal(ceilingFor(1, cfg), 1_000);
  assert.equal(ceilingFor(2, cfg), 2_000);
  assert.equal(ceilingFor(3, cfg), 4_000);
});

test('the ceiling is capped, not unbounded', () => {
  assert.equal(ceilingFor(7, cfg), 60_000);
  assert.equal(ceilingFor(100, cfg), 60_000);
});

test('an absurd attempt count stays finite rather than poisoning the arithmetic', () => {
  // 2 ** Infinity is Infinity, and an Infinity delay silently becomes an
  // invalid timestamp four layers downstream.
  assert.equal(ceilingFor(1e9, cfg), 60_000);
  assert.ok(Number.isFinite(ceilingFor(1e9, { ...cfg, cap: D(Number.MAX_SAFE_INTEGER) })));
});

test('attempt zero and below are treated as the first attempt', () => {
  assert.equal(ceilingFor(0, cfg), 1_000);
  assert.equal(ceilingFor(-5, cfg), 1_000);
});

test('full jitter spans the whole window from zero to the ceiling', () => {
  // Uniform over [0, ceiling] rather than the ceiling itself: plain exponential
  // backoff synchronises a whole fleet onto the same doubling instants.
  assert.equal(delayFor(3, cfg, 0), 0);
  assert.equal(delayFor(3, cfg, 1), 4_000);
  assert.equal(delayFor(3, cfg, 0.5), 2_000);
});

test('the next attempt is scheduled from now, and the counter advances', () => {
  const s = nextAttempt(1, T(10_000), cfg, () => 1);
  assert.deepEqual(s, { at: 10_000 + 2_000, attempt: 2 });
});

test('a spent attempt budget yields null rather than throwing', () => {
  // Exhaustion must be an ordinary branch the caller handles: a dispatcher that
  // cannot see "give up" retries a permanently rejected command until somebody
  // notices the log volume.
  assert.deepEqual(
    nextAttempt(5, T(0), cfg, () => 1),
    { at: null, attempt: 6 },
  );
  assert.deepEqual(
    nextAttempt(50, T(0), cfg, () => 1),
    { at: null, attempt: 51 },
  );
});

test('the last allowed attempt is scheduled, not abandoned', () => {
  assert.equal(nextAttempt(4, T(0), cfg, () => 0).at, 0);
});

test('a seed makes even the jitter reproducible', () => {
  const a = nextAttempt(2, T(0), cfg, rng(7));
  const b = nextAttempt(2, T(0), cfg, rng(7));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, nextAttempt(2, T(0), cfg, rng(8)));
});

test('every jittered delay lands inside its window', () => {
  const r = rng(20261107);
  for (let attempt = 1; attempt <= 12; attempt++) {
    for (let i = 0; i < 50; i++) {
      const s = nextAttempt(attempt - 1, T(0), { ...cfg, maxAttempts: 99 }, r);
      assert.ok(s.at !== null);
      assert.ok(s.at >= 0 && s.at <= ceilingFor(attempt, cfg), `attempt ${attempt} delay ${s.at}`);
    }
  }
});
