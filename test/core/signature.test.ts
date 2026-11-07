/**
 * Webhook authentication. This is the one part of the system reachable from
 * outside, and both message kinds it accepts drive actuation — a forged APPLIED
 * report makes the reconciler tell a user their car is charging. So every test
 * here is about a forgery that must not be accepted, and `verify` must be total
 * on attacker-controlled input: no input may make it throw.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify, SIGNATURE_HEADER } from '../../src/core/signature.ts';
import { D, T } from './_world.ts';

const secret = 'dev-webhook-secret';
const tolerance = D(300_000);
const body = '{"eventId":"e1","deviceId":"dev-1"}';

test('the header name is the one the platform sends', () => {
  assert.equal(SIGNATURE_HEADER, 'x-platform-signature');
});

test('a signature we produced verifies', () => {
  const v = verify(sign(secret, T(1_000), body), body, secret, T(1_000), tolerance);
  assert.deepEqual(v, { ok: true, signedAt: 1_000 });
});

test('an edited body does not verify', () => {
  const header = sign(secret, T(1_000), body);
  const tampered = body.replace('dev-1', 'dev-2');
  assert.deepEqual(verify(header, tampered, secret, T(1_000), tolerance), {
    ok: false,
    reason: 'bad-signature',
  });
});

test('a rewritten timestamp does not verify, because it is inside the signed material', () => {
  // The whole reason the timestamp is signed rather than merely sent alongside:
  // a timestamp outside the MAC can be refreshed by an attacker, which defeats
  // the freshness window entirely.
  const header = sign(secret, T(1_000), body);
  const moved = header.replace('t=1000', 't=2000');
  assert.deepEqual(verify(moved, body, secret, T(2_000), tolerance), {
    ok: false,
    reason: 'bad-signature',
  });
});

test('another secret does not verify', () => {
  const header = sign('other-secret', T(1_000), body);
  assert.deepEqual(verify(header, body, secret, T(1_000), tolerance), {
    ok: false,
    reason: 'bad-signature',
  });
});

test('a capture older than the window is rejected before the MAC is even computed', () => {
  const header = sign(secret, T(1_000), body);
  assert.deepEqual(verify(header, body, secret, T(301_001), tolerance), {
    ok: false,
    reason: 'stale-timestamp',
  });
});

test('a request from the future is rejected too', () => {
  // A signer whose clock runs fast is a misconfiguration, not a reason to trust
  // a request stamped after now. Absolute difference, both directions.
  const header = sign(secret, T(400_000), body);
  assert.deepEqual(verify(header, body, secret, T(1_000), tolerance), {
    ok: false,
    reason: 'stale-timestamp',
  });
});

test('the window is inclusive at its edge', () => {
  const header = sign(secret, T(1_000), body);
  assert.equal(verify(header, body, secret, T(301_000), tolerance).ok, true);
});

test('every malformed shape is a return value, never a throw', () => {
  // Total on attacker-controlled input. A verifier that throws on a weird header
  // is a denial of service at best, and at worst a 500 that some framework
  // turns into a retry loop.
  const cases: Array<readonly [string | undefined, string]> = [
    [undefined, 'missing-header'],
    ['', 'missing-header'],
    ['garbage', 'malformed-header'],
    ['v1=abc', 'malformed-header'],
    ['t=notanumber,v1=abc', 'malformed-header'],
    ['t=,v1=abc', 'malformed-header'],
    ['t=1000', 'unknown-version'],
    ['t=1000,v2=abc', 'unknown-version'],
    ['t=1000,v1=', 'bad-signature'],
    ['t=1000,v1=tooshort', 'bad-signature'],
  ];
  for (const [header, reason] of cases) {
    assert.deepEqual(
      verify(header, body, secret, T(1_000), tolerance),
      { ok: false, reason },
      `header ${JSON.stringify(header)}`,
    );
  }
});

test('an empty t is malformed, not a signature at epoch zero', () => {
  // Number('') is 0, which is finite. A naive parse would accept a header with
  // no timestamp as one stamped in 1970 — stale, so rejected, but for the wrong
  // reason and with the wrong metric.
  assert.deepEqual(verify('t=,v1=x', body, secret, T(0), tolerance), {
    ok: false,
    reason: 'malformed-header',
  });
});

test('whitespace and extra fields in the header are tolerated', () => {
  // Both schemes this is modelled on add fields over time; a verifier that
  // breaks on an unknown one breaks on the vendor's next release.
  const real = sign(secret, T(1_000), body);
  const v1 = real.slice(real.indexOf('v1='));
  assert.equal(verify(` t=1000 , ${v1} , v2=future `, body, secret, T(1_000), tolerance).ok, true);
});

test('an empty body is signed and verified like any other', () => {
  assert.equal(verify(sign(secret, T(1_000), ''), '', secret, T(1_000), tolerance).ok, true);
});
