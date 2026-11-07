/**
 * The readout. These two numbers — how often correlation lands on `unknown`,
 * and how often a clock estimate stood in for a counter — are what turn this
 * design's claim into a fact about a running fleet, so the arithmetic that
 * produces them is worth pinning precisely.
 *
 * The one that matters most is the empty denominator: null rather than zero.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, summarise, type DecisionRow } from '../../src/core/readout.ts';

const row = (over: Partial<DecisionRow> = {}): DecisionRow => ({
  vendor: 'acme',
  phase: 'ISSUED',
  correlation: 'after',
  source: 'generation',
  count: 1,
  ...over,
});

test('a fleet that has correlated nothing reports null, not a perfect score', () => {
  // A zero unknown-rate on a system that has correlated nothing reads as "the
  // design is working perfectly", which is the opposite of the truth — and it
  // is exactly the state a scrape hits in the first seconds after a restart.
  const r = summarise([]);
  assert.equal(r.decisions, 0);
  assert.equal(r.overall.unknownRate, null);
  assert.equal(r.overall.clockFallbackRate, null);
  assert.deepEqual(r.byVendor, {});
});

test('every phase is present in the census even at zero', () => {
  // A missing key and a zero are the same thing to a dashboard until somebody
  // writes `phases.FAILED.toFixed()`.
  assert.deepEqual(summarise([]).phases, { IDLE: 0, CONVERGED: 0, ISSUED: 0, SUSPENDED: 0, FAILED: 0 });
});

test('decisions that needed no correlation count as decisions and not as correlations', () => {
  // The denominator is correlations ATTEMPTED. Counting a decision that needed
  // none — a dark feed, a terminal failure — would dilute the rate with
  // decisions the rate says nothing about.
  const r = summarise([row({ phase: 'SUSPENDED', correlation: null, source: null, count: 7 })]);
  assert.equal(r.decisions, 7);
  assert.equal(r.overall.correlated, 0);
  assert.equal(r.overall.unknownRate, null);
});

test('a half-null row is not half-counted', () => {
  const r = summarise([
    row({ correlation: 'after', source: null }),
    row({ correlation: null, source: 'clock' }),
  ]);
  assert.equal(r.overall.correlated, 0);
});

test('the two headline rates are computed over correlations attempted', () => {
  const r = summarise([
    row({ correlation: 'after', source: 'generation', count: 5 }),
    row({ correlation: 'before', source: 'clock', count: 3 }),
    row({ correlation: 'unknown', source: 'clock', count: 2 }),
  ]);
  assert.equal(r.overall.correlated, 10);
  assert.equal(r.overall.after, 5);
  assert.equal(r.overall.before, 3);
  assert.equal(r.overall.unknown, 2);
  assert.equal(r.overall.byGeneration, 5);
  assert.equal(r.overall.byClock, 5);
  assert.equal(r.overall.unknownRate, 0.2);
  assert.equal(r.overall.clockFallbackRate, 0.5);
});

test('a fleet average hides the one vendor that is the problem, so both are reported', () => {
  const r = summarise([
    row({ vendor: 'counts', correlation: 'after', source: 'generation', count: 90 }),
    row({ vendor: 'guesses', correlation: 'unknown', source: 'clock', count: 10 }),
  ]);
  assert.equal(r.overall.unknownRate, 0.1);
  assert.equal(r.byVendor['counts']?.unknownRate, 0);
  assert.equal(r.byVendor['guesses']?.unknownRate, 1);
  assert.equal(r.byVendor['guesses']?.clockFallbackRate, 1);
});

test('rows for the same vendor and phase accumulate', () => {
  const r = summarise([
    row({ count: 2 }),
    row({ count: 3 }),
    row({ phase: 'CONVERGED', correlation: 'after', count: 4 }),
  ]);
  assert.equal(r.decisions, 9);
  assert.equal(r.phases.ISSUED, 5);
  assert.equal(r.phases.CONVERGED, 4);
  assert.equal(r.byVendor['acme']?.after, 9);
});

test('the rendered readout names the fallback rate, so an operator can see the estimate', () => {
  const text = render(
    summarise([
      row({ vendor: 'zeta', correlation: 'unknown', source: 'clock', count: 1 }),
      row({ vendor: 'alpha', correlation: 'after', source: 'generation', count: 3 }),
    ]),
  );
  assert.match(text, /decisions 4/);
  assert.match(text, /clock-fallback/);
  assert.match(text, /ALL/);
  // Sorted, so a diff of two runs is readable rather than reordered noise.
  assert.ok(text.indexOf('alpha') < text.indexOf('zeta'));
  assert.match(text, /25\.0%/);
});

test('an empty readout renders without an n/a that pretends to be a number', () => {
  const text = render(summarise([]));
  assert.match(text, /n\/a/);
});
