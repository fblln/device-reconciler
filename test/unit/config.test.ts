/** The confirmation window is arithmetic between three independently tuned knobs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockConfirmationWindow, loadConfig, timingFor, type Timing } from '../../src/config.ts';
import { capturedAfter, observeClock, unknownClock } from '../../src/core/clock.ts';
import { instant, type DeviceInstant, type Instant } from '../../src/core/time.ts';
import { staleAfter } from '../../src/service/sweep.ts';

/** minDelay 0: device clock identical to ours, no observed transit. A larger
 *  minimum sample only moves the converted capture later and so decides sooner,
 *  which makes this the worst case and the one the formula describes. */
function alignedClock() {
  let clock = unknownClock;
  for (let i = 0; i < 5; i++) {
    clock = observeClock(clock, (i * 60 * 1000) as Instant, (i * 60 * 1000) as DeviceInstant);
  }
  assert.equal(clock.minDelay, 0);
  return clock;
}

/**
 * Pinned against `capturedAfter` itself rather than against the formula, so a
 * change to either one that breaks the relationship fails here.
 *
 * The bar is not "positive", it is "longer than a healthy feed may stay
 * silent". `staleAfter` is already the declaration of that: a device quiet for
 * longer has its telemetry marked dark. A window shorter than it fails commands
 * on devices the sweep considers healthy.
 */
function assertConfirmable(timing: Timing, healthySilence: number, label: string) {
  const window = clockConfirmationWindow(timing);
  assert.equal(window, timing.commandTimeout - timing.bounds.maxLatency - timing.bounds.skewBound, label);
  assert.ok(
    window >= healthySilence,
    `${label}: window ${window}ms is shorter than the ${healthySilence}ms a feed may be silent and still count as healthy`,
  );

  const clock = alignedClock();
  const commandAt = instant(1_000_000);
  const at = (afterMs: number) => (commandAt + afterMs) as DeviceInstant;
  const floor = timing.bounds.maxLatency + timing.bounds.skewBound;

  assert.notEqual(capturedAfter(at(floor - 1000), commandAt, clock, timing.bounds), 'after', label);
  assert.equal(capturedAfter(at(floor + 1000), commandAt, clock, timing.bounds), 'after', label);
  // The whole point: that first provable capture lands before the deadline.
  assert.ok(floor + 1000 < timing.commandTimeout, label);
}

test('a clock-only device can be confirmed inside the command timeout', () => {
  const cfg = loadConfig();
  const healthySilence = staleAfter(cfg.schedule.sweepInterval);
  assertConfirmable(cfg.timing.fleet, healthySilence, 'fleet');
  // Every configured vendor too: a per-vendor override is the easiest place to
  // break this relationship by hand, and it breaks silently.
  for (const [vendor, timing] of Object.entries(cfg.timing.byVendor)) {
    assertConfirmable(timing, healthySilence, `vendor ${vendor}`);
  }
});

test('vendor timing overrides merge over the fleet and are validated', (t) => {
  t.after(() => void delete process.env['VENDOR_TIMING']);

  process.env['VENDOR_TIMING'] = JSON.stringify({
    counts: { commandTimeout: 60_000 },
    slow: { commandTimeout: 900_000, maxLatency: 420_000 },
  });
  const cfg = loadConfig();

  // Stated keys win; unstated ones fall back to the fleet rather than to zero.
  assert.equal(timingFor(cfg.timing, 'counts').commandTimeout, 60_000);
  assert.equal(timingFor(cfg.timing, 'counts').bounds.maxLatency, cfg.timing.fleet.bounds.maxLatency);
  assert.equal(timingFor(cfg.timing, 'slow').bounds.maxLatency, 420_000);
  assert.equal(timingFor(cfg.timing, 'slow').bounds.skewBound, cfg.timing.fleet.bounds.skewBound);
  // A vendor nobody configured must still reconcile.
  assert.deepEqual(timingFor(cfg.timing, 'never-heard-of-it'), cfg.timing.fleet);

  // A vendor that echoes a generation is confirmed by integer comparison, so it
  // may legitimately carry a timeout far below the clock floor. It is not an
  // error, and the fleet-wide window check must not be read as forbidding it.
  assert.ok(clockConfirmationWindow(timingFor(cfg.timing, 'counts')) < 0);

  for (const bad of ['{"v":{"commandTimeout":"soon"}}', '{"v":{"typo":1}}', '{"v":[1]}', '[]', 'not json']) {
    process.env['VENDOR_TIMING'] = bad;
    assert.throws(() => loadConfig(), /VENDOR_TIMING/, `should refuse ${bad}`);
  }
});
