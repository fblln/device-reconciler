/**
 * ingest.test.ts — the trust boundary, against a real database.
 *
 * The webhook endpoint is the only part of this system reachable from outside,
 * and both message kinds it accepts drive actuation: a forged `APPLIED` report
 * makes the reconciler tell somebody their car is charging, and a forged
 * `UNPLUGGED` snapshot makes it stop trying. So this is a remote control for
 * the fleet, and it is tested as one.
 *
 * Replay protection in particular cannot be tested against a fake. The defence
 * is a unique index — `insert ... on conflict (event_id) do nothing` returning
 * no rows — so a test with an in-memory Set would be testing my belief about
 * Postgres rather than Postgres, and the one thing that can go wrong here is a
 * missing constraint.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sign, SIGNATURE_HEADER } from '../../src/core/signature.ts';
import { instant } from '../../src/core/time.ts';
import { rows, type Db } from '../../src/store/db.ts';
import { startStack, until, WEBHOOK_SECRET } from './_stack.ts';
import { handleWebhook } from '../../src/service/ingest.ts';
import { createInstruments } from '../../src/telemetry.ts';
import { register } from '../../src/store/devices.ts';
import { initialPhase } from '../../src/core/reconcile.ts';
import { unknownClock } from '../../src/core/clock.ts';
import { duration } from '../../src/core/time.ts';
import { serve } from '../../src/http.ts';
import type { AddressInfo } from 'node:net';

const instruments = createInstruments();

type Posted = Readonly<{ status: number; body: unknown }>;

/**
 * The ingest handler behind a real HTTP server on an ephemeral port.
 *
 * In process, because the thing under test is the handler and the database, and
 * a spawned reconciler would add a loop that reconciles the events away while we
 * are trying to assert on them. Real HTTP rather than calling the function with
 * fabricated request objects, because the signature is computed over the RAW
 * BODY and a hand-built request is where that quietly stops being true.
 */
type Ingest = Readonly<{
  post: (body: unknown, signedAt?: number, secret?: string) => Promise<Posted>;
  stop: () => Promise<void>;
}>;

