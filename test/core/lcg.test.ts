/**
 * The thirty-line generator everything deterministic in this repository rests
 * on: the property test's worlds, the simulated fleet's latencies and skews,
 * and the backoff jitter. It is not here to be statistically good — it is here
 * so a failure is replayable from a seed, which is worth more than a better
 * distribution.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chance, intBetween, pick, rng, seedFrom } from '../../src/core/lcg.ts';

test('the same seed replays the same stream', () => {
  const a = rng(42);
  const b = rng(42);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
});

test('different seeds diverge', () => {
  assert.notEqual(rng(1)(), rng(2)());
});

test('draws stay in [0, 1)', () => {
  const r = rng(20261107);
  for (let i = 0; i < 10_000; i++) {
    const x = r();
    assert.ok(x >= 0 && x < 1, `draw ${x} out of range`);
  }
});

test('a zero seed still produces a stream rather than a constant', () => {
  const r = rng(0);
  assert.notEqual(r(), r());
});

test('intBetween is inclusive at both ends', () => {
  const r = rng(7);
  const seen = new Set<number>();
  for (let i = 0; i < 2_000; i++) seen.add(intBetween(r, 3, 5));
  assert.deepEqual([...seen].toSorted(), [3, 4, 5]);
});

test('intBetween on a single-value range is that value', () => {
  assert.equal(intBetween(rng(1), 4, 4), 4);
});

test('pick returns a member of the array', () => {
  const xs = ['a', 'b', 'c'] as const;
  const r = rng(11);
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) seen.add(pick(r, xs));
  assert.deepEqual([...seen].toSorted(), ['a', 'b', 'c']);
});

test('chance at 0 never fires and at 1 always does', () => {
  const r = rng(3);
  for (let i = 0; i < 200; i++) {
    assert.equal(chance(r, 0), false);
    assert.equal(chance(r, 1), true);
  }
});

test('chance is roughly its probability, which is all it is asked to be', () => {
  const r = rng(99);
  let hits = 0;
  const n = 20_000;
  for (let i = 0; i < n; i++) if (chance(r, 0.25)) hits++;
  assert.ok(Math.abs(hits / n - 0.25) < 0.02, `got ${hits / n}`);
});

test('seedFrom gives different ids different streams, and the same id the same one', () => {
  // This is the whole requirement on it: a per-device stream that is stable
  // across runs so a device's pathology is reproducible by name.
  assert.equal(seedFrom('dev-1', 0), seedFrom('dev-1', 0));
  assert.notEqual(seedFrom('dev-1', 0), seedFrom('dev-2', 0));
  assert.notEqual(seedFrom('dev-1', 0), seedFrom('dev-1', 1));
});

test('seedFrom is a non-negative 32-bit integer, so it is a usable seed', () => {
  for (const id of ['', 'a', 'dev-1', 'vendor/eu-west/dev-99']) {
    const s = seedFrom(id, 5);
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff, `${id} -> ${s}`);
  }
});
