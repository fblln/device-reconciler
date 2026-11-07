/**
 * sim.ts — the simulated fleet: two channels, two clocks, per-device pathology.
 *
 * WHY SIMULATE RATHER THAN MOCK
 * -----------------------------
 * A mock returns canned responses, so it can only reproduce the failures
 * somebody already thought to script. The failures that matter in this domain
 * are TIMING failures — a snapshot captured before a command but delivered
 * after it, an acknowledgement that arrives three minutes before the state
 * change it predicts, a device clock ten minutes fast, two snapshots delivered
 * in the wrong order — and none of those can be expressed as a canned response.
 * They are emergent properties of a world with independent clocks and
 * independent delays, so the world is what gets built.
 *
 * WHY A PROFILE PER DEVICE, DERIVED FROM A SEED
 * ---------------------------------------------
 * Every pathology below is drawn once, from `(seed, deviceId)`, so a fleet is a
 * pure function of its seed. That is the single most valuable property for an
 * agent working on this repository: a failing integration run can be replayed
 * exactly by exporting the same SEED, and adding a device does not reshuffle
 * every other device's behaviour. Drawn from Math.random, every run would be a
 * different world and an integration failure would be indistinguishable from a
 * flake — which is how a suite stops being trusted and then stops being run.
 *
 * THE COMPRESSED TIMELINE
 * -----------------------
 * Real telemetry feeds run on minutes. Everything here runs on seconds, scaled
 * by `TICK_MS`, so the whole fleet converges while someone is still watching.
 * The RATIOS are what matter and they are preserved: telemetry latency is a
 * large fraction of the capture interval, actuation lags acknowledgement, and
 * the command timeout is a small multiple of a capture interval. A simulator
 * that is merely fast teaches nothing; one that is fast and keeps the ratios
 * reproduces the same decisions.
 */

import { chance, intBetween, pick, rng, seedFrom, type Rng } from '../core/lcg.ts';
import type { CommandReportState, PowerDeliveryState } from '../core/reconcile.ts';

export type Vendor = Readonly<{ name: string; perSecond: number; burst: number }>;

/**
 * Three vendors with deliberately different quotas, because a single global
 * limit is the thing per-vendor limiting exists to avoid: set to the tightest
 * vendor it starves everyone else, set to the loosest it gets the tightest one
 * banned. `tortoise` is the one that makes the backpressure path fire on every
 * run rather than only under load nobody reproduces locally.
 */
export const VENDORS: readonly Vendor[] = [
  { name: 'hare', perSecond: 20, burst: 20 },
  { name: 'badger', perSecond: 6, burst: 8 },
  { name: 'tortoise', perSecond: 1, burst: 2 },
];

export type Profile = Readonly<{
  deviceId: string;
  vendor: string;
  /**
   * device clock = our clock + skew. Signed, and sometimes large: a device whose
   * clock is ten minutes fast is common in the field (a unit that boots without
   * NTP and never corrects) and it is the single input that breaks naive
   * timestamp comparison most spectacularly.
   */
  clockSkewMs: number;
  /** How often the device captures a snapshot, on its own schedule. */
  captureIntervalMs: number;
  /** Capture to delivery. A large fraction of the capture interval, as in the field. */
  telemetryLatencyMs: number;
  /** Acknowledgement to the relay actually moving. The ack-is-not-actuation gap. */
  actuationDelayMs: number;
  /** Devices that echo the generation they applied. The exact-correlation path. */
  reportsGeneration: boolean;
  /** Refuses every command on the command channel. The one crisp failure. */
  rejectsCommands: boolean;
  /** Acknowledges and never actuates. The headline trap: looks like success. */
  acksButNeverApplies: boolean;
  /** Reports APPLIED on the command channel, often well before telemetry agrees. */
  reportsApplied: boolean;
  /** Delivers some webhooks twice. Exercises inbox deduplication. */
  duplicatesWebhooks: boolean;
  /** Delivers some webhooks out of order. Exercises the device-clock watermark. */
  reordersWebhooks: boolean;
  /** Starts unplugged. Not our failure, and must not be reported as one. */
  startsUnplugged: boolean;
}>;

export function profileFor(deviceId: string, vendor: string, seed: number, tick: number): Profile {
  const r = rng(seedFrom(deviceId, seed));
  return {
    deviceId,
    vendor,
    // A tenth of the fleet is wildly wrong, the rest are plausibly wrong. Both
    // matter: the wild ones break naive comparison loudly, and the plausible
    // ones break it quietly, which is worse.
    clockSkewMs: chance(r, 0.1) ? intBetween(r, -600_000, 600_000) : intBetween(r, -45_000, 45_000),
    captureIntervalMs: pick(r, [2, 3, 4]) * tick,
    telemetryLatencyMs: intBetween(r, Math.round(tick * 0.3), Math.round(tick * 2.5)),
    actuationDelayMs: intBetween(r, Math.round(tick * 0.5), Math.round(tick * 2)),
    // Roughly half the fleet counts. That ratio is the point of the readout: it
    // makes the clock-fallback rate land somewhere interesting instead of at 0%
    // or 100%, where it would say nothing.
    reportsGeneration: chance(r, 0.5),
    rejectsCommands: chance(r, 0.08),
    acksButNeverApplies: chance(r, 0.08),
    reportsApplied: chance(r, 0.4),
    duplicatesWebhooks: chance(r, 0.25),
    reordersWebhooks: chance(r, 0.2),
    startsUnplugged: chance(r, 0.1),
  };
}

