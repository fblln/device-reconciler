/**
 * twin.test.ts — against a real Eclipse Ditto.
 *
 * WHY THIS IS NOT TESTCONTAINERS
 * ------------------------------
 * Ditto is four JVM containers plus MongoDB, and its services form a Pekko
 * cluster that takes the better part of a minute to converge. Starting that
 * inside every test run would cost more than it proves, and `npm run up`
 * already brings it up for the demo. So this test runs against whatever
 * `DITTO_URL` points at, and SKIPS — loudly, by name — when there is nothing
 * there.
 *
 * A skipped test is a weaker guarantee than a failing one, and this is the
 * honest place to accept that: CI runs it (the workflow brings the stack up),
 * and a developer who has not started Ditto gets a skip rather than a red
 * suite they learn to ignore.
 *
 * WHAT IT ACTUALLY PROVES
 * -----------------------
 * That the integration is real rather than a shape I believed in. Every
 * assertion reads state back out of Ditto's own HTTP API: the thing exists with
 * the policy Ditto minted for it, the desired section holds the counter THIS
 * PLATFORM minted, and the reported section carries Azure IoT Plug and Play's
 * acknowledgement convention — `av` matching the desired version, `ac` as a
 * status code, `ad` as the reason the reconciler actually gave.
 *
 * TWO THINGS LEARNED BRINGING THE STACK UP, recorded because they are the kind
 * of thing that is obvious once and never again:
 *
 *   - every Ditto service must answer to the network alias `ditto-cluster`, or
 *     Pekko's bootstrap resolves zero contact points and retries forever.
 *   - the Ditto services must NOT depend on each other with
 *     `condition: service_healthy`. A Ditto service is healthy only once the
 *     cluster has formed, and the cluster needs two peers — so that condition
 *     makes each wait for a peer that is waiting for it.
 *
 * Both are in compose.yaml with the log line they produce.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ackFor, createTwinStore, defaultDittoTimeout, type TwinStore } from '../../src/twin/ditto.ts';
import { createProjector } from '../../src/twin/project.ts';
import { instant, deviceInstant } from '../../src/core/time.ts';
import { generation } from '../../src/core/correlate.ts';
import type { Observation } from '../../src/core/reconcile.ts';

const DITTO_URL = process.env['DITTO_URL'] ?? 'http://localhost:8080';

const store: TwinStore = createTwinStore({
  baseUrl: DITTO_URL,
  namespace: 'energy-test',
  subject: 'nginx:ditto',
  timeout: defaultDittoTimeout,
});

const reachable = await store.alive();

const obs = (over: Partial<Observation> = {}): Observation => ({
  deviceId: 'dev-twin',
  isReachable: true,
  deviceTime: deviceInstant(1_762_500_000_000),
  receivedAt: instant(1_762_500_001_000),
  powerDeliveryState: 'PLUGGED_IN:CHARGING',
  observedGeneration: generation(3),
  ...over,
});

type Feature = {
  properties?: {
    charging?: { value?: boolean; av?: number; ac?: number; ad?: string };
    powerDeliveryState?: string;
    deviceTimeOnDeviceClock?: number;
    observedGeneration?: number | null;
  };
  desiredProperties?: { value?: boolean; version?: number; source?: string };
};
type Thing = {
  thingId?: string;
  policyId?: string;
  attributes?: { vendor?: string };
  features?: { charging?: Feature };
};

test(
  'a decision lands in Ditto as desired state plus a Plug and Play acknowledgement',
  { skip: reachable ? false : `no Ditto at ${DITTO_URL} — run \`npm run up\`` },
  async () => {
    const deviceId = `dev-${Date.now()}`;
    const projector = createProjector(store);

    await projector.ensure(deviceId, 'hare');
    await projector.publish({
      deviceId,
      vendor: 'hare',
      phase: {
        phase: 'CONVERGED',
        since: instant(1_762_500_002_000),
        target: true,
        seen: deviceInstant(1_762_500_000_000),
        generation: generation(3),
      },
      obs: obs(),
      why: 'device reports it applied generation 3; confirmed exactly',
      desired: { charging: true, generation: 3, source: 'operator' },
    });

    const thing = (await store.readThing(deviceId)) as Thing | null;
    assert.ok(thing !== null, 'the thing must exist in Ditto');
    assert.equal(thing.thingId, `energy-test:${deviceId}`);
    // Ditto mints a default policy granting the creating subject full access
    // when a thing is created without one. Asserted because relying on it is a
    // decision (it is why no policy document is shipped), not an accident.
    assert.ok(typeof thing.policyId === 'string' && thing.policyId.length > 0);
    assert.equal(thing.attributes?.vendor, 'hare');

    const feature = thing.features?.charging;
    assert.ok(feature !== undefined, 'the charging feature must exist');

    // DESIRED: the counter is ours. Ditto maintains a `_revision` per thing, but
    // it advances on ANY modification including every reported-property write
    // from telemetry — unlike Kubernetes `metadata.generation`, which advances
    // only on a spec change. So it cannot say which instruction a device has
    // acted on, and the platform mints the counter instead. See src/twin/ditto.ts.
    assert.deepEqual(feature.desiredProperties, { value: true, version: 3, source: 'operator' });

    // REPORTED: Azure IoT Plug and Play's convention, not field names I invented.
    assert.deepEqual(feature.properties?.charging, {
      value: true,
      av: 3,
      ac: 200,
      ad: 'device reports it applied generation 3; confirmed exactly',
    });
    assert.equal(feature.properties?.charging?.av, feature.desiredProperties?.version);
    assert.equal(feature.properties?.powerDeliveryState, 'PLUGGED_IN:CHARGING');
    // Named for the clock it is on, because a twin store has no type system to
    // brand it with — the name is the only defence against somebody comparing
    // it to one of ours.
    assert.equal(feature.properties?.deviceTimeOnDeviceClock, 1_762_500_000_000);
  },
);

test(
  'an in-flight command is reported as 202 in progress, not as a confirmation',
  { skip: reachable ? false : `no Ditto at ${DITTO_URL}` },
  async () => {
    /*
     * The distinction this whole repository is about, visible to anything
     * reading the twin rather than only to us. PnP's 202 means "in progress,
     * expected to finish at 200 later" — an ack, not an actuation. A twin that
     * reported 200 here would be telling every subscriber that a command had
     * been applied when all that happened was that it was accepted.
     */
    const deviceId = `dev-${Date.now()}-issued`;
    const projector = createProjector(store);
    await projector.ensure(deviceId, 'tortoise');
    await projector.publish({
      deviceId,
      vendor: 'tortoise',
      phase: {
        phase: 'ISSUED',
        since: instant(1_762_500_002_000),
        target: true,
        deadline: instant(1_762_500_022_000),
        commandId: `${deviceId}/1`,
        generation: generation(4),
      },
      obs: obs({ powerDeliveryState: 'PLUGGED_IN:STOPPED', observedGeneration: generation(3) }),
      why: 'state differs from intent; converging',
      desired: { charging: true, generation: 4, source: 'schedule' },
    });

    const thing = (await store.readThing(deviceId)) as Thing | null;
    const ack = thing?.features?.charging?.properties?.charging;
    assert.equal(ack?.ac, 202, 'an acknowledged command must not be reported as applied');
    assert.equal(ack?.av, 4);
    // And the twin still shows what the device was last observed doing, which is
    // not the target yet.
    assert.equal(thing?.features?.charging?.properties?.powerDeliveryState, 'PLUGGED_IN:STOPPED');
  },
);

