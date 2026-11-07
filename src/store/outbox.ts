/**
 * outbox.ts — "we decided to send this" as a durable row, separate from sending.
 *
 * THE FAILURE THIS FILE EXISTS FOR
 * --------------------------------
 * Deciding to command a device and actually commanding it are two writes to two
 * different systems, and two systems cannot be updated atomically. So one of
 * them has to go first, and both orderings are broken:
 *
 *   POST then write phase    crash in between and the device has the command
 *                            while our state says we never sent one. On restart
 *                            we send it again — a DUPLICATE ACTUATION, the
 *                            exact failure this design exists to prevent.
 *   write phase then POST    crash in between and we believe a command is in
 *                            flight that was never sent. It times out and gets
 *                            reported as a device failure. A LOST COMMAND, and
 *                            a lie about the device.
 *
 * The outbox makes the only atomic write that matters — the new phase and the
 * intent to send, in one transaction — and demotes delivery to a retryable
 * background drain. Delivery is then at-least-once, which is acceptable ONLY
 * because `command_id` is both this table's primary key and the Idempotency-Key
 * on the wire: the platform returns the original response for a repeat, so a
 * duplicate delivery cannot produce a second actuation. The two halves are a
 * pair, and either alone is unsafe.
 *
 * test/integration/restart.test.ts kills the process in the window between the
 * commit and the send, restarts it, and asserts the device was actuated once.
 */

import { instant, type Instant } from '../core/time.ts';
import type { Command } from '../core/reconcile.ts';
import { rows, type Queryable } from './db.ts';

export type Pending = Readonly<{
  commandId: string;
  deviceId: string;
  vendor: string;
  generation: number;
  target: boolean;
  attempts: number;
  createdAt: Instant;
}>;

/**
 * Note `on conflict do nothing`. The command id comes from a per-device counter,
 * so a retried transaction that re-derives the same id must not fail the whole
 * reconcile — it has already recorded exactly the right intent.
 */
export async function enqueue(q: Queryable, deviceId: string, command: Command, now: Instant): Promise<void> {
  await q.query(
    `insert into outbox (command_id, device_id, generation, target, created_at, next_attempt_at)
       values ($1, $2, $3, $4, $5, $5)
       on conflict (command_id) do nothing`,
    [command.commandId, deviceId, command.generation, command.target, now],
  );
}

/**
 * Claim due commands for dispatch. Same `for update skip locked` pattern as the
 * device claim: several dispatchers can drain in parallel and never pick up the
 * same row.
 *
 * Unlike the device claim there is no lease, because the work is a single HTTP
 * call bounded by a request timeout, and `next_attempt_at` is pushed forward
 * before the call is made — so a dispatcher that dies holding a row leaves it
 * invisible only until its backoff elapses, after which it is retried. That is
 * the correct behaviour anyway: a dispatch whose outcome we never learned has to
 * be retried, and the idempotency key makes the retry free.
 */
export async function claimDue(q: Queryable, now: Instant, limit: number): Promise<Pending[]> {
  const result = await rows<{
    command_id: string;
    device_id: string;
    vendor: string;
    generation: string;
    target: boolean;
    attempts: number;
    created_at: string;
  }>(
    q,
    `with due as (
       select command_id from outbox
         where dispatched_at is null and abandoned_at is null and next_attempt_at <= $1
         order by next_attempt_at
         limit $2
         for update skip locked
     )
     select o.command_id, o.device_id, d.vendor, o.generation, o.target, o.attempts, o.created_at
       from outbox o
       join due on due.command_id = o.command_id
       join device d on d.device_id = o.device_id`,
    [now, limit],
  );
  return result.map((r) => ({
    commandId: r.command_id,
    deviceId: r.device_id,
    vendor: r.vendor,
    generation: Number(r.generation),
    target: r.target,
    attempts: r.attempts,
    createdAt: instant(Number(r.created_at)),
  }));
}

/**
 * Push a row out of the way before attempting it, so a crash mid-attempt cannot
 * produce a hot retry loop. Called in its own transaction, deliberately BEFORE
 * the HTTP call rather than after it: a row whose attempt count only rises on a
 * recorded failure will be retried immediately and forever by a process that
 * keeps dying during the call.
 */
export async function beginAttempt(q: Queryable, commandId: string, nextAt: Instant): Promise<void> {
  await q.query(`update outbox set attempts = attempts + 1, next_attempt_at = $2 where command_id = $1`, [
    commandId,
    nextAt,
  ]);
}

/**
 * Reschedule WITHOUT consuming an attempt: the request was never made. Used
 * when our own limiter or breaker refused it. Charging a local decision against
 * the vendor's retry budget would let a quiet period abandon a command that
 * nothing was ever wrong with.
 */
export async function defer(q: Queryable, commandId: string, at: Instant): Promise<void> {
  await q.query(`update outbox set next_attempt_at = $2 where command_id = $1`, [commandId, at]);
}

/**
 * Reschedule and GIVE BACK the attempt. Used for a 429: the request was made,
 * so `beginAttempt` had already counted it, but nothing was delivered and the
 * vendor itself said when to come back. A command abandoned for being throttled
 * is a command abandoned for being popular. `greatest(attempts - 1, 0)` because
 * the floor matters more than the bookkeeping if this is ever called twice.
 */
export async function returnAttempt(q: Queryable, commandId: string, at: Instant): Promise<void> {
  await q.query(
    `update outbox set attempts = greatest(attempts - 1, 0), next_attempt_at = $2 where command_id = $1`,
    [commandId, at],
  );
}

export async function markDispatched(q: Queryable, commandId: string, now: Instant): Promise<void> {
  await q.query(`update outbox set dispatched_at = $2, last_error = null where command_id = $1`, [
    commandId,
    now,
  ]);
}

export async function recordFailure(
  q: Queryable,
  commandId: string,
  nextAt: Instant | null,
  now: Instant,
  error: string,
): Promise<void> {
  // nextAt null means the attempt budget is spent. The row is abandoned rather
  // than deleted: "we stopped trying to send this" is the single most important
  // thing for an operator to be able to ask about, and a row that deletes itself
  // on failure cannot be asked.
  await q.query(
    `update outbox set last_error = $3, abandoned_at = case when $2::bigint is null then $4 else null end,
            next_attempt_at = coalesce($2, next_attempt_at)
      where command_id = $1`,
    [commandId, nextAt, error.slice(0, 500), now],
  );
}

export type OutboxStats = Readonly<{ pending: number; dispatched: number; abandoned: number }>;

export async function stats(q: Queryable): Promise<OutboxStats> {
  const [row] = await rows<{ pending: string; dispatched: string; abandoned: string }>(
    q,
    `select count(*) filter (where dispatched_at is null and abandoned_at is null)::text as pending,
            count(*) filter (where dispatched_at is not null)::text as dispatched,
            count(*) filter (where abandoned_at is not null)::text as abandoned
       from outbox`,
  );
  return {
    pending: Number(row?.pending ?? 0),
    dispatched: Number(row?.dispatched ?? 0),
    abandoned: Number(row?.abandoned ?? 0),
  };
}

/** How many distinct commands exist for a device. The restart test's assertion. */
export async function countForDevice(q: Queryable, deviceId: string): Promise<number> {
  const [row] = await rows<{ n: string }>(q, `select count(*)::text as n from outbox where device_id = $1`, [
    deviceId,
  ]);
  return Number(row?.n ?? 0);
}
