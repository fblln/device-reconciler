/**
 * app.ts — the reconciler process. Wiring and loops; no decisions.
 *
 * THREE LOOPS, ONE PROCESS
 * ------------------------
 *   reconcile  claims due devices and decides. Driven by `wake_at`, which
 *              webhooks pull forward and the sweep pushes along.
 *   dispatch   drains the outbox. Separate from reconcile because deciding and
 *              sending cannot be made atomic — the whole reason the outbox
 *              exists (see db/schema.sql).
 *   sweep      marks quiet feeds dark and registers new devices. The
 *              completeness half of an otherwise event-driven system.
 *
 * ponytail: three `setInterval`-shaped async loops in one process, not three
 * services. They have independent failure modes and would be split in a real
 * deployment; at this size, splitting them would add two Dockerfiles and a
 * message broker to prove something the loops already demonstrate. They are
 * written as independent functions precisely so splitting them later is a
 * change to this file only.
 *
 * WHY THE LOOPS CANNOT KILL THE PROCESS
 * -------------------------------------
 * Every pass is wrapped: a throw is logged and the loop continues. A reconciler
 * that exits on a transient database error is a reconciler that stops managing
 * a fleet because of one network blip, and in Kubernetes it would crash-loop
 * while its in-flight commands time out. The failures that SHOULD stop the
 * process are startup failures — no database, no schema — and those are not
 * caught.
 */

import { handleIntent, operation, IntentError } from './service/intent.ts';
import { randomUUID } from 'node:crypto';
import { createEdgeAdapter } from './edge/adapter.ts';
import { loadConfig } from './config.ts';
import { rng } from './core/lcg.ts';
import { instant, type Duration, type Instant } from './core/time.ts';
import { staleAfter } from './service/sweep.ts';
import { createClient, defaultRequestTimeout } from './adapter/client.ts';
import { createGate } from './adapter/gate.ts';
import { createTwinStore, defaultDittoTimeout } from './twin/ditto.ts';
import { createProjector, noTwin } from './twin/project.ts';
import { connect, migrate } from './store/db.ts';
import { viewRows } from './store/devices.ts';
import { describe, present } from './core/presentation.ts';
import { reconcileBatch } from './service/worker.ts';
import { dispatchBatch } from './service/dispatcher.ts';
import { handleWebhook } from './service/ingest.ts';
import { markQuiet, syncFleet } from './service/sweep.ts';
import { buildReport, renderReport } from './service/report.ts';
import { createInstruments, log, startTelemetry } from './telemetry.ts';
import { sendJson, sendText, serve, urlOf } from './http.ts';

const cfg = loadConfig();
const now = (): Instant => instant(Date.now());
const sleep = (ms: Duration): Promise<void> => new Promise((r) => setTimeout(r, ms));

const telemetry = startTelemetry('reconciler', cfg.port + 1);
const instruments = createInstruments();

const db = connect(cfg.databaseUrl);
// Not caught: a process that cannot apply its schema must not come up pretending
// to work. Failing loudly at startup is the one place crashing is the right move.
await migrate(db, new URL('../db/schema.sql', import.meta.url).pathname);

const edge = process.env['HONO_TRANSPORT'] === 'true' ? createEdgeAdapter(db, cfg.dittoUrl) : null;
const client =
  edge?.client ??
  createClient({
    baseUrl: cfg.platformUrl,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    requestTimeout: defaultRequestTimeout,
    // When a 429 arrives without a parseable Retry-After, back off by the
    // breaker's cooloff rather than by zero. Treating a malformed header as
    // "retry immediately" turns one rate-limit response into a hot loop.
    defaultRetryAfter: cfg.breaker.cooloff,
  });
const gate = createGate(cfg.vendorLimits, cfg.breaker);

/*
 * The twin store, if one is configured. Eclipse Ditto holds desired and reported
 * state and, in its own words, leaves the reconciling between them to your
 * application — this process is that application. Postgres keeps the operational
 * state Ditto has no model for: the phase, the outbox, the durable timers.
 *
 * Absent by default so neither the tests nor a bare `node src/app.ts` require a
 * five-container stack to be up. See src/twin/ditto.ts for why that is safe and
 * what it costs.
 */
const twin =
  edge?.twin ??
  (cfg.dittoUrl === ''
    ? noTwin
    : createProjector(
        createTwinStore({
          baseUrl: cfg.dittoUrl,
          namespace: cfg.dittoNamespace,
          subject: cfg.dittoSubject,
          timeout: defaultDittoTimeout,
        }),
      ));
const dice = rng(cfg.seed ^ 0x5f5f);

const worker = {
  db,
  instruments,
  twin,
  cfg: {
    override: cfg.override,
    timing: cfg.timing,
    schedule: cfg.schedule,
    batchSize: cfg.batchSize,
    concurrency: cfg.concurrency,
    lease: cfg.lease,
  },
};
const dispatcher = {
  db,
  client,
  gate,
  instruments,
  rng: dice,
  cfg: { backoff: cfg.backoff, batchSize: cfg.batchSize, concurrency: cfg.concurrency },
};
const ingest = {
  db,
  instruments,
  cfg: { webhookSecret: cfg.webhookSecret, signatureTolerance: cfg.signatureTolerance },
};

