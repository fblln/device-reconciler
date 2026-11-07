/**
 * backoff.ts — the retry schedule, as arithmetic rather than as sleeping.
 *
 * WHY FULL JITTER
 * ---------------
 * Plain exponential backoff synchronises. A vendor outage fails every device at
 * once, so every device retries at the same doubling instants and the recovering
 * cloud is hit by the whole fleet in lockstep, three times, before anything
 * succeeds. Full jitter — a uniform draw from [0, cap] rather than cap itself —
 * spreads the herd across the window, and AWS's own measurements of the
 * alternatives put it at or near the top for both completion time and total
 * calls. It also halves the expected delay, which is a free win.
 *
 * WHY THE RANDOM NUMBER IS AN ARGUMENT
 * ------------------------------------
 * So this is a pure function of (attempt, config, draw). The schedule is then
 * testable exactly: the growth law, the cap and the deadline arithmetic are
 * asserted with draws of 0 and 1 instead of being sampled and hoped about. The
 * caller passes an Rng from lcg.ts, which makes even the jitter reproducible
 * from a seed.
 *
 * ponytail: no retry *budget* (a cap on total retry traffic as a fraction of
 * live traffic). The breaker already covers the failure mode a budget exists
 * for — a dead vendor absorbing the whole worker pool — and attempt caps bound
 * the rest. Add a budget when retries and live traffic share a quota tightly
 * enough that one starves the other.
 */

import { duration, plus, type Duration, type Instant } from './time.ts';
import type { Rng } from './lcg.ts';

export type BackoffConfig = Readonly<{
  base: Duration;
  cap: Duration;
  /** Attempts beyond this are abandoned rather than scheduled. */
  maxAttempts: number;
}>;

/**
 * The uncapped ideal delay for an attempt, before jitter. `attempt` is
 * 1-based — the first retry is attempt 1 and waits `base`, which is the
 * off-by-one every hand-rolled backoff gets wrong at least once.
 */
export function ceilingFor(attempt: number, cfg: BackoffConfig): Duration {
  // 2 ** 30 of anything is already past any sane cap, so clamping the exponent
  // keeps this finite for an absurd attempt count instead of returning Infinity
  // and poisoning the arithmetic downstream.
  const doubled = cfg.base * 2 ** Math.min(Math.max(attempt - 1, 0), 30);
  return duration(Math.min(cfg.cap, doubled));
}

/** Full jitter: uniform in [0, ceiling]. `draw` is in [0, 1). */
export function delayFor(attempt: number, cfg: BackoffConfig, draw: number): Duration {
  return duration(Math.round(ceilingFor(attempt, cfg) * draw));
}

export type Schedule = Readonly<{ at: Instant; attempt: number } | { at: null; attempt: number }>;

/**
 * When to try again, or null if the attempt budget is spent. Returning null
 * rather than throwing makes exhaustion an ordinary branch the caller must
 * handle — a dispatcher that cannot see "give up" will retry a permanently
 * rejected command until someone notices the log volume.
 */
export function nextAttempt(attempt: number, now: Instant, cfg: BackoffConfig, r: Rng): Schedule {
  const next = attempt + 1;
  if (next > cfg.maxAttempts) return { at: null, attempt: next };
  return { at: plus(now, delayFor(next, cfg, r())), attempt: next };
}
