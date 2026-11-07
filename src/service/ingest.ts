/**
 * ingest.ts — the webhook endpoint. The only part of this system an outsider
 * can reach, and therefore the only real trust boundary in it.
 *
 * WHY THIS IS A SECURITY SURFACE AND NOT A CONVENIENCE
 * ----------------------------------------------------
 * Both channels arrive here, and both drive actuation. A forged `APPLIED`
 * report makes the reconciler tell a user their car is charging when it is not;
 * a forged `UNPLUGGED` snapshot makes it stop trying. An unauthenticated
 * webhook endpoint in this system is a remote control for the fleet. So every
 * request is verified (src/core/signature.ts) before anything is parsed beyond
 * the raw body, and a failure returns a flat 401 with no detail — the distinct
 * failure reasons go to metrics, not to the prober.
 *
 * WHY A DUPLICATE IS A 2xx
 * ------------------------
 * The platform delivers at least once. From its point of view a duplicate it
 * already sent successfully is a success, and answering an error teaches an
 * at-least-once sender to retry forever — turning our deduplication into a
 * permanent load source. So a duplicate is accepted, counted, and does nothing.
 *
 * WHY THE CLOCK MODEL IS FOLDED HERE
 * ----------------------------------
 * This is the one place that sees each snapshot EXACTLY ONCE, because the inbox
 * unique index has already removed the duplicates. The cross-clock delay
 * estimate is a minimum over samples, and the sample COUNT is how an operator
 * judges whether to trust it; folding in the worker instead would count wakes
 * rather than snapshots and make that number meaningless.
 *
 * WHY INGEST WAKES THE DEVICE INSTEAD OF RECONCILING IT
 * -----------------------------------------------------
 * It pulls `wake_at` forward and returns. Reconciling inline would put an
 * unbounded amount of work — a decision, a database transaction, possibly a
 * command dispatch — inside an HTTP handler whose caller has a timeout and a
 * retry, so a slow decision would produce a redelivery, which would produce
 * another decision. The queue is bounded on purpose and the handler must not be
 * a way around it.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { observeClock } from '../core/clock.ts';
import { SIGNATURE_HEADER, verify } from '../core/signature.ts';
import { deviceInstant, instant, type Duration, type Instant } from '../core/time.ts';
import type { CommandReportState, PowerDeliveryState } from '../core/reconcile.ts';
import { readBody, sendJson } from '../http.ts';
import { tx, type Db, type Queryable } from '../store/db.ts';
import { accept, markProcessed } from '../store/inbox.ts';
import { recordReport, recordTelemetry } from '../store/channels.ts';
import { rows } from '../store/db.ts';
import { isManaged, wake } from '../store/devices.ts';
import { log, type Instruments } from '../telemetry.ts';

export type IngestConfig = Readonly<{ webhookSecret: string; signatureTolerance: Duration }>;

export type IngestDeps = Readonly<{ db: Db; cfg: IngestConfig; instruments: Instruments }>;

type TelemetryEvent = Readonly<{
  eventId: string;
  kind: 'telemetry';
  deviceId: string;
  deviceTime: number;
  powerDeliveryState: PowerDeliveryState;
  observedGeneration: number | null;
}>;

type ReportEvent = Readonly<{
  eventId: string;
  kind: 'report';
  deviceId: string;
  commandId: string;
  state: CommandReportState;
  at: number;
}>;

type Event = TelemetryEvent | ReportEvent;

export async function handleWebhook(
  deps: IngestDeps,
  req: IncomingMessage,
  res: ServerResponse,
  now: Instant,
): Promise<void> {
  const raw = await readBody(req);
  const header = req.headers[SIGNATURE_HEADER];
  const verdict = verify(
    typeof header === 'string' ? header : undefined,
    raw,
    deps.cfg.webhookSecret,
    now,
    deps.cfg.signatureTolerance,
  );
  if (!verdict.ok) {
    deps.instruments.webhooks.add(1, { outcome: 'unauthorized', reason: verdict.reason });
    // Flat 401, no detail. The reasons are useful to us and would be a map of
    // the checks to whoever is probing.
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  let event: Event;
  try {
    event = JSON.parse(raw) as Event;
  } catch {
    return sendJson(res, 400, { error: 'malformed body' });
  }
  if (typeof event.eventId !== 'string' || typeof event.deviceId !== 'string') {
    return sendJson(res, 400, { error: 'missing eventId or deviceId' });
  }

  const accepted = await tx(deps.db, async (client) => {
    const fresh = await accept(client, {
      eventId: event.eventId,
      deviceId: event.deviceId,
      kind: event.kind === 'report' ? 'report' : 'telemetry',
      payload: event,
      signedAt: verdict.signedAt,
      receivedAt: now,
    });
    if (!fresh) return false;

    /*
     * A signed event for a device we do not manage is recorded and then left
     * alone. Found by test/integration/ingest.test.ts, where it was a 500.
     *
     * `observation` and `command_report` both reference `device`, so applying an
     * event for an unknown device raises a foreign-key violation, which rolls
     * the transaction back and answers 500. That is the worst possible reply
     * here: the platform delivers at least once, so a 5xx teaches it to retry
     * forever, and this reconciler's own reasoning for answering 2xx to a
     * duplicate applies with more force to an event that can NEVER succeed.
     * One misconfigured device would have become permanent load on both sides.
     *
     * It is not dropped silently either. The row stays in the inbox with
     * `processed_at` null, which is exactly the right record: something is
     * posting us signed events for a device the platform never listed, and that
     * is a misconfiguration somebody needs to see. The fleet is discovered from
     * the platform and nowhere else — letting a webhook register a device would
     * mean whoever can reach this endpoint can add to the fleet.
     */
    if (!(await isManaged(client, event.deviceId))) {
      log('ingest.unknown-device', { eventId: event.eventId, deviceId: event.deviceId });
      return true;
    }

    if (event.kind === 'report') await applyReport(client, event, now);
    else await applyTelemetry(client, event, now);
    await markProcessed(client, event.eventId, now);
    return true;
  });

  deps.instruments.webhooks.add(1, {
    outcome: accepted ? 'accepted' : 'duplicate',
    kind: event.kind === 'report' ? 'report' : 'telemetry',
  });
  if (!accepted) log('ingest.duplicate', { eventId: event.eventId, deviceId: event.deviceId });
  return sendJson(res, 200, { accepted });
}

