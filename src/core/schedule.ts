/**
 * schedule.ts — when a device next needs attention.
 *
 * WHY THIS IS A FUNCTION AND NOT A setTimeout
 * -------------------------------------------
 * A deadline that lives in a timer lives in a process, and a process dies. The
 * sibling repository's biggest gap is exactly this: it holds an in-flight
 * command's deadline in memory, so a restart loses it and the command either
 * stays ISSUED forever or gets re-issued. Here the deadline is a column
 * (`device.wake_at`) and the "timer" is a query — `where wake_at <= now` — which
 * survives a SIGKILL because the database does.
 *
 * So the only thing this file decides is the value of that column, and it is
 * pure, which means every branch below is a unit test rather than a stopwatch.
 *
 * THE FOUR CASES, AND WHY THEY DIFFER
 * -----------------------------------
 *   ISSUED     wake exactly at the deadline. Earlier would burn a decision that
 *              cannot have new evidence; later would break the promise the
 *              timeout makes to a user. Webhook arrivals pull this forward (see
 *              src/service/ingest.ts), so the deadline is the LATEST we look,
 *              not the only time.
 *   FAILED     a long way out. A failure is terminal until the intent changes,
 *              and an intent change wakes the device immediately — so polling it
 *              would produce an unbounded stream of identical "still terminal"
 *              decisions, which is how an audit log becomes unreadable. Not
 *              `never`, because a sweep that re-examines a failed device
 *              occasionally is a cheap guard against a stuck row no event will
 *              ever touch again.
 *   SUSPENDED  the sweep interval. Telemetry is dark; the only way to learn it
 *              came back is to look.
 *   IDLE /     the sweep interval. This is the case that justifies a loop over
 *   CONVERGED  a fire-and-forget call: a charger can stop on its own and nothing
 *              will tell us except the next snapshot. A device that has gone
 *              quiet is the one most likely to have drifted, and it is also the
 *              one a purely event-driven system never revisits.
 */

import { plus, type Duration, type Instant } from './time.ts';
import type { Phase } from './reconcile.ts';

export type ScheduleConfig = Readonly<{
  /** How often an otherwise quiet device is re-examined. */
  sweepInterval: Duration;
  /** How long a terminally failed device is left alone. */
  failedInterval: Duration;
}>;

export function nextWake(phase: Phase, now: Instant, cfg: ScheduleConfig): Instant {
  switch (phase.phase) {
    case 'ISSUED':
      // max(deadline, now) rather than the deadline: a deadline already in the
      // past would make this device claimable forever at zero delay, which is a
      // busy loop that starves every other device in the queue. It can happen
      // legitimately — a process that was down past the deadline comes back to
      // find it expired — and the next decision will fail the command, so one
      // immediate wake is right and an infinite stream of them is not.
      return phase.deadline > now ? phase.deadline : now;
    case 'FAILED':
      return plus(now, cfg.failedInterval);
    case 'IDLE':
    case 'CONVERGED':
    case 'SUSPENDED':
      return plus(now, cfg.sweepInterval);
  }
}
