/**
 * sweep.ts — the two periodic jobs that keep an event-driven system honest.
 *
 * WHY A SWEEPER EXISTS IN A WEBHOOK-DRIVEN SYSTEM
 * -----------------------------------------------
 * Because the interesting failure is silence. A purely event-driven reconciler
 * only ever looks at devices that are talking to it, which means the device it
 * never revisits is the device that stopped reporting — and that is precisely
 * the device most likely to have drifted, lost a command, or had its cable
 * pulled. Events give latency; the sweep gives completeness. Each one covers
 * the other's blind spot and neither is sufficient.
 *
 * TWO JOBS, DELIBERATELY SEPARATE
 * -------------------------------
 *   markQuiet   a device nothing has been heard from for a while has its
 *               telemetry marked dark. This is what makes a dead feed VISIBLE
 *               to the decision function: without it, the last snapshot stays
 *               "current" forever and the reconciler keeps issuing commands
 *               against a frozen reading, which is the one thing the
 *               unreachable branch exists to prevent.
 *   syncFleet   discovers devices and registers the ones we do not know. Paged,
 *               because a client that reads one page silently manages only the
 *               first N devices — and the ones it drops are the newest.
 *
 * The staleness threshold is a multiple of the sweep interval rather than a
 * separate knob: it has to be longer than the slowest capture interval in the
 * fleet or healthy devices get marked dark between snapshots, and tying it to
 * the sweep keeps the two from being tuned into contradiction.
 */

import { duration, instant, type Duration, type Instant } from '../core/time.ts';
import { unknownClock } from '../core/clock.ts';
import { initialPhase } from '../core/reconcile.ts';
import { tx, type Db } from '../store/db.ts';
import { markStaleUnreachable } from '../store/channels.ts';
import { register } from '../store/devices.ts';
import type { PlatformClient } from '../adapter/client.ts';
import { log } from '../telemetry.ts';

export type SweepConfig = Readonly<{ staleAfter: Duration }>;

/** Mark feeds dark, and wake the affected devices so they notice. */
export async function markQuiet(db: Db, cfg: SweepConfig, now: Instant): Promise<number> {
  const marked = await tx(db, (client) => markStaleUnreachable(client, instant(now - cfg.staleAfter)));
  if (marked > 0) log('sweep.marked-unreachable', { devices: marked });
  return marked;
}

export async function syncFleet(db: Db, client: PlatformClient, now: Instant): Promise<number> {
  const listed = await client.listDevices();
  if (!listed.ok) {
    // A failed fleet listing is not an emergency: the devices we already know
    // keep reconciling. Logging and returning beats throwing, which would take
    // the loop down over a vendor's bad minute.
    log('sweep.list-failed', { reason: listed.kind });
    return 0;
  }
  let added = 0;
  for (const device of listed.value) {
    const inserted = await tx(db, (c) =>
      register(c, device.deviceId, device.vendor, initialPhase(now), unknownClock, now),
    );
    if (inserted) added += 1;
  }
  if (added > 0) log('sweep.registered', { devices: added, total: listed.value.length });
  return added;
}

/** Staleness as a multiple of the sweep interval. See the header. */
export const staleAfter = (sweepInterval: Duration, multiple = 4): Duration =>
  duration(sweepInterval * multiple);
