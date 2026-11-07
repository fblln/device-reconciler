/**
 * server.ts — a runnable mock aggregator platform. Two channels, two clocks.
 *
 * WHAT THIS IS
 * ------------
 * The thing the reconciler talks to: a real HTTP service, with OAuth2
 * client-credentials, a paginated device list, a command endpoint that honours
 * `Idempotency-Key`, per-vendor rate limits that return 429 with `Retry-After`,
 * and webhook delivery that retries, duplicates and reorders. It runs as a
 * container in `docker compose`, and the integration tests start the same code
 * in-process on an ephemeral port.
 *
 * WHY THE FAKE IS IN THIS REPOSITORY RATHER THAN A RECORDED FIXTURE
 * -----------------------------------------------------------------
 * Because the behaviour under test is timing, and recorded fixtures have no
 * clock. The failures that matter here — an acknowledgement arriving minutes
 * before the state change it predicts, a snapshot captured before a command but
 * delivered after it, a device clock ten minutes fast, two snapshots delivered
 * in the wrong order — are emergent properties of a world with independent
 * delays. A fixture can only replay the ones somebody already thought to
 * record. This also makes the whole repository runnable with no credentials and
 * no vendor account, which is the point of the agentic-devex constraint: an
 * agent can reproduce a production-shaped failure on a laptop with no network.
 *
 * WHAT IT DOES NOT FAKE
 * ---------------------
 * ponytail: the token is a random string with an expiry and no JWT, no scopes,
 * no refresh; pagination is an opaque offset cursor; there is no TLS. Each is a
 * thing the reconciler's client already handles generically, and none changes a
 * decision the reconciler makes. Skipped deliberately rather than missed.
 */

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readBody, sendJson, sendText, serve, urlOf } from '../http.ts';
import { rng, type Rng } from '../core/lcg.ts';
import { freshBucket, take, type Bucket, type Limits } from '../core/ratelimit.ts';
import { instant } from '../core/time.ts';
import { sign } from '../core/signature.ts';
import type { CommandReportState } from '../core/reconcile.ts';
import { accept, advance, initialState, profileFor, VENDORS, type Capture, type DeviceState } from './sim.ts';

export type PlatformOptions = Readonly<{
  port: number;
  fleetSize: number;
  seed: number;
  /** The timescale everything is derived from. See the compressed-timeline note in sim.ts. */
  tickMs: number;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  /** Where to deliver telemetry and command reports. Empty disables delivery. */
  webhookUrl: string;
}>;

type Commanded = {
  commandId: string;
  deviceId: string;
  generation: number;
  target: boolean;
  state: CommandReportState;
  at: number;
};

type Delivery = { at: number; attempts: number; eventId: string; body: string };

export type PlatformStats = Readonly<{
  requests: number;
  rateLimited: number;
  /** Distinct commands accepted. */
  commands: number;
  /**
   * Requests that presented an Idempotency-Key already seen and were answered
   * from the original response WITHOUT creating a second command. The restart
   * test's whole assertion rests on this counter being non-zero while
   * `actuations` for the device stays at one.
   */
  idempotentReplays: number;
  /** Times a relay actually moved. The number that must never double-count. */
  actuations: number;
  webhooksSent: number;
  webhooksFailed: number;
  webhooksDuplicated: number;
}>;

export type Platform = Readonly<{
  url: string;
  stats: () => PlatformStats;
  stop: () => Promise<void>;
}>;

const now = (): number => Date.now();

const limitsFor = (vendor: string): Limits => {
  const v = VENDORS.find((x) => x.name === vendor) ?? VENDORS[0]!;
  return { perSecond: v.perSecond, burst: v.burst };
};

