/** Strict request parsing prevents malformed input silently becoming “stop”. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAction, IntentError } from '../../src/service/intent.ts';
test('intent request validation and canonical payloads', () => {
  assert.deepEqual(parseAction({ charging: true }, false), { charging: true, source: 'operator' });
  assert.deepEqual(parseAction({ charging: false, source: 'schedule' }, false), {
    charging: false,
    source: 'schedule',
  });
  assert.deepEqual(
    parseAction({ source: 'operator', charging: true }, false),
    parseAction({ charging: true }, false),
  );
  const id = '00000000-0000-0000-0000-000000000001';
  assert.deepEqual(parseAction({ retryOf: id }, true), { retryOf: id });
  for (const v of [
    null,
    [],
    false,
    {},
    { charging: 1 },
    { charging: true, source: 'local' },
    { charging: true, extra: 1 },
  ])
    assert.throws(() => parseAction(v, false), IntentError);
  for (const v of [{}, { retryOf: 1 }, { retryOf: 'x' }, { retryOf: id, extra: 1 }])
    assert.throws(() => parseAction(v, true), IntentError);
});
