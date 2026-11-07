/*
 * PORTED, DELIBERATELY DUPLICATED.
 *
 * This module is the pure correlation core, carried over unchanged from the
 * sibling `device-reconciler` repository (see README, "Two repositories"). It is
 * copied rather than depended on, and that is a decision rather than laziness:
 * the sibling repo's whole claim is that it has NO dependencies, no I/O and no
 * build step, so publishing it as a package to be consumed here would destroy
 * the property it exists to demonstrate. A vendored copy of five files with a
 * single-direction flow (core never imports from the shell) is cheaper than a
 * package boundary, and the drift risk is bounded by the fact that the core is
 * finished: its invariants are pinned by contracts and property tests that came
 * across with it.
 *
 * Re-port procedure, because a vendored copy that nobody knows how to refresh
 * is a fork: copy the file from the sibling, re-apply this banner, and re-apply
 * the two additions marked ADDED HERE (Step.correlation in reconcile.ts and
 * contract I9 in contracts.ts). Nothing else in these five files may be edited
 * locally; a change belongs upstream, in the sibling, where the property tests
 * that pin it live.
 *
 * Everything below this banner is the pure, deterministic, clock-free half of
 * the system. Nothing in src/core may import from src/store, src/adapter,
 * src/platform or src/service. That rule is what keeps the hard part testable
 * with a virtual clock while the operational half talks to Postgres and HTTP.
 */

/**
 * time.ts — nominal time, because this domain has TWO clocks and they lie.
 *
 * WHY BRAND A NUMBER
 * ------------------
 * Every value here is milliseconds, and they mean four different things: a point
 * on our clock, a point on the DEVICE's clock, a gap between two points, and a
 * budget. Structural typing cannot tell them apart, so the following all compile
 * and all are nonsense:
 *
 *     obs.deviceTime > command.issuedAt      // two different clocks
 *     deadline = now + now                   // two instants added
 *     if (age > deadline)                    // a duration against a point
 *
 * The first one is the dangerous one, and it is the reason this file exists.
 * Commands and state arrive on separate channels: a command goes out over a
 * request/ack path stamped by US, and state comes back over a telemetry path
 * stamped by the DEVICE, whose clock is skewed, occasionally wrong, and never
 * ours. Comparing the two directly is the single easiest way to build a
 * reconciler that is confidently wrong — it will credit its own command for a
 * state change that happened before the command was ever sent.
 *
 * Branding makes that a compile error. There is exactly one function in the
 * codebase where the two clocks are allowed to touch (`crossClockDelay` in
 * clock.ts), it is documented, and everything unsound has to go through it.
 *
 * The brands do not exist at runtime: these are plain numbers, no wrapper
 * allocation, so the hot path is untouched. See bench/decide.bench.ts.
 */

/** A point on OUR clock. Monotonic, trusted, ours. */
export type Instant = number & { readonly __kind: 'Instant' };

/**
 * A point on the DEVICE's clock, as reported in a telemetry payload. Not
 * comparable to an Instant without an explicit, auditable skew argument.
 */
export type DeviceInstant = number & { readonly __kind: 'DeviceInstant' };

/** A span of time. Never a point: it cannot be compared to a clock reading. */
export type Duration = number & { readonly __kind: 'Duration' };

export const instant = (ms: number): Instant => ms as Instant;
export const deviceInstant = (ms: number): DeviceInstant => ms as DeviceInstant;
export const duration = (ms: number): Duration => ms as Duration;

/** The only legal way to build a deadline. */
export const plus = (t: Instant, d: Duration): Instant => (t + d) as Instant;

/** Instant minus Instant is a Duration — the subtraction that typechecks. */
export const elapsed = (from: Instant, to: Instant): Duration => (to - from) as Duration;

export const seconds = (d: Duration): number => Math.round(d / 1000);

/**
 * Keeps a device-clock watermark monotonic. Telemetry can arrive out of order,
 * and letting an older snapshot lower the watermark would re-admit data we had
 * already moved past — the same stale reading would be treated as news forever.
 */
export const laterDevice = (a: DeviceInstant, b: DeviceInstant): DeviceInstant => (a > b ? a : b);

/**
 * Exhaustiveness guard. Reaching this means a union gained a member and some
 * switch did not. Failing loudly at the type level AND at runtime is cheaper
 * than a silently skipped state in a control loop.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled variant ${JSON.stringify(value)}`);
}
