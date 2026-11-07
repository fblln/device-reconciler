/**
 * ditto.ts — the twin store, which is a real project rather than a mock.
 *
 * WHY ECLIPSE DITTO IS HERE AT ALL
 * --------------------------------
 * Ditto is an open-source digital-twin framework that separates REPORTED state
 * (what the device said) from DESIRED state (what a backend wants), persists
 * both and indexes them for search. Its own documentation then says, of the gap
 * between the two: "The logic for reconciling desired state with actual state
 * is up to your application or device firmware."
 *
 * That sentence is the reason this repository exists, and it is why the twin
 * here is Ditto and not something I wrote. Ditto holds the two states and does
 * not drive the device toward the target. The loop that does is the thing being
 * demonstrated, and demonstrating it against the project whose docs ask for it
 * is worth considerably more than demonstrating it against a fake that agrees
 * with me by construction.
 *
 * WHAT IS IN POSTGRES AND WHAT IS IN DITTO, AND WHY THAT SPLIT IS NOT ARBITRARY
 * ----------------------------------------------------------------------------
 * Ditto models a twin: the state of a thing, now. It has no model at all for
 * the things this repository is about — a command in flight, its deadline, its
 * delivery attempts, whether it has been dispatched exactly once, when a timer
 * must fire after a restart. So:
 *
 *   Ditto      desired and reported state, per device, queryable, with its own
 *              revision and ETags. The twin OF RECORD for state.
 *   Postgres   the operational state: phase, outbox, inbox, durable timers,
 *              leases, the decision log. None of it is twin state and none of
 *              it belongs in a twin store.
 *
 * Putting the phase in Ditto would mean encoding a state machine as twin
 * properties and losing transactions, which is how the outbox stops being
 * atomic. Putting the twin in Postgres would mean reimplementing Ditto badly.
 *
 * DITTO'S `_revision` IS NOT A GENERATION, AND THIS IS THE IMPORTANT ONE
 * ---------------------------------------------------------------------
 * The obvious-looking shortcut here is to let Ditto mint the desired-state
 * counter, the way Kubernetes' API server sets `metadata.generation` and Azure
 * IoT Hub manages the desired section's `$version`. Ditto does maintain a
 * `_revision` per thing, and it is monotonic, and it is tempting.
 *
 * It is also wrong for this purpose. `metadata.generation` advances only when
 * the SPEC changes; Ditto's `_revision` advances on ANY modification to the
 * thing, which includes every reported-property write that lands from
 * telemetry. A counter that moves when the device reports in cannot tell us
 * which instruction the device has acted on — it would advance several times
 * between a command and its confirmation, for reasons that have nothing to do
 * with the command.
 *
 * So the platform mints the generation itself, per device, in Postgres (see
 * src/store/devices.ts). That is not a preference; it is forced by what
 * `_revision` means. Clients never invent one.
 *
 * WHY A FAILED PUBLISH DOES NOT FAIL A DECISION
 * ---------------------------------------------
 * Every write here publishes CURRENT STATE, not an event. It is idempotent and
 * last-write-wins, and the next decision for a device re-publishes whatever is
 * true then — so a write lost to a Ditto restart is repaired by the next sweep
 * rather than lost forever. That is what makes it safe to log a failure and
 * carry on, and it is the difference between a projection and a critical path:
 * actuation goes through the outbox, which is transactional, and the twin does
 * not gate it. A reconciler that stops controlling devices because a twin store
 * is down has chosen the wrong thing to be strict about.
 *
 * AUTHENTICATION
 * --------------
 * Ditto's own compose deployment puts nginx in front of the gateway to do basic
 * auth, and nginx then forwards the verified identity as
 * `x-ditto-pre-authenticated: nginx:<user>` (this is literally what its
 * nginx.conf sets). With `ENABLE_PRE_AUTHENTICATION=true` on the gateway we can
 * send that header directly and drop nginx, its htpasswd file, its mime types
 * and the two UI containers from the compose file — four services and a pile of
 * mounted config, for one header. The trust model is unchanged for a local
 * stack: whoever can reach the gateway is trusted, which with no published port
 * and no cloud is the compose network.
 */

import { duration, type Duration } from '../core/time.ts';

/** The one feature. One boolean intent, as in the sibling repo. */
const FEATURE = 'charging';

export type DittoConfig = Readonly<{
  /** Base URL of the Ditto gateway, e.g. http://ditto:8080 */
  baseUrl: string;
  /** Thing namespace. Ditto thing ids are `namespace:name`. */
  namespace: string;
  /** The pre-authenticated subject, `<issuer>:<subject>`. */
  subject: string;
  timeout: Duration;
}>;

