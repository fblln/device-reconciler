/**
 * The per-vendor token bucket. The invariant worth pinning is that the server's
 * opinion always outranks ours: a 429's `Retry-After` is a hard gate, and the
 * bucket is drained when one arrives, because a server saying we are over quota
 * means our token count was fiction.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backOffUntil,
  freshBucket,
  parseRetryAfter,
  refill,
  retryAt,
  take,
  type Limits,
} from '../../src/core/ratelimit.ts';
import { D, T } from './_world.ts';

const limits: Limits = { perSecond: 5, burst: 10 };

test('a fresh bucket is full and ungated', () => {
  assert.deepEqual(freshBucket(T(0), limits), { tokens: 10, at: 0, blockedUntil: null });
});

test('a permit costs a token and is granted with no wait', () => {
  const g = take(freshBucket(T(0), limits), T(0), limits);
  assert.equal(g.wait, 0);
  assert.equal(g.bucket.tokens, 9);
});

test('the burst is spendable at once and then the bucket is empty', () => {
  let b = freshBucket(T(0), limits);
  for (let i = 0; i < 10; i++) {
    const g = take(b, T(0), limits);
    assert.equal(g.wait, 0, `permit ${i} should be granted from the burst`);
    b = g.bucket;
  }
  const denied = take(b, T(0), limits);
  assert.ok(denied.wait > 0, 'the eleventh must wait');
  assert.equal(denied.bucket.tokens, 0);
});

test('the wait is rounded up, so one wait is enough to earn one permit', () => {
  // Waiting the exact fractional deficit lands a hair short and produces a
  // second zero-progress poll for every grant.
  let b = freshBucket(T(0), limits);
  for (let i = 0; i < 10; i++) b = take(b, T(0), limits).bucket;
  const { wait } = take(b, T(0), limits);
  assert.equal(wait, 200, '1 token at 5/s is 200ms');
  assert.equal(take(b, T(0 + wait), limits).wait, 0);
});

test('permits accrue with time and are capped at the burst', () => {
  const empty = { tokens: 0, at: T(0), blockedUntil: null };
  assert.equal(refill(empty, T(1_000), limits).tokens, 5);
  // An hour idle must not grant an hour's worth at once and trip every
  // downstream limit in one tick.
  assert.equal(refill(empty, T(3_600_000), limits).tokens, 10);
});

test('refill never moves backwards in time', () => {
  const b = { tokens: 3, at: T(1_000), blockedUntil: null };
  assert.equal(refill(b, T(500), limits), b);
  assert.equal(refill(b, T(1_000), limits), b);
});

test('a server cooloff gates the bucket even while it holds tokens', () => {
  const gated = backOffUntil(freshBucket(T(0), limits), T(60_000));
  const g = take(gated, T(0), limits);
  assert.equal(g.wait, 60_000);
  assert.equal(g.bucket, gated, 'a refused take must not consume anything');
});

test('a cooloff also drains the bucket, so the window does not end in a burst', () => {
  assert.equal(backOffUntil(freshBucket(T(0), limits), T(60_000)).tokens, 0);
});

test('a longer cooloff wins and a shorter one cannot shorten it', () => {
  const long = backOffUntil(freshBucket(T(0), limits), T(60_000));
  assert.equal(backOffUntil(long, T(10_000)).blockedUntil, 60_000);
  assert.equal(backOffUntil(long, T(90_000)).blockedUntil, 90_000);
});

test('the gate clears itself once passed, without needing a reset', () => {
  const gated = backOffUntil(freshBucket(T(0), limits), T(60_000));
  const g = take(gated, T(60_000), limits);
  assert.equal(g.wait, 0);
  assert.equal(g.bucket.blockedUntil, null);
});

test('Retry-After is read as delay-seconds', () => {
  assert.equal(parseRetryAfter('30', T(0), D(1_000)), 30_000);
  assert.equal(parseRetryAfter(' 2.5 ', T(0), D(1_000)), 2_500);
});

test('Retry-After is also read as an HTTP date, relative to our clock', () => {
  const when = 'Fri, 07 Nov 2026 12:00:30 GMT';
  const now = Date.parse('Fri, 07 Nov 2026 12:00:00 GMT');
  assert.equal(parseRetryAfter(when, T(now), D(1_000)), 30_000);
});

test('a Retry-After in the past is zero, not negative', () => {
  assert.equal(parseRetryAfter('-5', T(0), D(1_000)), 0);
  const past = 'Fri, 07 Nov 2026 11:00:00 GMT';
  const now = Date.parse('Fri, 07 Nov 2026 12:00:00 GMT');
  assert.equal(parseRetryAfter(past, T(now), D(1_000)), 0);
});

test('a missing or unparseable Retry-After falls back, never to zero', () => {
  // Treating a malformed header as "retry immediately" turns one rate-limit
  // response into a hot loop against a vendor that just asked us to stop.
  for (const header of [null, undefined, '', '   ', 'soon', 'tomorrow-ish']) {
    assert.equal(parseRetryAfter(header, T(0), D(1_000)), 1_000, `header ${JSON.stringify(header)}`);
  }
});

test('retryAt turns a delay into an instant', () => {
  assert.equal(retryAt(T(5_000), D(250)), 5_250);
});
