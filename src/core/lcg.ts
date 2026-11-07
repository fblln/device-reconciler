/**
 * lcg.ts — a seeded pseudo-random generator, because determinism is a feature.
 *
 * WHY NOT Math.random
 * -------------------
 * Two consumers need randomness and both need it reproducible:
 *
 *   the property tests  a counterexample must be replayable from a seed, or it
 *                       gets retried, then distrusted, then deleted.
 *   the mock platform   clock skew, telemetry latency and actuation delay are
 *                       per-device constants drawn once at startup. Drawn from
 *                       Math.random they would make every integration run a
 *                       different world, and an integration failure that cannot
 *                       be reproduced is indistinguishable from a flake.
 *
 * So the platform container takes a `SEED` and a device's pathology is a pure
 * function of (seed, deviceId). An agent that sees a failing run can replay the
 * exact fleet by exporting the same seed. That is the single most valuable
 * property this file buys.
 *
 * ponytail: twenty lines instead of a PRNG dependency. The constants are
 * Numerical Recipes'. An LCG is a poor generator for cryptography and a
 * perfectly good one for "give me a plausible 40-second latency", which is the
 * only thing asked of it here — the signing path uses node:crypto, not this.
 */

export type Rng = () => number;

export function rng(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/**
 * Derives a stable 32-bit seed from a string, so a device's pathology depends on
 * its id and not on the order the fleet happened to be created in. Adding a
 * device must not reshuffle every other device's behaviour, or a regression in
 * one integration test becomes a rewrite of all of them.
 */
export function seedFrom(text: string, salt: number): number {
  // FNV-1a. Chosen because it is six lines and has no pathological behaviour on
  // the short ASCII ids used here; nothing depends on its distribution quality
  // beyond "different ids give different streams".
  let h = 0x811c9dc5 ^ (salt >>> 0);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Uniform integer in [lo, hi]. Inclusive on both ends so callers stop guessing. */
export function intBetween(r: Rng, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}

export function pick<T>(r: Rng, xs: readonly T[]): T {
  // Non-empty is the caller's contract; the non-null assertion is the honest
  // encoding of that rather than a runtime branch no test could ever cover.
  return xs[Math.floor(r() * xs.length)]!;
}

export function chance(r: Rng, probability: number): boolean {
  return r() < probability;
}
