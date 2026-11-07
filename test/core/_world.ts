/**
 * _world.ts — builders for the pure core's tests.
 *
 * WHY BUILDERS AND NOT LITERALS
 * -----------------------------
 * An `Input` to the decision function has eleven fields across three clocks,
 * and a test that spells all of them out says nothing about which one it is
 * actually about. These builders default everything to a boring, reachable,
 * nothing-in-flight world so that each test can override exactly the field it
 * is pinning — which makes the test's subject readable in its own first line.
 *
 * The defaults are deliberately NOT a realistic fleet: no skew, no lag, a
 * device that reports no counter. Realism belongs in the property test, which
 * generates it. A unit test wants one variable.
 */

import { instant, deviceInstant, duration, type Instant, type Duration } from '../../src/core/time.ts';
import { unknownClock, type Bounds, type ClockModel } from '../../src/core/clock.ts';
import { generation, type Generation } from '../../src/core/correlate.ts';
import type {
  CommandReport,
  Input,
  Observation,
  Options,
  Phase,
  PowerDeliveryState,
} from '../../src/core/reconcile.ts';

export const T = (ms: number): Instant => instant(ms);
export const D = (ms: number): Duration => duration(ms);
export const DT = (ms: number) => deviceInstant(ms);
export const G = (n: number): Generation => generation(n);

export const bounds: Bounds = { skewBound: D(30_000), maxLatency: D(120_000) };

export const opts: Options = { commandTimeout: D(180_000), bounds };

export function obs(over: Partial<Observation> = {}): Observation {
  return {
    deviceId: 'dev-1',
    isReachable: true,
    deviceTime: DT(0),
    receivedAt: T(0),
    powerDeliveryState: 'PLUGGED_IN:STOPPED',
    observedGeneration: null,
    ...over,
  };
}

/** A clock model with one sample, so cross-clock correlation can decide at all. */
export const clockWith = (minDelayMs: number, samples = 1): ClockModel => ({
  minDelay: D(minDelayMs),
  samples,
});

export const noClock: ClockModel = unknownClock;

export function report(over: Partial<CommandReport> = {}): CommandReport {
  return { commandId: 'dev-1/1', state: 'ACCEPTED', at: T(0), ...over };
}

export const issued = (over: Partial<Extract<Phase, { phase: 'ISSUED' }>> = {}): Phase => ({
  phase: 'ISSUED',
  since: T(0),
  target: true,
  deadline: T(180_000),
  commandId: 'dev-1/1',
  generation: G(1),
  ...over,
});

export const converged = (over: Partial<Extract<Phase, { phase: 'CONVERGED' }>> = {}): Phase => ({
  phase: 'CONVERGED',
  since: T(0),
  target: true,
  seen: DT(0),
  generation: G(1),
  ...over,
});

export const idle = (seen: ReturnType<typeof DT> | null = null): Phase => ({
  phase: 'IDLE',
  since: T(0),
  seen,
});

export function input(over: Partial<Input> = {}): Input {
  return {
    now: T(1_000),
    intent: { charging: true },
    obs: obs(),
    report: null,
    clock: noClock,
    state: idle(),
    opts,
    next: { commandId: 'dev-1/1', generation: G(1) },
    ...over,
  };
}

export const charging: PowerDeliveryState = 'PLUGGED_IN:CHARGING';
export const stopped: PowerDeliveryState = 'PLUGGED_IN:STOPPED';
export const unplugged: PowerDeliveryState = 'UNPLUGGED';