let running = true;

/**
 * Run `pass` forever, pausing only when it found nothing to do. Busy devices
 * therefore reconcile back to back with no artificial delay, while an idle fleet
 * costs one claim query per `idlePause` — the alternative, a fixed tick, makes
 * the system's latency equal to the tick even when there is work waiting.
 */
async function loop(name: string, pass: (at: Instant) => Promise<number>): Promise<void> {
  // `running` is cleared by the SIGTERM/SIGINT handler at the bottom of this
  // file, which the linter cannot see from here. Polling a flag is the whole
  // shutdown mechanism: it lets the pass in flight finish rather than tearing
  // down mid-transaction.
  // oxlint-disable-next-line no-unmodified-loop-condition
  while (running) {
    try {
      const did = await pass(now());
      if (did === 0) await sleep(cfg.idlePause);
    } catch (error) {
      log(`${name}.error`, { error: String(error) });
      // Pause after an error. Without it, a persistent failure becomes a hot
      // loop that fills the logs faster than anyone can read them and starves
      // the other loops of the event loop.
      await sleep(cfg.idlePause);
    }
  }
}

const server = serve(cfg.port, async (req, res) => {
  const url = urlOf(req);

  if (url.pathname === '/webhooks' && req.method === 'POST') {
    return handleWebhook(ingest, req, res, now());
  }

  // Liveness: the process is up and the event loop is turning. Deliberately
  // does NOT touch the database — a liveness probe that fails when Postgres
  // blips restarts a process that was working fine and would have recovered,
  // which is how a database hiccup becomes a fleet-wide restart.
  if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });

  // Readiness: can we actually do the job? This one does touch the database,
  // because a reconciler that cannot reach Postgres can decide nothing and
  // should be taken out of rotation rather than restarted.
  if (url.pathname === '/readyz') {
    try {
      await db.query('select 1');
      return sendJson(res, 200, { ready: true });
    } catch (error) {
      return sendJson(res, 503, { ready: false, error: String(error) });
    }
  }

  /*
   * The view model, over HTTP, because it is the half of this design a user ever
   * sees. A UI reading this can show `confirming start (143s left)` instead of a
   * spinner, separate on/off buttons instead of a lying toggle for a device
   * nothing has ever been correlatable from, and which of the three timeout
   * faults happened instead of the word "failed". See src/core/presentation.ts.
   *
   * `line` is the same sentence the demo prints. It is included so an agent or a
   * curl can read the state without re-implementing the formatting, which is the
   * version of this that always drifts.
   */
  if (url.pathname === '/v1/devices' && req.method === 'GET') {
    const at = now();
    const devices = (await viewRows(db, at)).map((d) => {
      const view = present(at, d.phase, d.obs, d.clock, d.policy, d.lastWhy);
      return {
        deviceId: d.deviceId,
        vendor: d.vendor,
        phase: d.phase.phase,
        intent: d.stored,
        view,
        line: describe(view),
      };
    });
    return sendJson(res, 200, { devices });
  }

  if (url.pathname === '/readout') return sendJson(res, 200, await buildReport(db, gate));
  if (url.pathname === '/readout.txt') return sendText(res, 200, renderReport(await buildReport(db, gate)));

  const status = /^\/v1\/devices\/([^/]+)\/operations\/([^/]+)$/.exec(url.pathname);
  if (status && req.method === 'GET') {
    try {
      return sendJson(res, 200, await operation(db, decodeURIComponent(status[1]!), status[2]!));
    } catch (error) {
      if (error instanceof IntentError) return sendJson(res, error.status, { error: error.message });
      throw error;
    }
  }
  const intent = /^\/v1\/devices\/([^/]+)\/intent(\/retry)?$/.exec(url.pathname);
  if (intent && req.method === (intent[2] ? 'POST' : 'PUT')) {
    return handleIntent(req, res, db, decodeURIComponent(intent[1]!), Boolean(intent[2]), now());
  }

  return sendText(res, 404, 'not found');
});

log('reconciler.started', {
  port: cfg.port,
  metricsPort: cfg.port + 1,
  platform: cfg.platformUrl,
  publicUrl: cfg.publicUrl,
  instance: randomUUID(),
});

void loop('reconcile', (at) => reconcileBatch(worker, at));
void loop('dispatch', (at) => dispatchBatch(dispatcher, at));
void loop('sweep', async (at) => {
  await markQuiet(db, { staleAfter: staleAfter(cfg.schedule.sweepInterval) }, at);
  await syncFleet(db, client, twin, at);
  await edge?.ingest();
  // Always "nothing found", so the loop always pauses: the sweep is a periodic
  // job and must not spin just because it registered a device.
  return 0;
});

/**
 * Graceful shutdown. Stop accepting webhooks, let the loops finish their pass,
 * then close the pool. The leases are what make this safe to get wrong: a
 * worker killed holding devices leaves claims that expire, so even SIGKILL
 * costs one lease interval and no correctness.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log('reconciler.stopping', { signal });
    running = false;
    server.close();
    void (async () => {
      await sleep(cfg.idlePause);
      await telemetry.shutdown().catch(() => undefined);
      await db.end().catch(() => undefined);
      process.exit(0);
    })();
  });
}