async function applyTelemetry(q: Queryable, event: TelemetryEvent, now: Instant): Promise<void> {
  await recordTelemetry(q, {
    deviceId: event.deviceId,
    // Arriving at all is what proves the feed is live. The sweeper is what marks
    // it dark again when nothing arrives for a while — a webhook can only ever
    // be evidence of liveness, never of its absence.
    isReachable: true,
    deviceTime: deviceInstant(event.deviceTime),
    receivedAt: now,
    powerDeliveryState: event.powerDeliveryState,
    observedGeneration: event.observedGeneration,
  });
  await foldClock(q, event.deviceId, now, event.deviceTime);
  await wake(q, event.deviceId, now);
}

async function applyReport(q: Queryable, event: ReportEvent, now: Instant): Promise<void> {
  await recordReport(q, {
    deviceId: event.deviceId,
    commandId: event.commandId,
    state: event.state,
    // Stamped on OUR clock, which is exactly why the command channel needs no
    // correlation. `at` as reported by the platform is used, not `now`: it is
    // the platform's record of when the device acknowledged, and both are on
    // our side of the clock boundary.
    at: instant(event.at),
  });
  await wake(q, event.deviceId, now);
}

/**
 * Fold one cross-clock delay sample into the device's estimate, inside the
 * ingest transaction.
 *
 * `for update` because this is a read-modify-write of a column two concurrent
 * webhook deliveries can touch. Without the lock, two snapshots arriving
 * together would each read the old model and the later write would discard the
 * other's sample — losing the very minimum that might have tightened the
 * estimate. The lock is per device row, so it costs nothing at fleet scale.
 *
 * A device with no row yet is ignored rather than created: registration is the
 * fleet sync's job, and a webhook for an unknown device is either a race with
 * registration (which will resolve) or data about a device we are not managing.
 */
async function foldClock(
  q: Queryable,
  deviceId: string,
  receivedAt: Instant,
  deviceTime: number,
): Promise<void> {
  const [current] = await rows<{ clock: { minDelay: number | null; samples: number } }>(
    q,
    `select clock from device where device_id = $1 for update`,
    [deviceId],
  );
  if (current === undefined) return;
  const next = observeClock(
    { minDelay: current.clock.minDelay as never, samples: current.clock.samples },
    receivedAt,
    deviceInstant(deviceTime),
  );
  await q.query(`update device set clock = $2 where device_id = $1`, [deviceId, JSON.stringify(next)]);
}
