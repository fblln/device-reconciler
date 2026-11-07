/**
 * signature.ts — webhook authentication and replay protection.
 *
 * THE THREAT
 * ----------
 * The ingest endpoint is the one part of this system reachable from outside. It
 * accepts telemetry and command reports, and both drive actuation decisions: a
 * forged `APPLIED` report makes the reconciler tell a user their car is
 * charging, and a forged `UNPLUGGED` snapshot makes it stop trying. An
 * unauthenticated webhook endpoint is therefore a remote control for the fleet,
 * not a convenience feature, so this is a trust boundary and gets validated as
 * one.
 *
 * THE SCHEME
 * ----------
 * HMAC-SHA256 over `timestamp.body`, in a header shaped like Stripe's and
 * GitHub's:
 *
 *     X-Platform-Signature: t=1762500000,v1=<hex>
 *
 * Three properties, each load-bearing:
 *
 *   signed body       the payload cannot be edited in transit.
 *   signed timestamp  included IN the signed material, not merely sent beside
 *                     it. A timestamp outside the MAC can be rewritten by an
 *                     attacker, which defeats the freshness window entirely.
 *   versioned tag     `v1=` leaves room to rotate the algorithm without a
 *                     flag day, which is why both of the above schemes have it.
 *
 * REPLAY
 * ------
 * A signature is valid forever, so a captured request can be resent. Two
 * defences, because neither alone is enough:
 *
 *   1. A freshness window (here). Bounds how long a captured request stays
 *      useful, and nothing more — inside the window a replay is still valid.
 *   2. Event-id deduplication (src/store/inbox.ts, a unique index). Makes a
 *      replay inside the window a no-op.
 *
 * The window is what makes the dedupe table finite: without it the table has to
 * remember every event id forever.
 *
 * WHY timingSafeEqual
 * -------------------
 * A `===` on hex digests leaks the position of the first differing byte through
 * its runtime, which is enough to forge a signature byte by byte given enough
 * attempts. `crypto.timingSafeEqual` is the stdlib answer and costs nothing.
 * It throws on length mismatch, so length is checked first — and checking
 * length is safe to do in variable time because the length of a SHA-256 digest
 * is not a secret.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Duration, Instant } from './time.ts';

export const SIGNATURE_HEADER = 'x-platform-signature';

const digest = (secret: string, signedAt: number, body: string): string =>
  createHmac('sha256', secret).update(`${signedAt}.${body}`).digest('hex');

export function sign(secret: string, signedAt: Instant, body: string): string {
  return `t=${signedAt},v1=${digest(secret, signedAt, body)}`;
}

export type VerifyFailure =
  'missing-header' | 'malformed-header' | 'unknown-version' | 'stale-timestamp' | 'bad-signature';

export type Verdict = Readonly<{ ok: true; signedAt: Instant } | { ok: false; reason: VerifyFailure }>;

/**
 * Total, and never throws: this runs on attacker-controlled input, so every
 * malformed shape has to be an ordinary return value. The distinct reasons are
 * for our metrics, not for the response body — the endpoint answers a flat 401
 * so a prober learns nothing about which check it failed.
 */
export function verify(
  header: string | undefined,
  body: string,
  secret: string,
  now: Instant,
  tolerance: Duration,
): Verdict {
  if (header === undefined || header === '') return { ok: false, reason: 'missing-header' };

  const parts = new Map<string, string>();
  for (const pair of header.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) parts.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }

  const t = parts.get('t');
  /*
   * Digits only, deliberately, rather than `Number.isFinite(Number(t))`.
   *
   * Found by test/core/signature.test.ts, not by review. `Number('')` is 0, so
   * a header carrying `t=` with no value parsed as "signed at the epoch",
   * sailed past the freshness check on any generous tolerance, and was only
   * stopped by the MAC — reported as `bad-signature`. Not exploitable, because
   * forging a digest for t=0 still needs the secret, but wrong in two ways that
   * matter: the metric blamed a forgery attempt for what was a malformed
   * request, and the freshness window — the cheap check that is supposed to
   * reject a flood of replays before any HMAC is computed — was bypassed by the
   * one input shape that trivially triggers it.
   *
   * A regex also rejects `0x10`, `1e3`, ` 12 ` and `Infinity`, none of which is
   * a timestamp any signer sends, and all of which `Number` accepts.
   */
  if (t === undefined || !/^\d+$/.test(t)) return { ok: false, reason: 'malformed-header' };
  const signedAt = Number(t);

  const provided = parts.get('v1');
  if (provided === undefined) return { ok: false, reason: 'unknown-version' };

  // Freshness BEFORE the MAC: it is the cheaper check, and rejecting on age
  // first means a flood of replayed captures never reaches the HMAC at all.
  // Absolute difference, because a signer whose clock runs fast is a
  // misconfiguration and not a reason to trust a request from the future.
  if (Math.abs(now - signedAt) > tolerance) return { ok: false, reason: 'stale-timestamp' };

  const expected = digest(secret, signedAt, body);
  if (provided.length !== expected.length) return { ok: false, reason: 'bad-signature' };
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    ? { ok: true, signedAt: signedAt as Instant }
    : { ok: false, reason: 'bad-signature' };
}
