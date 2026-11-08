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
import {
  deviceReliability,
  render,
  renderDevices,
  summarise,
  type DecisionRow,
  type OutcomeRow,
} from '../../src/core/readout.ts';
import type { FailReason, PhaseName } from '../../src/core/reconcile.ts';

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

/**
 * Reliability counters. The transitions are what a command's verdict looks
 * like in the log, so the arithmetic that turns them into a rate is the part
 * that can be quietly wrong.
 */
const outcome = (
  deviceId: string,
  prevPhase: PhaseName,
  phase: PhaseName,
  count: number,
  failReason: FailReason | null = null,
): OutcomeRow => ({ deviceId, vendor: 'hare', prevPhase, phase, failReason, count });

test('a device is measured by its verdicts, and the faults stay apart', () => {
  const health = deviceReliability([
    outcome('a', 'ISSUED', 'CONVERGED', 7),
    outcome('a', 'ISSUED', 'FAILED', 2, 'timeout-unconfirmed'),
    outcome('a', 'ISSUED', 'FAILED', 1, 'rejected-by-vendor'),
    outcome('a', 'CONVERGED', 'ISSUED', 4),
    outcome('a', 'CONVERGED', 'SUSPENDED', 3),
    // A hold that the store filters out, included here to prove the pure
    // function does not depend on that filter to stay correct.
    outcome('a', 'ISSUED', 'ISSUED', 99),
  ]);
  assert.deepEqual(health['a'], {
    vendor: 'hare',
    commands: 10,
    confirmed: 7,
    rejected: 1,
    unconfirmed: 2,
    drifted: 4,
    wentDark: 3,
    confirmationRate: 0.7,
  });
});

test('a device with no verdict yet has no rate, and does not read as perfect', () => {
  const health = deviceReliability([outcome('b', 'IDLE', 'SUSPENDED', 2)]);
  assert.equal(health['b']?.confirmationRate, null);
  assert.equal(health['b']?.commands, 0);
  assert.equal(health['b']?.wentDark, 2);
  assert.deepEqual(deviceReliability([]), {});
});

test('the device table ranks the worst first and keeps the unjudged out of the way', () => {
  const health = deviceReliability([
    outcome('good', 'ISSUED', 'CONVERGED', 10),
    outcome('bad', 'ISSUED', 'CONVERGED', 1),
    outcome('bad', 'ISSUED', 'FAILED', 9, 'timeout-unconfirmed'),
    outcome('quiet', 'IDLE', 'SUSPENDED', 1),
    outcome('untouched', 'ISSUED', 'ISSUED', 5),
  ]);
  const lines = renderDevices(health).split('\n').slice(1);
  assert.deepEqual(
    lines.map((l) => l.split(' ')[0]),
    ['bad', 'good', 'quiet'],
    'worst rate first; a device with no verdict sorts last; one with no transitions is absent',
  );
  assert.match(renderDevices({}), /no verdicts yet/);
  assert.equal(renderDevices(health, 1).split('\n').length, 2, 'the limit caps the table');
  // Fixed-width columns, and a device with no verdict renders a shorter rate
  // than a percentage, so the table is where that difference shows up.
  const widths = new Set(
    renderDevices(health)
      .split('\n')
      .map((l) => l.length),
  );
  assert.equal(widths.size, 1, 'every row lines up with the header');
});

test('a device earns a row on drift alone, and equal rates break by name', () => {
  const health = deviceReliability([
    // No command has ever been judged here, but something keeps moving it.
    outcome('drifter', 'CONVERGED', 'ISSUED', 3),
    // Recovery out of SUSPENDED is a transition that is none of these outcomes
    // and must leave every counter alone.
    outcome('drifter', 'SUSPENDED', 'IDLE', 5),
    outcome('zulu', 'ISSUED', 'CONVERGED', 1),
    outcome('alpha', 'ISSUED', 'CONVERGED', 2),
  ]);
  assert.equal(health['drifter']?.commands, 0);
  assert.equal(health['drifter']?.drifted, 3);
  assert.equal(health['drifter']?.wentDark, 0, 'leaving SUSPENDED is not going dark');
  assert.deepEqual(
    renderDevices(health)
      .split('\n')
      .slice(1)
      .map((l) => l.split(' ')[0]),
    ['alpha', 'zulu', 'drifter'],
    'both confirmed devices sit at 100%, so the tiebreak is the name',
  );
});
