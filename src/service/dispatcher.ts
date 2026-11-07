/**
 * dispatcher.ts — drains the outbox, honouring every form of backpressure.
 *
 * WHAT MAKES THIS SAFE
 * --------------------
 * Dispatch is at-least-once. The outbox row may be sent twice — by a retry, by
 * a second dispatcher, by a process that died after the HTTP call and before
 * recording success. That is acceptable, and ONLY because the command id is
 * sent as the `Idempotency-Key`: the platform returns the original response for
 * a repeat and does not actuate again. Remove either half and the system
 * duplicates actuations.
 *
 * THE FOUR OUTCOMES AND WHY THEY DIFFER
 * -------------------------------------
 *   gated          our own limiter or breaker refused. The request was never
 *                  made, so no attempt is consumed; the row is simply deferred.
 *                  Charging a local decision against the vendor's retry budget
 *                  would let a quiet period abandon a perfectly good command.
 *   rate-limited   a 429. The request was made but nothing was delivered, and
 *                  the vendor told us when to come back, so the attempt is
 *                  RETURNED and the server's `Retry-After` is folded into the
 *                  bucket. A command abandoned for being throttled is a command
 *                  abandoned for being popular.
 *   unavailable    5xx, timeout, refused connection. Retry with jittered
 *                  backoff, and count it against the vendor's health so the
 *                  breaker can open.
 *   rejected       a 4xx that is not 429. The request is wrong and will be
 *                  wrong again, so it is abandoned immediately. Note what this
 *                  leaves behind: the device's phase stays ISSUED and times out
 *                  as 'no confirmation from either channel', which is the
 *                  honest report — the vendor never saw a valid command, so
 *                  claiming a vendor rejection would be a lie about the device.
 *
 * ATTEMPTS ARE RECORDED BEFORE THE CALL, DELIBERATELY. A row whose attempt
 * count only rises on a recorded failure is retried immediately and forever by
 * a process that keeps dying mid-call — the classic poison-message hot loop.
 */

import { nextAttempt, type BackoffConfig } from '../core/backoff.ts';
import { plus, type Instant } from '../core/time.ts';
import type { Rng } from '../core/lcg.ts';
import type { Db } from '../store/db.ts';
import {
  beginAttempt,
  claimDue,
  defer,
  markDispatched,
  recordFailure,
  returnAttempt,
  type Pending,
} from '../store/outbox.ts';
import type { PlatformClient } from '../adapter/client.ts';
import type { Gate } from '../adapter/gate.ts';
import { generation as asGeneration } from '../core/correlate.ts';
import { mapWithLimit } from './queue.ts';
import { log, type Instruments } from '../telemetry.ts';

export type DispatcherConfig = Readonly<{ backoff: BackoffConfig; batchSize: number; concurrency: number }>;

export type DispatcherDeps = Readonly<{
  db: Db;
  client: PlatformClient;
  gate: Gate;
  cfg: DispatcherConfig;
  rng: Rng;
  instruments: Instruments;
}>;

export async function dispatchBatch(deps: DispatcherDeps, now: Instant): Promise<number> {
  const { db, client, gate, cfg, rng, instruments } = deps;
  const pending = await claimDue(db, now, cfg.batchSize);
  if (pending.length === 0) return 0;

  await mapWithLimit(pending, cfg.concurrency, (p) => dispatchOne(p, now));
  return pending.length;

  async function dispatchOne(p: Pending, at: Instant): Promise<void> {
    const schedule = nextAttempt(p.attempts, at, cfg.backoff, rng);
    if (schedule.at === null) {
      await recordFailure(
        db,
        p.commandId,
        null,
        at,
        `attempt budget of ${cfg.backoff.maxAttempts} exhausted`,
      );
      instruments.dispatchFailures.add(1, { kind: 'abandoned', vendor: p.vendor });
      log('dispatch.abandoned', { commandId: p.commandId, attempts: p.attempts });
      return;
    }

    const permission = gate.check(p.vendor, at);
    if (!permission.allow) {
      const retryAt =
        permission.reason === 'rate-limited' ? plus(at, permission.retryAfter) : permission.retryAt;
      await defer(db, p.commandId, retryAt);
      instruments.dispatchFailures.add(1, { kind: 'gated', reason: permission.reason, vendor: p.vendor });
      return;
    }

    await beginAttempt(db, p.commandId, schedule.at);
    const result = await client.sendCommand(p.deviceId, {
      commandId: p.commandId,
      generation: asGeneration(p.generation),
      target: p.target,
    });

    if (result.ok) {
      await markDispatched(db, p.commandId, at);
      gate.succeeded(p.vendor);
      instruments.commands.add(1, { vendor: p.vendor, ack: result.value });
      log('dispatch.sent', {
        commandId: p.commandId,
        deviceId: p.deviceId,
        vendor: p.vendor,
        ack: result.value,
      });
      return;
    }

    if (result.kind === 'rate-limited') {
      const until = plus(at, result.retryAfter);
      gate.throttled(p.vendor, until);
      await returnAttempt(db, p.commandId, until);
      instruments.dispatchFailures.add(1, { kind: 'rate-limited', vendor: p.vendor });
      return;
    }

    if (result.kind === 'unavailable') {
      gate.failed(p.vendor, at);
      await recordFailure(db, p.commandId, schedule.at, at, result.detail);
      instruments.dispatchFailures.add(1, { kind: 'unavailable', vendor: p.vendor });
      log('dispatch.unavailable', { commandId: p.commandId, vendor: p.vendor, detail: result.detail });
      return;
    }

    await recordFailure(db, p.commandId, null, at, `rejected ${result.status}: ${result.detail}`);
    instruments.dispatchFailures.add(1, { kind: 'rejected', status: result.status, vendor: p.vendor });
    log('dispatch.rejected', { commandId: p.commandId, status: result.status, detail: result.detail });
  }
}
