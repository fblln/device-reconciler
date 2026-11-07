/**
 * idempotency.test.ts — at-least-once delivery must not mean at-least-once
 * actuation.
 *
 * WHY THIS IS A SEPARATE TEST FROM restart.test.ts
 * ------------------------------------------------
 * Because the restart test did not actually prove it, and said it did.
 *
 * Checked by mutation: making command ids random (`deviceId/seq/Math.random()`)
 * instead of derived left the restart test passing. The reason is sound — after
 * a SIGKILL the restarted process re-drives the outbox ROW, which already holds
 * the command id, so nothing is re-minted and the key never has to do any work.
 * The restart test proves durability, and a second mutation confirmed that:
 * persisting `initialPhase` instead of the real phase — exactly the sibling
 * repository's in-memory gap — fails it immediately.
 *
 * So the idempotency key needs its own test, which drives the one thing the
 * restart path leaves unexercised: the SAME command being delivered twice. That
 * happens for real whenever a dispatch succeeds and the acknowledgement is lost
 * before `dispatched_at` is written — a crash in a window of microseconds, which
 * is not reproducible on demand and is certain to happen eventually across a
 * fleet.
 *
 * A surviving mutant is a missing assertion. This is the assertion.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, defaultRequestTimeout } from '../../src/adapter/client.ts';
import { generation } from '../../src/core/correlate.ts';
import { duration } from '../../src/core/time.ts';
import { startStack, CLIENT_ID, CLIENT_SECRET } from './_stack.ts';

test('delivering the same command twice actuates once', async (t) => {
  const stack = await startStack({ fleetSize: 2, tickMs: 250 });
  t.after(() => stack.stop());

  const client = createClient({
    baseUrl: stack.platform.url,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    requestTimeout: defaultRequestTimeout,
    defaultRetryAfter: duration(1_000),
  });

  const command = { commandId: 'dev-0000/1', generation: generation(1), target: true };

  const before = stack.platform.stats();
  const first = await client.sendCommand('dev-0000', command);
  assert.ok(first.ok, `first send failed: ${JSON.stringify(first)}`);

  // Byte-identical retry, as a lost acknowledgement would produce.
  const second = await client.sendCommand('dev-0000', command);
  assert.ok(second.ok, `retry failed: ${JSON.stringify(second)}`);

  // The replay must return the ORIGINAL answer, not a fresh one. A platform that
  // answers a repeat with a new PENDING has not deduplicated anything; it has
  // just hidden the second command behind an identical-looking response.
  assert.equal(second.value, first.value, 'a replay must return the original response');

  const after = stack.platform.stats();
  assert.equal(after.commands - before.commands, 1, 'a second command must not have been created');
  assert.ok(
    after.idempotentReplays > before.idempotentReplays,
    'the replay must have been recognised as one, not merely ignored',
  );

  /*
   * And the thing that actually matters: the relay moved once. `actuations` is
   * counted where the simulated device's state changes, not where a request
   * arrives, so this is the assertion that would fail if deduplication happened
   * at the wrong layer — an HTTP cache in front of a platform that applies every
   * request it sees would satisfy every assertion above and fail this one.
   *
   * Polled rather than read immediately: actuation is delayed by the device's
   * drawn actuation delay, which is the whole point of the two-channel model.
   */
  const deadline = Date.now() + 10_000;
  for (;;) {
    const stats = stack.platform.stats();
    if (stats.actuations - before.actuations >= 1) {
      assert.equal(stats.actuations - before.actuations, 1, 'the relay moved twice for one command');
      break;
    }
    if (Date.now() > deadline) {
      // Not every drawn profile applies a command at all — a device that
      // acknowledges and never applies is one of the pathologies on purpose.
      // Zero actuations is therefore a legitimate outcome; two is not.
      assert.equal(stack.platform.stats().actuations - before.actuations, 0);
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
});

test('a different command id for the same device is not deduplicated', async (t) => {
  /*
   * The other direction, and the one a naive implementation gets wrong by being
   * too clever: deduplicating per DEVICE rather than per COMMAND would make a
   * genuine second instruction — a user changing their mind — silently vanish.
   * Only a repeat of the same key is a repeat.
   */
  const stack = await startStack({ fleetSize: 2, tickMs: 250 });
  t.after(() => stack.stop());

  const client = createClient({
    baseUrl: stack.platform.url,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    requestTimeout: defaultRequestTimeout,
    defaultRetryAfter: duration(1_000),
  });

  const before = stack.platform.stats();
  const on = await client.sendCommand('dev-0001', {
    commandId: 'dev-0001/1',
    generation: generation(1),
    target: true,
  });
  const off = await client.sendCommand('dev-0001', {
    commandId: 'dev-0001/2',
    generation: generation(2),
    target: false,
  });
  assert.ok(on.ok && off.ok);

  const after = stack.platform.stats();
  assert.equal(after.commands - before.commands, 2, 'two distinct commands must both be accepted');
  assert.equal(
    after.idempotentReplays,
    before.idempotentReplays,
    'neither may be mistaken for a replay of the other',
  );
});
