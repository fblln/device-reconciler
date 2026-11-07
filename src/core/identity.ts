/**
 * identity.ts — the two identities a command carries, minted deterministically.
 *
 * WHY DETERMINISTIC AND NOT randomUUID()
 * --------------------------------------
 * The command id is the Idempotency-Key on the wire AND the outbox's primary
 * key, so it is the thing that makes at-least-once dispatch safe. Deriving it
 * from `(deviceId, sequence)` rather than drawing it at random buys one
 * specific property: a reconcile transaction that is retried — a serialisation
 * failure, a lost connection on commit, a worker that crashed between deciding
 * and committing — re-derives the SAME id from the same durable counter. With a
 * random id the retry would mint a new one, insert a second outbox row, and
 * send a second command for the same intent, which is the duplicate actuation
 * the whole design exists to prevent.
 *
 * The sequence lives in `device.command_seq`, in the database, for the same
 * reason the generation does: a counter that lives in a process is a counter
 * that restarts.
 *
 * WHY NOT A UUID SHAPE
 * --------------------
 * It would have to be derived by hashing, which makes it opaque, and nothing
 * requires it: this is our own namespace, the platform treats the key as an
 * opaque string, and `dev-0007/3` in a log line answers "which device, which
 * attempt" without a lookup. ponytail: a string with a slash in it.
 *
 * GENERATION IS SEPARATE FROM THE COMMAND ID, DELIBERATELY. They answer
 * different questions and are minted the same way for different reasons:
 *
 *   commandId   matches an acknowledgement on the command channel back to the
 *               command that caused it — the role of AWS IoT's `clientToken`.
 *   generation  the monotonic desired-state counter a device echoes back, which
 *               gives exact clock-free correlation against telemetry — the role
 *               of Kubernetes' `metadata.generation`.
 *
 * A single identity cannot do both: the generation must be comparable with `>=`
 * so a device that skipped past one still counts as having moved on, and an id
 * must be an exact match so a late report from a superseded command is ignored
 * rather than treated as evidence.
 */

import { nextGeneration, type Generation } from './correlate.ts';

export type Identities = Readonly<{ commandId: string; generation: Generation }>;

export function mint(deviceId: string, commandSeq: number, lastGeneration: Generation): Identities {
  return { commandId: `${deviceId}/${commandSeq + 1}`, generation: nextGeneration(lastGeneration) };
}

/** The device a command id belongs to, for logs and for the demo's readout. */
export function deviceOf(commandId: string): string {
  const slash = commandId.lastIndexOf('/');
  return slash === -1 ? commandId : commandId.slice(0, slash);
}