/**
 * Azure IoT Plug and Play's acknowledgement convention, which this adopts
 * rather than inventing field names.
 *
 * A device confirms a writable property by reporting it back with:
 *
 *   av  acknowledgement version — the desired version it is acknowledging.
 *   ac  status, using HTTP status semantics: 200 accepted and applied, 202 in
 *       progress and expected to finish at 200 later, 400 refused, 500 failed.
 *   ad  optional description.
 *
 * Two things follow from reading that spec, and both are load-bearing here. The
 * counter is minted by the hub and not by a client — which is requirement 2 of
 * this repository. And 202 is a state worth having, because a command that
 * times out having only ever been acknowledged and one that times out after the
 * device said it was working on it are different faults with different owners.
 */
export type Ack = Readonly<{
  value: boolean;
  av: number;
  ac: 200 | 202 | 400 | 500;
  ad: string;
}>;

export type Desired = Readonly<{
  value: boolean;
  /**
   * The platform-minted counter. Named `version` to echo PnP's `$version`, and
   * minted here rather than by Ditto for the reason in the header.
   */
  version: number;
  source: string;
}>;

export type TwinStore = Readonly<{
  /** Create the thing if we have never seen this device. Idempotent. */
  ensure: (deviceId: string, vendor: string) => Promise<void>;
  publishDesired: (deviceId: string, desired: Desired) => Promise<void>;
  publishReported: (
    deviceId: string,
    ack: Ack,
    observed: Readonly<{ powerDeliveryState: string; deviceTime: number; observedGeneration: number | null }>,
  ) => Promise<void>;
  readDesired: (deviceId: string) => Promise<Desired | null>;
  /** For the integration test and the readout: the thing as Ditto holds it. */
  readThing: (deviceId: string) => Promise<unknown | null>;
  alive: () => Promise<boolean>;
}>;

export const defaultDittoTimeout = duration(5_000);

/*
 * A function, not an Error subclass. Nothing in this repository branches on the
 * status — every failure here is logged and swallowed by the projector — so the
 * fields would be write-only, and the one caller that reads anything reads the
 * message. ponytail: add a subclass when something needs to tell a 403 from a
 * 503 in order to behave differently.
 */
const dittoError = (status: number, body: string, method: string, path: string): Error =>
  new Error(`ditto ${method} ${path} -> ${status}: ${body.slice(0, 200)}`);

