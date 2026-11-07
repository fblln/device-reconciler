/**
 * gate.ts — per-vendor backpressure: the stateful shell over two pure cores.
 *
 * WHAT IS HERE AND WHAT IS NOT
 * ----------------------------
 * The token bucket (src/core/ratelimit.ts) and the circuit breaker
 * (src/core/breaker.ts) are pure state transitions with `now` as an argument,
 * which is what makes them testable in microseconds with a virtual clock. This
 * file is the boring half they need in order to be useful: a map from vendor to
 * current state, and the two lines that read and write it. Nothing here
 * decides anything, which is why nothing here is under the coverage gate — the
 * decisions all live in the pure modules, with the tests.
 *
 * WHY IN MEMORY
 * -------------
 * The quota belongs to the vendor and would ideally be shared across every
 * process that calls it. This one is per process, which is correct here and
 * would be wrong at a larger deployment: work is distributed by claiming device
 * rows (`for update skip locked`), so a device is reconciled by one process at a
 * time, but two processes still share a vendor's quota and each paces to the
 * full limit. With one reconciler the model is exact; with N it over-admits by
 * a factor of N.
 *
 * ponytail: accepted, because the 429 path is implemented properly — a
 * server-stated `Retry-After` is folded straight into the bucket, so the
 * vendor's opinion always overrides ours and over-admission self-corrects
 * within one window. The upgrade path is a bucket in Redis or in Postgres, and
 * it is only worth paying for when a vendor's quota is tight enough that the
 * factor of N matters.
 */

import { instant, type Duration, type Instant } from '../core/time.ts';
import {
  admit,
  closedBreaker,
  fail as breakerFail,
  succeed as breakerSucceed,
  type Breaker,
  type BreakerConfig,
} from '../core/breaker.ts';
import { backOffUntil, freshBucket, retryAt, take, type Bucket, type Limits } from '../core/ratelimit.ts';

export type Decision =
  | Readonly<{ allow: true }>
  /** Wait this long and ask again. The caller decides whether to wait or move on. */
  | Readonly<{ allow: false; reason: 'rate-limited'; retryAfter: Duration }>
  | Readonly<{ allow: false; reason: 'breaker-open'; retryAt: Instant }>;

export type Gate = Readonly<{
  check: (vendor: string, now: Instant) => Decision;
  succeeded: (vendor: string) => void;
  failed: (vendor: string, now: Instant) => void;
  /** Fold a server-stated Retry-After into the bucket. The vendor's opinion wins. */
  throttled: (vendor: string, until: Instant) => void;
  snapshot: () => Record<string, { breaker: Breaker['state']; tokens: number }>;
}>;

export function createGate(limits: Limits, cfg: BreakerConfig): Gate {
  const buckets = new Map<string, Bucket>();
  const breakers = new Map<string, Breaker>();

  const bucketFor = (vendor: string, now: Instant): Bucket => buckets.get(vendor) ?? freshBucket(now, limits);

  return {
    check(vendor, now) {
      // Breaker FIRST. A dead vendor should not consume permits: tokens spent on
      // requests that are refused locally are tokens unavailable the moment the
      // vendor recovers, which is precisely when they are needed.
      const admission = admit(breakers.get(vendor) ?? closedBreaker, now, cfg);
      breakers.set(vendor, admission.breaker);
      if (!admission.admitted) {
        return { allow: false, reason: 'breaker-open', retryAt: admission.retryAt ?? now };
      }
      const grant = take(bucketFor(vendor, now), now, limits);
      buckets.set(vendor, grant.bucket);
      return grant.wait > 0
        ? { allow: false, reason: 'rate-limited', retryAfter: grant.wait }
        : { allow: true };
    },
    succeeded(vendor) {
      breakers.set(vendor, breakerSucceed());
    },
    failed(vendor, now) {
      breakers.set(vendor, breakerFail(breakers.get(vendor) ?? closedBreaker, now, cfg));
    },
    throttled(vendor, until) {
      buckets.set(vendor, backOffUntil(bucketFor(vendor, instant(until)), until));
    },
    snapshot() {
      const out: Record<string, { breaker: Breaker['state']; tokens: number }> = {};
      for (const vendor of new Set([...buckets.keys(), ...breakers.keys()])) {
        out[vendor] = {
          breaker: (breakers.get(vendor) ?? closedBreaker).state,
          tokens: Math.floor((buckets.get(vendor) ?? freshBucket(instant(0), limits)).tokens),
        };
      }
      return out;
    },
  };
}

export { retryAt };
