/**
 * breaker.ts — a circuit breaker per vendor, as a pure state transition.
 *
 * THE FAILURE IT GUARDS AGAINST
 * -----------------------------
 * A vendor cloud goes down. Every device behind it fails, every failure is
 * retried, and the retries are the only traffic the vendor now receives — so it
 * stays down longer, and our worker pool is fully occupied producing errors
 * while the healthy vendors queue behind them. The outage of one vendor becomes
 * the outage of the fleet. That is the specific thing this file prevents: it
 * converts "fail slowly, thousands of times" into "fail immediately, locally,
 * and leave the workers free".
 *
 * HOW IT INTERACTS WITH THE RECONCILER
 * ------------------------------------
 * An open breaker is NOT a command failure. It means the request was never
 * made, so the decision function never sees an observation and the phase does
 * not move. An in-flight command keeps its deadline running, which is correct:
 * the platform may still be retrying it on its side, and the deadline is a
 * promise to the user about wall-clock time, not about our request count. This
 * is the same asymmetry as a telemetry outage in reconcile.ts.
 *
 * WHY HALF-OPEN RATHER THAN A FLAT TIMEOUT
 * ----------------------------------------
 * Closing blind after a cooloff sends the full fleet at a vendor that may still
 * be broken — the same thundering herd, just delayed. Half-open admits a bounded
 * number of probes; one success closes, one failure re-opens the window. The
 * probe count is a config value because a vendor with four devices and one with
 * four thousand want different numbers.
 *
 * ponytail: counts, not a sliding window of timestamps. Skipped an error-rate
 * breaker (failures-per-window over total) — add it when a vendor is flaky
 * rather than down, because a consecutive-failure count is blind to a steady 30%
 * error rate. Noted rather than built, since every vendor outage observed in the
 * simulator so far is total.
 */

import { plus, type Duration, type Instant } from './time.ts';

export type BreakerConfig = Readonly<{
  /** Consecutive failures that trip the breaker. */
  threshold: number;
  /** How long to stay open before admitting probes. */
  cooloff: Duration;
  /** Concurrent probes allowed while half-open. */
  probes: number;
}>;

export type BreakerState = 'closed' | 'open' | 'half-open';

export type Breaker = Readonly<{
  state: BreakerState;
  failures: number;
  /** Null unless open; the instant the cooloff started. */
  openedAt: Instant | null;
  /** Probes currently in flight while half-open. */
  inFlight: number;
}>;

export const closedBreaker: Breaker = { state: 'closed', failures: 0, openedAt: null, inFlight: 0 };

export type Admission = Readonly<{ breaker: Breaker; admitted: boolean; retryAt: Instant | null }>;

/**
 * Ask permission to make one request. Returns the next breaker state, because
 * admitting a half-open probe is itself a state change — forgetting that is how
 * a half-open breaker lets the whole herd through at once.
 */
export function admit(b: Breaker, now: Instant, cfg: BreakerConfig): Admission {
  if (b.state === 'closed') return { breaker: b, admitted: true, retryAt: null };
  if (b.state === 'open') {
    const until = plus(b.openedAt ?? now, cfg.cooloff);
    if (now < until) return { breaker: b, admitted: false, retryAt: until };
    // Cooloff elapsed: become half-open and spend this call as the first probe.
    return { breaker: { ...b, state: 'half-open', inFlight: 1 }, admitted: true, retryAt: null };
  }
  if (b.inFlight >= cfg.probes) {
    return { breaker: b, admitted: false, retryAt: plus(now, cfg.cooloff) };
  }
  return { breaker: { ...b, inFlight: b.inFlight + 1 }, admitted: true, retryAt: null };
}

/**
 * One admitted request succeeded. Any success fully closes — it takes no
 * argument on purpose, because there is no prior state a success should
 * preserve: carrying the failure count forward would let a breaker that has
 * been healthy for a day trip on its next single error.
 */
export const succeed = (): Breaker => closedBreaker;

/**
 * One admitted request failed. A failure while half-open re-opens immediately
 * and restarts the cooloff from now, rather than counting toward the threshold
 * again — the probe exists precisely to answer "is it back?", and the answer
 * was no.
 */
export function fail(b: Breaker, now: Instant, cfg: BreakerConfig): Breaker {
  if (b.state === 'half-open') return { state: 'open', failures: cfg.threshold, openedAt: now, inFlight: 0 };
  const failures = b.failures + 1;
  return failures >= cfg.threshold
    ? { state: 'open', failures, openedAt: now, inFlight: 0 }
    : { ...b, failures };
}
