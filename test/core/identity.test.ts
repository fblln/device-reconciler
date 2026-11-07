/**
 * Command identities. Two jobs, two fields: `commandId` matches a report to the
 * command that caused it and is the idempotency key on the wire; `generation`
 * orders desired state and is what a device echoes back.
 *
 * The property that makes restart safety work is that both are DERIVED, not
 * random: a transaction that is retried re-derives the same command id, so the
 * platform's idempotency check sees a repeat rather than a second actuation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceOf, mint } from '../../src/core/identity.ts';
import { generation } from '../../src/core/correlate.ts';

test('minting is deterministic in the device, the sequence and the last generation', () => {
  assert.deepEqual(mint('dev-1', 0, generation(0)), { commandId: 'dev-1/1', generation: 1 });
  assert.deepEqual(mint('dev-1', 0, generation(0)), { commandId: 'dev-1/1', generation: 1 });
  assert.deepEqual(mint('dev-1', 7, generation(7)), { commandId: 'dev-1/8', generation: 8 });
});

test('the generation advances past whatever was last handed out, not past the sequence', () => {
  // They are separate counters on purpose. A command id is per device for
  // idempotency; the generation is the desired-state counter and must advance
  // monotonically even if the two ever diverge.
  assert.deepEqual(mint('dev-1', 2, generation(9)), { commandId: 'dev-1/3', generation: 10 });
});

test('the device is recoverable from a command id', () => {
  assert.equal(deviceOf('dev-1/3'), 'dev-1');
});

test('a device id containing a slash still round-trips', () => {
  // Real device ids are vendor strings and arrive with punctuation in them.
  // Splitting on the FIRST slash would silently attribute a report to the wrong
  // device, which is the worst available failure in this system.
  assert.equal(deviceOf('vendor/eu-west/dev-1/42'), 'vendor/eu-west/dev-1');
});

test('a command id with no sequence is treated as the whole device id', () => {
  // Defensive rather than expected: an id this shape would be a bug in the
  // minting above, and attributing it to a device that exists beats throwing
  // inside webhook ingest.
  assert.equal(deviceOf('dev-1'), 'dev-1');
});
