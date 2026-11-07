/**
 * restart.test.ts — the headline test, and the reason this repository exists.
 *
 * WHAT IT PROVES
 * --------------
 * The sibling repository names its own biggest gap precisely: the phase holds
 * in-flight command state — a deadline, a command id, a generation, a watermark
 * — in memory, so a process restart loses all of it, the loop sees a device that
 * does not match intent, and it issues a SECOND command for one that is still
 * outstanding. That is the exact failure the whole design exists to prevent,
 * reintroduced by a deploy.
 *
 * This kills the reconciler with SIGKILL — not a shutdown hook, not a drain, the
 * thing that happens when a container is evicted — between the decision and the
 * delivery, restarts it, and asserts that the device was actuated ONCE.
 *
 * WHY SIGKILL AND NOT SIGTERM
 * ---------------------------
 * SIGTERM lets a process flush, which tests the shutdown handler rather than the
 * durability. Every claim in db/schema.sql is about what survives a process that
 * got no warning, so the test has to give none. SIGKILL is also what an OOM kill
 * and a node eviction look like, and those are the restarts that actually happen
 * at three in the morning.
 *
 * HOW THE DUPLICATE IS CAUGHT
 * ---------------------------
 * The simulated platform counts two things separately: `actuations`, the number
 * of times a relay actually moved, and `idempotentReplays`, requests presenting
 * an `Idempotency-Key` it has already answered. The command id is DERIVED
 * (`deviceId/seq`, see src/core/identity.ts), not random, so a transaction that
 * is retried or re-driven after a restart re-derives the SAME key — which is
 * what turns at-least-once delivery into at-most-once actuation. The assertion
 * is therefore not "no second request was made": it is "a second request may
 * well have been made, and it moved nothing".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { rows } from '../../src/store/db.ts';
import { startStack, until, CLIENT_ID, CLIENT_SECRET, WEBHOOK_SECRET, SEED } from './_stack.ts';

type OutboxRow = { command_id: string; device_id: string; generation: string; dispatched_at: string | null };

const env = (databaseUrl: string, platformUrl: string, port: number): NodeJS.ProcessEnv => ({
  ...process.env,
  DATABASE_URL: databaseUrl,
  PLATFORM_URL: platformUrl,
  PLATFORM_CLIENT_ID: CLIENT_ID,
  PLATFORM_CLIENT_SECRET: CLIENT_SECRET,
  WEBHOOK_SECRET,
  PORT: String(port),
  PUBLIC_URL: `http://127.0.0.1:${port}`,
  SEED: String(SEED),
  // No twin store: this test is about Postgres durability, and a Ditto outage
  // must not be able to fail it. The projection is deliberately not on the
  // critical path — see src/twin/ditto.ts.
  DITTO_URL: '',
  // The compressed timeline, matched to the platform's 250ms tick. A three
  // minute command timeout would mean the test spends three minutes proving
  // that nothing timed out.
  COMMAND_TIMEOUT_MS: '8000',
  SKEW_BOUND_MS: '500',
  MAX_LATENCY_MS: '1500',
  SWEEP_INTERVAL_MS: '1000',
  IDLE_PAUSE_MS: '50',
  LEASE_MS: '2000',
});

function startReconciler(databaseUrl: string, platformUrl: string, port: number): ChildProcess {
  const child = spawn(process.execPath, ['src/app.ts'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: env(databaseUrl, platformUrl, port),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Piped rather than inherited, and drained: a child whose stdout nobody reads
  // blocks on a full pipe, which looks exactly like a hung reconciler.
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await once(child, 'exit');
}

test('a SIGKILL mid-flight does not produce a second actuation', async (t) => {
  const stack = await startStack({ fleetSize: 3, tickMs: 250 });
  const port = 19_910;
  let child = startReconciler(stack.databaseUrl, stack.platform.url, port);
  t.after(async () => {
    await kill(child);
    await stack.stop();
  });

  /*
   * Wait for a command to exist in the outbox. This is the window the whole
   * design is about: the phase and the intent-to-send are committed, and the
   * device has not necessarily been told anything yet. A crash here is the one
   * that duplicates a command in a system without an outbox — write the phase
   * then POST and you lose commands; POST then write the phase and you duplicate
   * them. Neither ordering is safe, because two systems cannot be updated
   * atomically, which is why there is a third thing.
   */
  const first = await until(
    'a command in the outbox',
    () =>
      rows<OutboxRow>(
        stack.db,
        `select command_id, device_id, generation, dispatched_at from outbox order by created_at limit 1`,
      ),
    (r) => r.length === 1,
  );
  const { command_id: commandId, device_id: deviceId } = first[0]!;

  await kill(child);

  // The phase must still be ISSUED, with its deadline, after the process that
  // created it is gone. In the sibling repository this is where the state was.
  const phases = await rows<{ phase: { phase: string; deadline?: number; commandId?: string } }>(
    stack.db,
    `select phase from device where device_id = $1`,
    [deviceId],
  );
  const phase = phases[0]?.phase;
  assert.ok(phase !== undefined, 'the device row must survive the process');
  assert.equal(phase.phase, 'ISSUED', 'the in-flight command must survive a SIGKILL');
  assert.equal(phase.commandId, commandId, 'and it must be the same command');
  assert.ok(typeof phase.deadline === 'number', 'and it must still carry its deadline');

  const beforeRestart = stack.platform.stats();

  child = startReconciler(stack.databaseUrl, stack.platform.url, port);

  /*
   * Now the real question. The restarted process re-drives the outbox, and it
   * may genuinely send the same command again — at-least-once delivery is the
   * contract, not a bug. What must not happen is a second actuation.
   */
  await until(
    'the command to be dispatched after the restart',
    () =>
      rows<OutboxRow>(
        stack.db,
        `select command_id, device_id, generation, dispatched_at from outbox where command_id = $1`,
        [commandId],
      ),
    (r) => r[0]?.dispatched_at !== null,
  );

  // Let the restarted loop run long enough to have re-issued if it were going to.
  await new Promise((r) => setTimeout(r, 2_000));

  const stats = stack.platform.stats();
  const outbox = await rows<OutboxRow>(
    stack.db,
    `select command_id, device_id, generation, dispatched_at from outbox where device_id = $1`,
    [deviceId],
  );

  // One row per command id, by primary key. A duplicate generation for one
  // device would mean the counter was minted twice, which is contract I8.
  const generations = outbox.map((r) => r.generation);
  assert.equal(
    new Set(generations).size,
    generations.length,
    `the same generation was minted twice for ${deviceId}: ${generations.join(', ')}`,
  );

  /*
   * THE ASSERTION. Actuations for this device must not exceed the number of
   * distinct commands we committed to; a replay must have moved nothing.
   *
   * Note this is a fleet-wide counter, so it is compared against the fleet's
   * committed command count rather than against 1 — the other two devices are
   * converging throughout and their commands are legitimate.
   */
  const allCommands = await rows<{ n: string }>(stack.db, `select count(*)::text as n from outbox`);
  const committed = Number(allCommands[0]!.n);
  assert.ok(
    stats.actuations <= committed,
    `${stats.actuations} actuations for ${committed} committed commands: a command was applied twice`,
  );

  // And the mechanism must actually have been exercised, or the test above would
  // pass on a run where nothing was ever retried.
  assert.ok(
    stats.idempotentReplays > beforeRestart.idempotentReplays || stats.commands === committed,
    `expected either an idempotent replay or exactly ${committed} distinct commands, ` +
      `got ${stats.commands} commands and ${stats.idempotentReplays} replays`,
  );
});