export function createTwinStore(cfg: DittoConfig): TwinStore {
  const thingId = (deviceId: string): string => `${cfg.namespace}:${deviceId}`;

  /*
   * encodeURIComponent on the thing id, not on the whole path. A thing id is
   * `namespace:name`, and the colon is structural — encoding it to %3A gives a
   * 400 from Ditto's own route matcher. Encoding the device id separately is
   * what makes a vendor id containing a slash or a space addressable at all.
   */
  const thingPath = (deviceId: string, suffix = ''): string =>
    `/api/2/things/${cfg.namespace}:${encodeURIComponent(deviceId)}${suffix}`;

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(new URL(path, cfg.baseUrl), {
      method,
      headers: {
        // The identity nginx would have forwarded. See the header note.
        'x-ditto-pre-authenticated': cfg.subject,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(cfg.timeout),
    });
    return res;
  }

  async function write(method: string, path: string, body: unknown): Promise<void> {
    const res = await call(method, path, body);
    // 201 on create, 204 on update, 200 on some sub-resources. Anything else is
    // thrown so the caller can log it and move on — see the projection note.
    if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
      throw dittoError(res.status, await res.text(), method, path);
    }
  }

  async function readJson(path: string): Promise<unknown | null> {
    const res = await call('GET', path);
    if (res.status === 404) return null;
    if (!res.ok) throw dittoError(res.status, await res.text(), 'GET', path);
    return (await res.json()) as unknown;
  }

  return {
    async ensure(deviceId, vendor) {
      /*
       * A whole-thing PUT, which REPLACES the thing — so this must only ever run
       * for a device we have not registered before, and the caller is
       * `register()`'s boolean return (an `on conflict do nothing` insert). The
       * alternative, a PUT on every sweep, would wipe the reported properties of
       * every device in the fleet every thirty seconds.
       *
       * The policy is left to Ditto: creating a thing without one makes Ditto
       * mint a default policy granting the creating subject full access, which
       * is exactly what is wanted for a single-tenant local stack and avoids
       * shipping a policy document that would need to be kept in step with the
       * subject above.
       */
      await write('PUT', thingPath(deviceId), {
        thingId: thingId(deviceId),
        attributes: { vendor, managedBy: 'device-reconciler-platform' },
        features: { [FEATURE]: { properties: {}, desiredProperties: {} } },
      });
    },

    async publishDesired(deviceId, desired) {
      await write('PUT', thingPath(deviceId, `/features/${FEATURE}/desiredProperties`), desired);
    },

    async publishReported(deviceId, ack, observed) {
      // One PUT of the whole properties object rather than four of its leaves:
      // Ditto emits a change event per modification, and a UI subscribed to the
      // twin should see one coherent state rather than four partial ones.
      await write('PUT', thingPath(deviceId, `/features/${FEATURE}/properties`), {
        [FEATURE]: ack,
        powerDeliveryState: observed.powerDeliveryState,
        // On the DEVICE's clock, and labelled so nobody compares it to anything
        // else in the twin. The name is the only defence available here: a twin
        // store has no type system to brand it with.
        deviceTimeOnDeviceClock: observed.deviceTime,
        observedGeneration: observed.observedGeneration,
      });
    },

    async readDesired(deviceId) {
      const body = await readJson(thingPath(deviceId, `/features/${FEATURE}/desiredProperties`));
      if (body === null || typeof body !== 'object') return null;
      const d = body as Partial<Desired>;
      // Shape-checked rather than trusted: this is state a human may have
      // edited in Ditto's own UI, which is a trust boundary of the "somebody
      // typed it" kind rather than the hostile kind.
      if (typeof d.value !== 'boolean' || typeof d.version !== 'number') return null;
      return { value: d.value, version: d.version, source: String(d.source ?? 'unknown') };
    },

    readThing(deviceId) {
      return readJson(thingPath(deviceId));
    },

    async alive() {
      /*
       * `/status/health`, NOT `/health`, and the difference cost a confusing
       * half hour.
       *
       * On this stack `/health` answers 503 `{"status":"DOWN"}` while
       * `/status/health` answers 200 `{"status":"UP"}` and every API call works
       * perfectly. The gateway is up; something it expects to see is not. The
       * likely reason is that `/health` is an aggregate over the whole Ditto
       * cluster and this compose file deliberately omits two of the five
       * services Ditto normally runs — things-search, which only matters for RQL
       * search queries, and connectivity, which only matters for Ditto's own
       * AMQP/MQTT/Kafka connections. Neither is reachable from here, and Ditto
       * exposes no detail on the aggregate to confirm it, so that reason is
       * inferred rather than established.
       *
       * What is established is which probe answers the question this function
       * asks — "can I talk to the twin store?" — and it is the one that returns
       * UP while writes succeed. A probe that reports a healthy dependency as
       * down is worse than no probe: it sends somebody to debug the wrong thing.
       *
       * Either way it is a real HTTP request, which proves a server parsed and
       * answered rather than that a port is bound, and it is not the shell
       * redirection every reverse-shell detector is written against. See the
       * Dockerfile.
       */
      try {
        const res = await call('GET', '/status/health');
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Which PnP status a phase reports, and why each one.
 *
 * This is the mapping that makes the twin honest to anything reading it rather
 * than only to us: a UI, a dashboard or another service subscribed to Ditto
 * sees the SAME three-way distinction the reconciler makes internally, in the
 * vocabulary of a published convention rather than in ours.
 */
export function ackFor(
  phase: string,
  target: boolean,
  generation: number,
  why: string,
  failReason?: string,
): Ack {
  const ad = why.slice(0, 500);
  switch (phase) {
    case 'CONVERGED':
      return { value: target, av: generation, ac: 200, ad };
    case 'ISSUED':
      // 202: in progress, expected to finish at 200. The one PnP state that is
      // diagnostic rather than confirmatory, and the reason this convention
      // beats a binary ack.
      return { value: target, av: generation, ac: 202, ad };
    case 'FAILED':
      // 400 for a refusal, 500 for a failure: a vendor rejection is a bad
      // request in the device's own judgement, and a timeout is our inability
      // to confirm. Different owners, different numbers, as PnP intends.
      return { value: target, av: generation, ac: failReason === 'rejected-by-vendor' ? 400 : 500, ad };
    default:
      // IDLE and SUSPENDED: nothing is being asserted, so there is nothing to
      // acknowledge. 200 with the observed value is the honest report — the
      // twin should not claim an in-flight command that does not exist.
      return { value: target, av: generation, ac: 200, ad };
  }
}
