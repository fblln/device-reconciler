/**
 * The durable timer's value. Four cases, and the only one with a subtlety is the
 * expired deadline — a wake time already in the past makes a device claimable
 * forever at zero delay, which is a busy loop that starves the rest of the
 * queue.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextWake, type ScheduleConfig } from '../../src/core/schedule.ts';
import { converged, D, DT, idle, issued, T } from './_world.ts';

const cfg: ScheduleConfig = { sweepInterval: D(30_000), failedInterval: D(600_000) };

test('an in-flight command is woken exactly at its deadline', () => {
  // Earlier burns a decision that cannot have new evidence; later breaks the
  // promise the timeout makes to a user.
  assert.equal(nextWake(issued({ deadline: T(180_000) }), T(1_000), cfg), 180_000);
});

test('a deadline already passed wakes once now, not forever', () => {
  // Legitimate: a process down past the deadline comes back to find it expired.
  // The next decision fails the command, so one immediate wake is right.
  assert.equal(nextWake(issued({ deadline: T(100) }), T(5_000), cfg), 5_000);
});

test('a terminal failure is left alone for a long interval, not polled', () => {
  // A failure is terminal until the intent changes, and an intent change wakes
  // the device immediately — so polling would produce an unbounded stream of
  // identical "still terminal" decisions.
  const failed = { phase: 'FAILED', since: T(0), target: true, reason: 'rejected-by-vendor' } as const;
  assert.equal(nextWake(failed, T(1_000), cfg), 601_000);
});

test('a quiet device is swept, because nothing else will tell us it drifted', () => {
  assert.equal(nextWake(idle(DT(0)), T(1_000), cfg), 31_000);
  assert.equal(nextWake(converged(), T(1_000), cfg), 31_000);
  assert.equal(nextWake({ phase: 'SUSPENDED', since: T(0), seen: null }, T(1_000), cfg), 31_000);
});
