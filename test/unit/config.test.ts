/** The confirmation window is arithmetic between three independently tuned knobs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockConfirmationWindow, loadConfig } from '../../src/config.ts';
import { capturedAfter, observeClock, unknownClock } from '../../src/core/clock.ts';
import { instant, type DeviceInstant, type Instant } from '../../src/core/time.ts';
import { staleAfter } from '../../src/service/sweep.ts';

/**
 * Pinned against `capturedAfter` itself rather than against the formula, so a
 * change to either one that breaks the relationship fails here. A window that
 * silently goes non-positive is the bug this exists to catch: every clock-only
 * device would then time out on commands it had applied.
 */
test('a clock-only device can be confirmed inside the command timeout', () => {
  const cfg = loadConfig();
  const window = clockConfirmationWindow(cfg);

  assert.equal(window, cfg.commandTimeout - cfg.maxLatency - cfg.skewBound);

  /*
   * The bar is not "positive", it is "longer than a healthy feed may stay
   * silent". `staleAfter` is already the declaration of that: a device quiet
   * for longer has its telemetry marked dark. So a feed that is healthy by the
   * sweep's own definition can go that long between captures, and a window
   * shorter than it fails commands on devices that are behaving.
   */
  const healthySilence = staleAfter(cfg.schedule.sweepInterval);
  assert.ok(
    window >= healthySilence,
    `window ${window}ms is shorter than the ${healthySilence}ms a feed may be silent and still count as healthy`,
  );

  // minDelay 0: device clock identical to ours, no observed transit. A larger
  // minimum sample only moves the converted capture later and so decides
  // sooner, which makes this the worst case and the one the formula describes.
  let clock = unknownClock;
  for (let i = 0; i < 5; i++) {
    clock = observeClock(clock, (i * 60 * 1000) as Instant, (i * 60 * 1000) as DeviceInstant);
  }
  assert.equal(clock.minDelay, 0);
  const bounds = { skewBound: cfg.skewBound, maxLatency: cfg.maxLatency };
  const commandAt = instant(1_000_000);
  const at = (afterMs: number) => (commandAt + afterMs) as DeviceInstant;
  const floor = cfg.maxLatency + cfg.skewBound;

  assert.notEqual(capturedAfter(at(floor - 1000), commandAt, clock, bounds), 'after');
  assert.equal(capturedAfter(at(floor + 1000), commandAt, clock, bounds), 'after');
  // The whole point: that first provable capture lands before the deadline.
  assert.ok(floor + 1000 < cfg.commandTimeout);
});