/** Mutable per-device world state. The only mutable thing in the simulator. */
export type DeviceState = {
  profile: Profile;
  charging: boolean;
  plugged: boolean;
  /** The highest generation the device has actually applied, or null. */
  appliedGeneration: number | null;
  /** An instruction accepted and not yet actuated. The gap this repo is about. */
  inFlight: { commandId: string; generation: number; target: boolean; actuateAt: number } | null;
  /** Next capture, on OUR clock; the snapshot it produces is stamped on the device's. */
  nextCaptureAt: number;
};

export function initialState(profile: Profile, now: number): DeviceState {
  return {
    profile,
    charging: false,
    plugged: !profile.startsUnplugged,
    appliedGeneration: null,
    inFlight: null,
    // Stagger the first capture across the interval so the whole fleet does not
    // report in lockstep — a synchronised fleet hides every ordering bug, and
    // real fleets are never synchronised.
    nextCaptureAt: now + Math.round(profile.captureIntervalMs * rng(seedFrom(profile.deviceId, 7))()),
  };
}

export function powerState(d: DeviceState): PowerDeliveryState {
  if (!d.plugged) return 'UNPLUGGED';
  return d.charging ? 'PLUGGED_IN:CHARGING' : 'PLUGGED_IN:STOPPED';
}

/**
 * The acknowledgement a command gets, and whether it will ever actuate.
 *
 * REJECTED is the only crisp failure the command channel can report. ACCEPTED
 * is the dangerous one: it means the instruction reached the device, and
 * nothing more. A device with `acksButNeverApplies` returns exactly the same
 * ACCEPTED as a healthy one and then does nothing, which is indistinguishable
 * from slow until the deadline passes — the failure the sibling repository's
 * headline scenario is built around.
 */
export function accept(
  d: DeviceState,
  commandId: string,
  generation: number,
  target: boolean,
  now: number,
): CommandReportState {
  if (d.profile.rejectsCommands) return 'REJECTED';
  if (d.profile.acksButNeverApplies) return 'ACCEPTED';
  d.inFlight = { commandId, generation, target, actuateAt: now + d.profile.actuationDelayMs };
  return 'ACCEPTED';
}

/**
 * Advance the world to `now`. Returns the captures that became due, each with
 * the device time it was stamped with and the instant it should be DELIVERED —
 * which is later, and which is the whole source of difficulty in this domain.
 */
export type Capture = Readonly<{
  deviceId: string;
  /** On the DEVICE's clock. Not comparable to anything else here. */
  deviceTime: number;
  /** On OUR clock: when this snapshot should reach the reconciler. */
  deliverAt: number;
  powerDeliveryState: PowerDeliveryState;
  observedGeneration: number | null;
}>;

/** An actuation that completed, for the command channel to report as APPLIED. */
export type Applied = Readonly<{ deviceId: string; commandId: string; generation: number }>;

export function advance(d: DeviceState, now: number, r: Rng): { captures: Capture[]; applied: Applied[] } {
  const captures: Capture[] = [];
  const applied: Applied[] = [];

  if (d.inFlight !== null && now >= d.inFlight.actuateAt) {
    const { commandId, generation, target } = d.inFlight;
    d.charging = target && d.plugged;
    d.appliedGeneration = generation;
    d.inFlight = null;
    applied.push({ deviceId: d.profile.deviceId, commandId, generation });
  }

  // Autonomous drift. A charger can stop on its own and a human can unplug one,
  // and nothing in the system will say so except the next snapshot — which is
  // the case that justifies a reconciliation LOOP over a fire-and-forget call.
  // Rare per tick on purpose: frequent enough to be hit in a demo run, rare
  // enough not to dominate it.
  if (d.charging && chance(r, 0.01)) d.charging = false;

  while (now >= d.nextCaptureAt) {
    const capturedAt = d.nextCaptureAt;
    d.nextCaptureAt = capturedAt + d.profile.captureIntervalMs;
    let deliverAt = capturedAt + d.profile.telemetryLatencyMs;
    // Reordering: push one delivery past the next one. The watermark in the
    // decision function exists for exactly this, and a simulator that never
    // reorders never proves the watermark works.
    if (d.profile.reordersWebhooks && chance(r, 0.3)) {
      deliverAt += d.profile.captureIntervalMs + d.profile.telemetryLatencyMs;
    }
    captures.push({
      deviceId: d.profile.deviceId,
      deviceTime: capturedAt + d.profile.clockSkewMs,
      deliverAt,
      powerDeliveryState: powerState(d),
      observedGeneration: d.profile.reportsGeneration ? d.appliedGeneration : null,
    });
  }

  return { captures, applied };
}
