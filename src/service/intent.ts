/** User-action identity is durable and distinct from the outbox command identity.
 * Locking the device serializes competing clicks, retries, and worker commits.
 * Keys never expire implicitly; reusing a key always refers to its original action.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tx, type Db, type Queryable } from '../store/db.ts';
import { readBody, sendJson } from '../http.ts';
import { initialPhase } from '../core/reconcile.ts';
import { instant } from '../core/time.ts';

type Action = { charging: boolean; source: 'operator' | 'schedule' } | { retryOf: string };
export class IntentError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Canonicalize before fingerprinting; reject malformed booleans and unknown fields. */
export function parseAction(value: unknown, retry: boolean): Action {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new IntentError(400, 'Expected an object');
  const v = value as Record<string, unknown>;
  if (retry) {
    if (
      Object.keys(v).length !== 1 ||
      typeof v['retryOf'] !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v['retryOf'])
    )
      throw new IntentError(400, 'retryOf must identify the failed operation');
    return { retryOf: v['retryOf'] };
  }
  if (
    typeof v['charging'] !== 'boolean' ||
    Object.keys(v).some((k) => !['charging', 'source'].includes(k)) ||
    (v['source'] !== undefined && v['source'] !== 'operator' && v['source'] !== 'schedule')
  )
    throw new IntentError(400, 'Expected charging:boolean and optional source:operator|schedule');
  return { charging: v['charging'], source: v['source'] ?? 'operator' };
}

/** Return current progress for this operation, never another operation's success. */
export async function operation(q: Queryable, deviceId: string, operationId: string) {
  const result = await q.query(
    `select o.*, d.active_operation_id, d.phase
    from intent_operation o join device d using(device_id)
    where o.device_id=$1 and o.operation_id::text=$2`,
    [deviceId, operationId],
  );
  const row = result.rows[0];
  if (!row) throw new IntentError(404, 'Operation not found');
  const active = row.active_operation_id === row.operation_id;
  const relevant = !('target' in row.phase) || row.phase.target === row.charging;
  return {
    operationId: row.operation_id as string,
    deviceId,
    charging: row.charging as boolean,
    source: row.source as string,
    createdAt: Number(row.created_at),
    status: !active
      ? 'SUPERSEDED'
      : row.phase.phase === 'IDLE' || !relevant
        ? 'ACCEPTED'
        : (row.phase.phase as string),
    phase: active && relevant ? row.phase : null,
    statusUrl: `/v1/devices/${encodeURIComponent(deviceId)}/operations/${row.operation_id}`,
  };
}

/** Commit key registration and intent together. Different keys with identical
 * intent join the existing operation; explicit retry requires its failed ID.
 */
export async function submitIntent(db: Db, deviceId: string, key: string, action: Action, now: number) {
  if (!/^[\x21-\x7e]{1,200}$/.test(key))
    throw new IntentError(400, 'Idempotency-Key is required (1–200 printable characters)');
  return tx(db, async (q) => {
    const locked = await q.query('select * from device where device_id=$1 for update', [deviceId]);
    const d = locked.rows[0];
    if (!d) throw new IntentError(404, 'Device not found');
    const fingerprint = JSON.stringify(action);
    const prior = await q.query('select * from intent_request where device_id=$1 and request_key=$2', [
      deviceId,
      key,
    ]);
    if (prior.rows[0]) {
      if (prior.rows[0].fingerprint !== fingerprint)
        throw new IntentError(409, 'Idempotency-Key was used for a different request');
      return { ...(await operation(q, deviceId, prior.rows[0].operation_id)), replayed: true };
    }
    const retry = 'retryOf' in action;
    if (
      retry &&
      (d.active_operation_id !== action.retryOf ||
        d.phase.phase !== 'FAILED' ||
        d.phase.target !== d.intent_charging)
    )
      throw new IntentError(409, 'Only the current failed operation can be retried');
    const charging = retry ? (d.intent_charging as boolean) : action.charging;
    const source = retry ? (d.intent_source as string) : action.source;
    let id: string = d.active_operation_id;
    const same = !retry && id && charging === d.intent_charging && source === d.intent_source;
    if (!same) {
      id = randomUUID();
      await q.query('insert into intent_operation values ($1,$2,$3,$4,$5)', [
        id,
        deviceId,
        charging,
        source,
        now,
      ]);
      // Preserve pending commands so the core can supersede them correctly. Only
      // an explicit retry clears FAILED; counters and clock evidence survive.
      await q.query(
        `update device set active_operation_id=$2, intent_charging=$3,
        intent_source=$4, intent_set_at=$5, local_change_at=null, phase=$6,
        wake_at=least(wake_at,$5) where device_id=$1`,
        [deviceId, id, charging, source, now, JSON.stringify(retry ? initialPhase(instant(now)) : d.phase)],
      );
    }
    await q.query('insert into intent_request values ($1,$2,$3,$4)', [deviceId, key, fingerprint, id]);
    return { ...(await operation(q, deviceId, id)), replayed: Boolean(same) };
  });
}

/** HTTP adapter kept separate so tests exercise the actual public contract. */
export async function handleIntent(
  req: IncomingMessage,
  res: ServerResponse,
  db: Db,
  deviceId: string,
  retry: boolean,
  now: number,
) {
  try {
    let value: unknown;
    try {
      value = JSON.parse(await readBody(req));
    } catch {
      throw new IntentError(400, 'Invalid JSON body');
    }
    const key = req.headers['idempotency-key'];
    const result = await submitIntent(
      db,
      deviceId,
      typeof key === 'string' ? key : '',
      parseAction(value, retry),
      now,
    );
    res.setHeader('Location', result.statusUrl);
    return sendJson(res, 200, result);
  } catch (error) {
    if (error instanceof IntentError) return sendJson(res, error.status, { error: error.message });
    throw error;
  }
}
