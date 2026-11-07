/**
 * inbox.ts — the deduplication ledger for everything that arrives from outside.
 *
 * WHY A TABLE AND NOT A CACHE
 * ---------------------------
 * The platform delivers at least once. A webhook whose acknowledgement is lost
 * is redelivered, and a signature stays valid for its whole freshness window so
 * a captured request can be replayed on purpose. Both show up as the same event
 * id arriving twice, and the second copy must be a no-op — a replayed `APPLIED`
 * report would re-confirm a command, and a replayed stale snapshot would look
 * like drift and trigger a re-issue.
 *
 * An in-memory set would lose its memory exactly when redelivery is most likely:
 * right after the restart that caused the acknowledgement to be lost. So the
 * ledger is a unique index, and `insert ... on conflict do nothing` returning no
 * row IS the duplicate check. One statement, no race, no read-then-write window
 * for two concurrent deliveries of the same event to slip through.
 *
 * The signature's freshness window (src/core/signature.ts) is what keeps this
 * table finite; without it, replay protection would require remembering every
 * event id forever.
 */

import type { Instant } from '../core/time.ts';
import { rows, type Queryable } from './db.ts';

export type EventKind = 'telemetry' | 'report';

/**
 * Returns false if this event has already been accepted. The caller must then
 * answer 2xx anyway: a duplicate is a success from the sender's point of view,
 * and answering an error teaches an at-least-once sender to retry forever.
 */
export async function accept(
  q: Queryable,
  event: Readonly<{
    eventId: string;
    deviceId: string;
    kind: EventKind;
    payload: unknown;
    signedAt: Instant;
    receivedAt: Instant;
  }>,
): Promise<boolean> {
  const inserted = await rows<{ event_id: string }>(
    q,
    `insert into inbox (event_id, device_id, kind, payload, signed_at, received_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (event_id) do nothing
       returning event_id`,
    [
      event.eventId,
      event.deviceId,
      event.kind,
      JSON.stringify(event.payload),
      event.signedAt,
      event.receivedAt,
    ],
  );
  return inserted.length === 1;
}

export async function markProcessed(q: Queryable, eventId: string, now: Instant): Promise<void> {
  await q.query(`update inbox set processed_at = $2 where event_id = $1`, [eventId, now]);
}

export type InboxStats = Readonly<{ accepted: number; duplicates: number }>;

/**
 * `duplicates` is counted by the ingest handler in memory and reported through
 * metrics, not from here — a rejected duplicate leaves no row by construction,
 * which is the point. This returns only what the table knows.
 */
export async function countAccepted(q: Queryable): Promise<number> {
  const [row] = await rows<{ n: string }>(q, `select count(*)::text as n from inbox`);
  return Number(row?.n ?? 0);
}
