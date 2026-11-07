/**
 * perf.test.ts — a throughput floor for the decision function.
 *
 * WHY A BUDGET AND NOT A BENCHMARK
 * --------------------------------
 * A benchmark produces a number nobody reads. A budget fails the build. What is
 * being protected is a specific property: `reconcile` is pure, total and
 * allocation-light, and a fleet of ten thousand devices on a thirty-second
 * sweep means a third of a million decisions a minute. The moment a decision
 * allocates a closure per call, or the correlation starts copying a history
 * buffer, that stops being free — and it will stop being free in a commit whose
 * diff looks harmless.
 *
 * WHY THE FLOOR IS ABSURDLY LOW
 * -----------------------------
 * 50k decisions/second, when a laptop does well over a million. CI runners are
 * shared, throttled and occasionally terrible, and a budget that flakes gets
 * deleted — which costs more than having no budget at all. An order of
 * magnitude of headroom still catches the regressions worth catching: adding a
 * `JSON.parse`, an `await`, or an O(n) scan to the hot path does not cost 20%,
 * it costs 20x.
 *
 * The RAW function is measured, not `reconcileChecked`. The contracts are
 * deliberate overhead that the shell opts into because correctness matters more
 * than speed at one decision per device per sweep; production could drop them.
 * Measuring the checked path would let a contract's cost mask a regression in
 * the thing being protected.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../src/core/reconcile.ts';
import { clockWith, converged, DT, G, input, obs, stopped, T } from './core/_world.ts';

const FLOOR = 50_000;

test(`reconcile sustains at least ${FLOOR} decisions per second`, () => {
  // Three representative inputs rather than one, so the measurement cannot be
  // satisfied by a single branch staying fast while another regresses: a device
  // that needs a command, one awaiting confirmation through the clock fallback,
  // and one holding a confirmed state.
  const inputs = [
    input({ obs: obs({ powerDeliveryState: stopped }), intent: { charging: true } }),
    input({
      now: T(100_000),
      state: {
        phase: 'ISSUED',
        since: T(90_000),
        target: true,
        deadline: T(270_000),
        commandId: 'd/1',
        generation: G(1),
      },
      obs: obs({ deviceTime: DT(95_000), receivedAt: T(99_000) }),
      clock: clockWith(1_000),
    }),
    input({
      state: converged({ seen: DT(0), target: true, generation: G(1) }),
      obs: obs({ deviceTime: DT(500), powerDeliveryState: 'PLUGGED_IN:CHARGING', observedGeneration: G(1) }),
    }),
  ];

  // Warm up, so the measurement is of optimised code rather than of the JIT
  // deciding whether to bother.
  for (let i = 0; i < 20_000; i++) reconcile(inputs[i % 3]!);

  const n = 200_000;
  const started = performance.now();
  let sink = 0;
  for (let i = 0; i < n; i++) sink += reconcile(inputs[i % 3]!).why.length;
  const elapsed = performance.now() - started;

  assert.ok(sink > 0, 'the loop must not be optimised away');
  const perSecond = (n / elapsed) * 1000;
  assert.ok(
    perSecond >= FLOOR,
    `${Math.round(perSecond).toLocaleString()} decisions/s is below the floor of ${FLOOR.toLocaleString()}`,
  );
});
