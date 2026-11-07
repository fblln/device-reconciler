/**
 * ratelimit.ts — a token bucket per vendor, as a pure state transition.
 *
 * WHY PER VENDOR AND NOT PER PROCESS
 * ----------------------------------
 * The quota belongs to the vendor, not to us. One vendor's cloud will happily
 * take 50 requests a second; another publishes 10 a minute per client and means
 * it. A single global limiter has to be set to the tightest vendor in the fleet,
 * which starves everyone else, so the limiter is keyed by vendor and configured
 * from the vendor's documented quota.
 *
 * WHY CLIENT-SIDE AT ALL, WHEN THE SERVER SENDS 429
 * -------------------------------------------------
 * Because a 429 is a request that was made, counted, and in most
 * implementations still charged against the quota — and because the retry it
 * provokes arrives in a thundering herd with every other caller's retry. Pacing
 * locally means the 429 is the exception that catches our model being wrong,
 * not the control loop. When one does arrive, `backOffUntil` folds the server's
 * `Retry-After` straight into the bucket, so the server's opinion always wins
 * over ours.
 *
 * WHY PURE
 * --------
 * No timers, no `Date.now()`, no sleeping inside. `now` is an argument, so the
 * whole thing is testable in microseconds with a virtual clock, and the one
 * place that actually waits is the queue in the shell. A limiter that owns a
 * timer can only be tested by waiting.
 *
 * ponytail: a bucket is three numbers. Skipped a sliding-window log and a
 * distributed limiter — this process is the only caller of each vendor, and
 * `claim`-based work distribution (see src/store/devices.ts) keeps it that way.
 * Add a shared limiter when a second reconciler process shares a vendor quota.
 */

import { duration, plus, type Duration, type Instant } from './time.ts';

export type Limits = Readonly<{
  /** Steady-state permits per second. Fractional is fine and often correct. */
  perSecond: number;
  /** How many permits may be spent at once after an idle period. */
  burst: number;
}>;

export type Bucket = Readonly<{
  tokens: number;
  /** When `tokens` was last accurate. Refill is computed, never scheduled. */
  at: Instant;
  /**
   * Set from a 429's `Retry-After`. A hard gate that outranks the bucket: the
   * server has told us the quota model we are using is wrong, and continuing to
   * pace by our own numbers through that window is how a client gets banned.
   */
  blockedUntil: Instant | null;
}>;

export const freshBucket = (now: Instant, limits: Limits): Bucket => ({
  tokens: limits.burst,
  at: now,
  blockedUntil: null,
});

/**
 * Lazily accrue permits for the time that has passed. Capped at `burst`, which
 * is what stops a bucket idle overnight from granting a night's worth of
 * requests in one tick and tripping every downstream limit at once.
 */
export function refill(b: Bucket, now: Instant, limits: Limits): Bucket {
  if (now <= b.at) return b;
  const gained = ((now - b.at) / 1000) * limits.perSecond;
  return { ...b, tokens: Math.min(limits.burst, b.tokens + gained), at: now };
}

export type Grant = Readonly<{
  bucket: Bucket;
  /**
   * Zero means a permit was taken. Otherwise it is how long to wait before
   * asking again — returned rather than slept, so the caller decides whether to
   * wait, shed the work, or pick a different device.
   */
  wait: Duration;
}>;

export function take(b: Bucket, now: Instant, limits: Limits): Grant {
  if (b.blockedUntil !== null && now < b.blockedUntil) {
    return { bucket: b, wait: duration(b.blockedUntil - now) };
  }
  const r = refill(b, now, limits);
  if (r.tokens >= 1) return { bucket: { ...r, tokens: r.tokens - 1, blockedUntil: null }, wait: duration(0) };
  // Round up: waiting the exact fractional deficit lands us a hair short and
  // produces a second zero-progress poll for every grant.
  const deficit = 1 - r.tokens;
  return { bucket: r, wait: duration(Math.ceil((deficit / limits.perSecond) * 1000)) };
}

/**
 * Apply a server-stated cooloff. Also drains the bucket: if the server says we
 * are over quota then our token count is a fiction, and resuming with a full
 * burst the instant the window ends would immediately earn another 429.
 */
export function backOffUntil(b: Bucket, until: Instant): Bucket {
  return {
    tokens: 0,
    at: b.at,
    blockedUntil: b.blockedUntil !== null && b.blockedUntil > until ? b.blockedUntil : until,
  };
}

/**
 * `Retry-After` is either delay-seconds or an HTTP date (RFC 9110 §10.2.3).
 * Both appear in the wild from the same vendor on different endpoints, so both
 * are parsed, and an unparseable value yields a conservative default rather
 * than zero — treating a malformed header as "retry immediately" turns one
 * rate-limit response into a hot loop.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: Instant,
  fallback: Duration,
): Duration {
  if (header === null || header === undefined || header.trim() === '') return fallback;
  const asSeconds = Number(header.trim());
  if (Number.isFinite(asSeconds)) return duration(Math.max(0, Math.round(asSeconds * 1000)));
  const asDate = Date.parse(header);
  if (Number.isNaN(asDate)) return fallback;
  return duration(Math.max(0, asDate - now));
}

export const retryAt = (now: Instant, after: Duration): Instant => plus(now, after);
