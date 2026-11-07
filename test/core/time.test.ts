/**
 * The branded-time helpers. Small, and each one pins a rule rather than a
 * mechanic — `plus` is the only legal way to build a deadline, `elapsed` is the
 * only subtraction that typechecks, and `laterDevice` is what stops an
 * out-of-order snapshot lowering a watermark.
 *
 * The compile-time half of this file's value cannot be asserted at runtime: the
 * point of the brands is that `obs.deviceTime > command.issuedAt` does not
 * compile. `npm run typecheck` is that test, and it runs in `npm run check`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNever,
  deviceInstant,
  duration,
  elapsed,
  instant,
  laterDevice,
  plus,
  seconds,
} from '../../src/core/time.ts';

test('plus moves an instant forward by a duration', () => {
  assert.equal(plus(instant(1_000), duration(500)), 1_500);
});

test('elapsed turns two instants into the gap between them', () => {
  assert.equal(elapsed(instant(1_000), instant(4_500)), 3_500);
});

test('elapsed of a future instant is negative, so callers must clamp it themselves', () => {
  // The view model relies on this: a tick can land past a deadline, and
  // silently clamping here would hide a deadline that has already passed from
  // every other caller.
  assert.equal(elapsed(instant(4_000), instant(1_000)), -3_000);
});

test('seconds rounds to the nearest whole second', () => {
  assert.equal(seconds(duration(1_499)), 1);
  assert.equal(seconds(duration(1_500)), 2);
  assert.equal(seconds(duration(-1_500)), -1);
});

test('laterDevice keeps a watermark monotonic against out-of-order delivery', () => {
  assert.equal(laterDevice(deviceInstant(500), deviceInstant(900)), 900);
  assert.equal(laterDevice(deviceInstant(900), deviceInstant(500)), 900);
  assert.equal(laterDevice(deviceInstant(900), deviceInstant(900)), 900);
});

test('assertNever throws with the context, so a missed union member is loud', () => {
  assert.throws(
    // The whole point is that this is unreachable with a well-typed union, so
    // reaching it in a test needs a cast. That cast is the test.
    () => assertNever('surprise' as never, 'somewhere'),
    /somewhere: unhandled variant "surprise"/,
  );
});