export function startPlatform(opts: PlatformOptions): Platform {
  const r: Rng = rng(opts.seed);

  const devices = new Map<string, DeviceState>();
  for (let i = 0; i < opts.fleetSize; i++) {
    const deviceId = `dev-${String(i).padStart(4, '0')}`;
    const vendor = VENDORS[i % VENDORS.length]!.name;
    const profile = profileFor(deviceId, vendor, opts.seed, opts.tickMs);
    devices.set(deviceId, initialState(profile, now()));
  }

  const buckets = new Map<string, Bucket>();

  /**
   * Idempotency store: key -> the response we already returned. This is the
   * contract that makes the reconciler's at-least-once outbox safe, so it is
   * modelled properly rather than waved at. Stripe's version keys on a header
   * and replays the original response for 24 hours; this does the same thing
   * without the expiry, because nothing here runs for a day.
   */
  const idempotency = new Map<string, { status: number; body: unknown }>();
  const commands = new Map<string, Commanded>();
  const deliveries: Delivery[] = [];

  const counters = {
    requests: 0,
    rateLimited: 0,
    commands: 0,
    idempotentReplays: 0,
    actuations: 0,
    webhooksSent: 0,
    webhooksFailed: 0,
    webhooksDuplicated: 0,
  };

  /** Bearer tokens. A random string and an expiry is all the client exercises. */
  const tokens = new Map<string, number>();

  const authorised = (header: string | undefined): boolean => {
    if (header === undefined || !header.startsWith('Bearer ')) return false;
    const expiry = tokens.get(header.slice(7));
    return expiry !== undefined && expiry > now();
  };

  // -------------------------------------------------------------------------
  // Webhook delivery. Signed, retried, sometimes duplicated, sometimes late.
  //
  // Delivery is at-least-once BY CONSTRUCTION here: a non-2xx response is
  // retried, and a device with `duplicatesWebhooks` sends a second copy of the
  // same event id on purpose. Both are what the reconciler's inbox unique index
  // exists for, and a simulator that always delivered exactly once would let a
  // missing dedupe pass every test.
  // -------------------------------------------------------------------------
  function enqueue(eventId: string, at: number, payload: unknown, duplicate: boolean): void {
    const body = JSON.stringify({ eventId, ...(payload as object) });
    deliveries.push({ at, attempts: 0, eventId, body });
    if (duplicate) {
      counters.webhooksDuplicated += 1;
      // A real redelivery is late, not simultaneous: the sender waits for an
      // acknowledgement that never came. Offsetting it means the duplicate
      // arrives after the original has been processed, which is the case a
      // read-then-write dedupe passes and a unique index is needed for.
      deliveries.push({ at: at + opts.tickMs, attempts: 0, eventId, body });
    }
  }

  async function deliver(d: Delivery): Promise<boolean> {
    if (opts.webhookUrl === '') return true;
    const signedAt = instant(now());
    try {
      const res = await fetch(opts.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-platform-signature': sign(opts.webhookSecret, signedAt, d.body),
        },
        body: d.body,
        // A hung receiver must not stall the delivery loop for everyone else.
        signal: AbortSignal.timeout(Math.max(2_000, opts.tickMs * 2)),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // The world loop: advance every device, queue the captures it produced, and
  // drain due deliveries. One timer for the whole fleet rather than a timer per
  // device, because a thousand timers is a thousand chances to leak one.
  // -------------------------------------------------------------------------
  let stopped = false;
  const pendingCaptures: Capture[] = [];

  async function tick(): Promise<void> {
    const t = now();
    for (const device of devices.values()) {
      const { captures, applied } = advance(device, t, r);
      pendingCaptures.push(...captures);
      for (const a of applied) {
        counters.actuations += 1;
        const command = commands.get(a.commandId);
        if (command !== undefined) {
          command.state = 'APPLIED';
          command.at = t;
          // Only some platforms report APPLIED at all, which is exactly why the
          // telemetry correlation path cannot be skipped. The ones that do are
          // authoritative and need no correlation.
          if (device.profile.reportsApplied) {
            enqueue(
              randomUUID(),
              t,
              { kind: 'report', deviceId: a.deviceId, commandId: a.commandId, state: 'APPLIED', at: t },
              false,
            );
          }
        }
      }
    }

    for (let i = pendingCaptures.length - 1; i >= 0; i--) {
      const c = pendingCaptures[i]!;
      if (c.deliverAt > t) continue;
      pendingCaptures.splice(i, 1);
      const device = devices.get(c.deviceId)!;
      enqueue(
        randomUUID(),
        t,
        {
          kind: 'telemetry',
          deviceId: c.deviceId,
          deviceTime: c.deviceTime,
          powerDeliveryState: c.powerDeliveryState,
          observedGeneration: c.observedGeneration,
        },
        device.profile.duplicatesWebhooks && r() < 0.3,
      );
    }

    const due = deliveries.filter((d) => d.at <= t).slice(0, 64);
    await Promise.all(
      due.map(async (d) => {
        const ok = await deliver(d);
        const at = deliveries.indexOf(d);
        if (ok) {
          counters.webhooksSent += 1;
          if (at >= 0) deliveries.splice(at, 1);
          return;
        }
        counters.webhooksFailed += 1;
        d.attempts += 1;
        // Give up after a few tries rather than growing the queue without
        // bound. A real platform does the same and then tells you on a
        // dashboard; losing an event is a case the reconciler must survive, and
        // the sweeper is what makes it survivable.
        if (d.attempts >= 5 && at >= 0) deliveries.splice(at, 1);
        else d.at = t + opts.tickMs * 2 ** d.attempts;
      }),
    );
  }

  const timer = setInterval(
    () => {
      if (!stopped) void tick();
    },
    Math.max(50, Math.round(opts.tickMs / 4)),
  );
  // The platform must not be the reason a test process refuses to exit.
  timer.unref();

  // -------------------------------------------------------------------------
  // Routes.
  // -------------------------------------------------------------------------
  const server: Server = serve(opts.port, async (req, res) => {
    counters.requests += 1;
    const url = urlOf(req);
    const path = url.pathname;

    // Health, deliberately before the auth check: a readiness probe that needs
    // a credential is a readiness probe that fails for the wrong reason. It
    // answers an ordinary HTTP request, which is what makes the container's
    // health check a plain `node` fetch rather than a shell holding a socket —
    // see the long note in the Dockerfile.
    if (path === '/healthz') return sendJson(res, 200, { ok: true, devices: devices.size });

    if (path === '/oauth/token' && req.method === 'POST') {
      const body = new URLSearchParams(await readBody(req));
      if (
        body.get('grant_type') !== 'client_credentials' ||
        body.get('client_id') !== opts.clientId ||
        body.get('client_secret') !== opts.clientSecret
      ) {
        return sendJson(res, 401, { error: 'invalid_client' });
      }
      const token = randomUUID();
      // Short on purpose: the client's refresh-on-401 path must be exercised by
      // an ordinary run, not only by a test that fast-forwards a clock.
      const ttl = 60_000;
      tokens.set(token, now() + ttl);
      return sendJson(res, 200, { access_token: token, token_type: 'Bearer', expires_in: ttl / 1000 });
    }

    if (path === '/admin/stats') return sendJson(res, 200, stats());

    if (!authorised(req.headers.authorization)) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }

    if (path === '/v1/devices' && req.method === 'GET') {
      // Opaque offset cursor. Pagination is here because a client that assumes
      // one page silently reconciles only the first N devices in the fleet —
      // a bug that is invisible until the fleet grows past a page.
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 25), 100);
      const offset = Number(Buffer.from(url.searchParams.get('cursor') ?? '', 'base64url').toString() || '0');
      const all = [...devices.values()];
      const page = all.slice(offset, offset + limit);
      const next =
        offset + limit < all.length ? Buffer.from(String(offset + limit)).toString('base64url') : null;
      return sendJson(res, 200, {
        devices: page.map((d) => ({ deviceId: d.profile.deviceId, vendor: d.profile.vendor })),
        nextCursor: next,
      });
    }

    const command = /^\/v1\/devices\/([^/]+)\/commands$/.exec(path);
    if (command !== null && req.method === 'POST') {
      const deviceId = command[1]!;
      const device = devices.get(deviceId);
      if (device === undefined) return sendJson(res, 404, { error: 'no such device' });

      const key = req.headers['idempotency-key'];
      const idempotencyKey = typeof key === 'string' ? key : null;
      if (idempotencyKey === null) {
        // Refusing the request without a key is the whole point: a platform that
        // accepts unkeyed commands cannot promise at-most-once actuation, and a
        // client that relies on the promise should find out immediately.
        return sendJson(res, 400, { error: 'Idempotency-Key required' });
      }
      const already = idempotency.get(idempotencyKey);
      if (already !== undefined) {
        counters.idempotentReplays += 1;
        return sendJson(res, already.status, already.body);
      }

      const bucket =
        buckets.get(device.profile.vendor) ?? freshBucket(instant(now()), limitsFor(device.profile.vendor));
      const grant = take(bucket, instant(now()), limitsFor(device.profile.vendor));
      buckets.set(device.profile.vendor, grant.bucket);
      if (grant.wait > 0) {
        counters.rateLimited += 1;
        res.setHeader('retry-after', String(Math.ceil(grant.wait / 1000)));
        // Deliberately NOT recorded in the idempotency store. A 429 is "ask
        // again", so caching it would make the retry return the same 429
        // forever, which is a deadlock the client could never escape.
        return sendJson(res, 429, { error: 'rate limited' });
      }

      const payload = JSON.parse(await readBody(req)) as { target: boolean; generation: number };
      const t = now();
      const state = accept(device, idempotencyKey, payload.generation, payload.target, t);
      const record: Commanded = {
        commandId: idempotencyKey,
        deviceId,
        generation: payload.generation,
        target: payload.target,
        state,
        at: t,
      };
      commands.set(idempotencyKey, record);
      counters.commands += 1;
      const body = { commandId: idempotencyKey, state, at: t };
      idempotency.set(idempotencyKey, { status: 202, body });
      // The acknowledgement also arrives on the webhook channel, because a
      // reconciler must not have to poll to learn a command was rejected.
      enqueue(randomUUID(), t, { kind: 'report', deviceId, commandId: idempotencyKey, state, at: t }, false);
      return sendJson(res, 202, body);
    }

    const report = /^\/v1\/commands\/([^/]+)$/.exec(path);
    if (report !== null && req.method === 'GET') {
      const found = commands.get(report[1]!);
      return found === undefined
        ? sendJson(res, 404, { error: 'no such command' })
        : sendJson(res, 200, { commandId: found.commandId, state: found.state, at: found.at });
    }

    return sendText(res, 404, 'not found');
  });

  const stats = (): PlatformStats => ({ ...counters });

  return {
    url: `http://localhost:${(server.address() as AddressInfo).port}`,
    stats,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