test(
  'the three fault kinds get different Plug and Play status codes',
  { skip: reachable ? false : `no Ditto at ${DITTO_URL}` },
  async () => {
    // A vendor rejection is a bad request in the device's own judgement; a
    // timeout is our inability to confirm. Different owners, so different
    // numbers — 400 and 500 — rather than one word "failed" that sends
    // everybody to the same wrong log.
    const projector = createProjector(store);
    for (const [reason, expected] of [
      ['rejected-by-vendor', 400],
      ['timeout-unconfirmed', 500],
    ] as const) {
      const deviceId = `dev-${Date.now()}-${reason}`;
      await projector.ensure(deviceId, 'badger');
      await projector.publish({
        deviceId,
        vendor: 'badger',
        phase: { phase: 'FAILED', since: instant(1_762_500_030_000), target: true, reason },
        obs: obs({ powerDeliveryState: 'PLUGGED_IN:STOPPED' }),
        why: `failed: ${reason}`,
        desired: { charging: true, generation: 5, source: 'operator' },
      });
      const thing = (await store.readThing(deviceId)) as Thing | null;
      assert.equal(thing?.features?.charging?.properties?.charging?.ac, expected, reason);
    }
  },
);

test(
  'a twin store that is down does not fail a decision',
  { skip: reachable ? false : `no Ditto at ${DITTO_URL}` },
  async () => {
    /*
     * The projection is not the critical path, and this is what that means
     * concretely: actuation goes through the outbox, which is transactional, and
     * the twin does not gate it. A reconciler that stopped controlling devices
     * because a twin store was unreachable would have chosen the wrong thing to
     * be strict about.
     *
     * Pointed at a port nothing is listening on, so the failure is a real
     * connection error rather than a mocked one.
     */
    const dead = createProjector(
      createTwinStore({
        baseUrl: 'http://127.0.0.1:1',
        namespace: 'energy-test',
        subject: 'nginx:ditto',
        timeout: defaultDittoTimeout,
      }),
    );
    // Must resolve, not reject. The failure is logged as twin.publish.failed.
    await dead.ensure('dev-nowhere', 'hare');
    await dead.publish({
      deviceId: 'dev-nowhere',
      vendor: 'hare',
      phase: { phase: 'IDLE', since: instant(0), seen: null },
      obs: obs(),
      why: 'nothing to do',
      desired: { charging: false, generation: 0, source: 'schedule' },
    });
  },
);

test('the acknowledgement mapping is total over every phase', () => {
  // No Ditto needed: the mapping is pure. Every phase must produce a status, or
  // a twin silently stops being updated for whichever phase was forgotten.
  for (const phase of ['IDLE', 'CONVERGED', 'ISSUED', 'SUSPENDED', 'FAILED']) {
    const ack = ackFor(phase, true, 1, 'why');
    assert.ok([200, 202, 400, 500].includes(ack.ac), `${phase} -> ${ack.ac}`);
    assert.equal(ack.av, 1);
  }
  // `ad` is bounded: a reason string is operator-facing prose and a twin
  // property is not a log sink.
  assert.equal(ackFor('CONVERGED', true, 1, 'x'.repeat(900)).ad.length, 500);
});