async function startIngest(db: Db): Promise<Ingest> {
  const server = serve(0, (req, res) =>
    handleWebhook(
      {
        db,
        cfg: { webhookSecret: WEBHOOK_SECRET, signatureTolerance: duration(300_000) },
        instruments,
      },
      req,
      res,
      instant(Date.now()),
    ),
  );
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;

  return {
    post: async (body, signedAt = Date.now(), secret = WEBHOOK_SECRET) => {
      const raw = JSON.stringify(body);
      const res = await fetch(`http://127.0.0.1:${port}/webhooks`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: sign(secret, instant(signedAt), raw),
        },
        body: raw,
      });
      const text = await res.text();
      return { status: res.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
    },
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const commandReport = (deviceId: string, eventId: string, commandId: string, state: string, at: number) => ({
  eventId,
  kind: 'report' as const,
  deviceId,
  commandId,
  state,
  at,
});

const telemetry = (deviceId: string, eventId: string) => ({
  eventId,
  kind: 'telemetry' as const,
  deviceId,
  isReachable: true,
  deviceTime: Date.now() - 1_000,
  powerDeliveryState: 'PLUGGED_IN:CHARGING',
  observedGeneration: 1,
});

test('a replayed event is accepted and does nothing', async (t) => {
  const stack = await startStack({ fleetSize: 1 });
  const ingest = await startIngest(stack.db);
  t.after(async () => {
    await ingest.stop();
    await stack.stop();
  });
  await register(stack.db, 'dev-0000', 'hare', initialPhase(instant(0)), unknownClock, instant(0));

  const eventId = randomUUID();
  const first = await ingest.post(telemetry('dev-0000', eventId));
  assert.deepEqual(first, { status: 200, body: { accepted: true } });

  /*
   * The same event again. A 2xx, deliberately: the platform delivers at least
   * once, so from its side a duplicate it already sent successfully IS a
   * success, and answering an error teaches an at-least-once sender to retry
   * forever — which turns our deduplication into a permanent load source.
   */
  const replay = await ingest.post(telemetry('dev-0000', eventId));
  assert.deepEqual(replay, { status: 200, body: { accepted: false } });

  const stored = await rows<{ n: string }>(
    stack.db,
    `select count(*)::text as n from inbox where event_id = $1`,
    [eventId],
  );
  assert.equal(stored[0]?.n, '1', 'the unique index must have kept exactly one copy');
});

test('a replay cannot move the clock sample count, which is how trust in the estimate is judged', async (t) => {
  /*
   * A subtle one, and the reason the clock model is folded in at ingest rather
   * than in the worker. `samples` is how an operator decides whether to believe
   * the cross-clock estimate at all. Counting a duplicate would inflate it with
   * no new information — the estimate would look better-evidenced precisely
   * because the platform was retrying.
   */
  const stack = await startStack({ fleetSize: 1 });
  const ingest = await startIngest(stack.db);
  t.after(async () => {
    await ingest.stop();
    await stack.stop();
  });
  await register(stack.db, 'dev-0000', 'hare', initialPhase(instant(0)), unknownClock, instant(0));

  const eventId = randomUUID();
  await ingest.post(telemetry('dev-0000', eventId));
  const afterFirst = await rows<{ clock: { samples: number } }>(
    stack.db,
    `select clock from device where device_id = 'dev-0000'`,
  );
  assert.equal(afterFirst[0]?.clock.samples, 1);

  await ingest.post(telemetry('dev-0000', eventId));
  const afterReplay = await rows<{ clock: { samples: number } }>(
    stack.db,
    `select clock from device where device_id = 'dev-0000'`,
  );
  assert.equal(afterReplay[0]?.clock.samples, 1, 'a duplicate must not count as a sample');
});

test('an unsigned, mis-signed or stale request is rejected without detail', async (t) => {
  const stack = await startStack({ fleetSize: 1 });
  const ingest = await startIngest(stack.db);
  t.after(async () => {
    await ingest.stop();
    await stack.stop();
  });
  await register(stack.db, 'dev-0000', 'hare', initialPhase(instant(0)), unknownClock, instant(0));

  const wrongSecret = await ingest.post(telemetry('dev-0000', randomUUID()), Date.now(), 'not-the-secret');
  assert.equal(wrongSecret.status, 401);

  // Outside the freshness window. A captured request stays cryptographically
  // valid forever, so the window is what bounds how long it stays useful — and
  // what keeps the dedupe table finite.
  const stale = await ingest.post(telemetry('dev-0000', randomUUID()), Date.now() - 400_000);
  assert.equal(stale.status, 401);

  /*
   * A flat 401 with no body detail, for every reason. The distinct failure
   * reasons go to metrics; a prober must not learn WHICH check it failed,
   * because "bad signature" versus "stale timestamp" tells an attacker whether
   * the secret is right and only the clock is wrong.
   */
  assert.equal(JSON.stringify(wrongSecret.body), JSON.stringify(stale.body));

  const accepted = await rows<{ n: string }>(stack.db, `select count(*)::text as n from inbox`);
  assert.equal(accepted[0]?.n, '0', 'nothing unverified may reach the inbox');
});

test('a signed event for an unknown device does not create one', async (t) => {
  /*
   * The fleet is discovered from the platform, not from whatever posts to us.
   * Letting a webhook register a device would mean anyone who can reach the
   * endpoint can add rows to the fleet — and a reconciler that manages devices
   * nobody authorised is a worse outcome than a dropped event.
   */
  const stack = await startStack({ fleetSize: 1 });
  const ingest = await startIngest(stack.db);
  t.after(async () => {
    await ingest.stop();
    await stack.stop();
  });

  const res = await ingest.post(telemetry('dev-nobody-asked-for', randomUUID()));
  // Accepted and recorded in the inbox — it was properly signed, and discarding
  // it silently would lose the evidence that something is misconfigured — but
  // no device row appears.
  assert.equal(res.status, 200);
  const devices = await rows<{ n: string }>(stack.db, `select count(*)::text as n from device`);
  assert.equal(devices[0]?.n, '0');
});

test('telemetry pulls the device forward instead of waiting for the sweep', async (t) => {
  /*
   * The reason the system is webhook-driven at all. A snapshot that lands two
   * seconds after a command should be acted on in two seconds, not at the next
   * thirty-second sweep — and `wake_at` moving backwards is the mechanism.
   * `least`, so an event can never push a nearer deadline out.
   */
  const stack = await startStack({ fleetSize: 1 });
  const ingest = await startIngest(stack.db);
  t.after(async () => {
    await ingest.stop();
    await stack.stop();
  });
  const far = instant(Date.now() + 600_000);
  await register(stack.db, 'dev-0000', 'hare', initialPhase(instant(0)), unknownClock, far);

  await ingest.post(telemetry('dev-0000', randomUUID()));
  const woken = await until(
    'wake_at to be pulled forward',
    () => rows<{ wake_at: string }>(stack.db, `select wake_at from device where device_id = 'dev-0000'`),
    (r) => Number(r[0]?.wake_at ?? far) < far,
    5_000,
  );
  assert.ok(Number(woken[0]!.wake_at) < far);
});

test('a late report for a superseded command cannot evict the current one', async (t) => {
  const stack = await startStack({ fleetSize: 1 });
  const ingest = await startIngest(stack.db);
  t.after(async () => {
    await ingest.stop();
    await stack.stop();
  });
  await register(stack.db, 'dev-0000', 'hare', initialPhase(instant(0)), unknownClock, instant(0));

  const held = async () =>
    (
      await rows<{ command_id: string; state: string }>(
        stack.db,
        'select command_id, state from command_report where device_id = $1',
        ['dev-0000'],
      )
    )[0];

  // The device's second command is acknowledged and applied.
  await ingest.post(commandReport('dev-0000', randomUUID(), 'dev-0000/2', 'APPLIED', 2_000));
  assert.deepEqual(await held(), { command_id: 'dev-0000/2', state: 'APPLIED' });

  /*
   * Now the first command's acknowledgement finally turns up, and the platform
   * stamps it LATER than the one it supersedes. That is the case `at` cannot
   * order: by timestamp this stale report looks like the freshest thing we
   * hold. Only our own sequence says otherwise.
   */
  const late = await ingest.post(commandReport('dev-0000', randomUUID(), 'dev-0000/1', 'ACCEPTED', 3_000));
  assert.deepEqual(late, { status: 200, body: { accepted: true } });
  assert.deepEqual(
    await held(),
    { command_id: 'dev-0000/2', state: 'APPLIED' },
    'the confirmation for the current command must survive a late report for a superseded one',
  );

  // A report that genuinely advances the current command still lands.
  await ingest.post(commandReport('dev-0000', randomUUID(), 'dev-0000/3', 'REJECTED', 2_500));
  assert.deepEqual(await held(), { command_id: 'dev-0000/3', state: 'REJECTED' });
});