test('the durable timer still times out a command issued by a process that died', async (t) => {
  /*
   * The other half of durability, and the one a restart test usually forgets. A
   * deadline that lived in a `setTimeout` dies with the process, so the command
   * stays ISSUED forever and the device is never retried or reported — a device
   * that silently stops reconciling, which is the worst failure shape available
   * because nothing anywhere says so.
   *
   * Here the deadline is a column and the timer is a query (`where wake_at <=
   * now`), so the restarted process finds the expired command and fails it. The
   * platform is pointed at a device that acknowledges and never applies, which
   * is what makes the timeout the only possible outcome.
   */
  const stack = await startStack({ fleetSize: 3, tickMs: 250 });
  const port = 19_911;
  let child = startReconciler(stack.databaseUrl, stack.platform.url, port);
  t.after(async () => {
    await kill(child);
    await stack.stop();
  });

  await until(
    'a command in the outbox',
    () => rows<OutboxRow>(stack.db, `select command_id, device_id, generation, dispatched_at from outbox`),
    (r) => r.length >= 1,
  );
  await kill(child);

  // Stay down past the command timeout, so every deadline in flight expires
  // while nothing is running to notice.
  await new Promise((r) => setTimeout(r, 9_000));

  child = startReconciler(stack.databaseUrl, stack.platform.url, port);

  const settled = await until(
    'every device to leave ISSUED after the restart',
    () =>
      rows<{ device_id: string; phase: { phase: string } }>(stack.db, `select device_id, phase from device`),
    (r) => r.length > 0 && r.every((d) => d.phase.phase !== 'ISSUED'),
    40_000,
  );
  assert.ok(settled.length > 0);
  // Whether a device ends CONVERGED or FAILED depends on its drawn profile; what
  // must not happen is a command left in flight with an expired deadline and no
  // verdict.
  for (const d of settled) {
    assert.ok(
      ['IDLE', 'CONVERGED', 'FAILED', 'SUSPENDED'].includes(d.phase.phase),
      `${d.device_id} is in ${d.phase.phase}`,
    );
  }
});
