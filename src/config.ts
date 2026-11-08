/**
 * config.ts — every knob, in one place, with its reasoning attached.
 *
 * WHY ONE FILE AND WHY FROM THE ENVIRONMENT
 * -----------------------------------------
 * Two of the values below are not implementation details, they are DECLARED
 * ASSUMPTIONS about a fleet: `skewBound` (how far a device clock may have
 * drifted) and `maxLatency` (the longest a snapshot may sit between capture and
 * arrival). Tighter values decide more often and are wrong more often; looser
 * ones return `unknown` and lean on the command channel. That trade-off belongs
 * to whoever knows the fleet, so it must be visible and changeable without a
 * rebuild — and the readout exists so the person changing it can see the effect.
 *
 * Everything else is here for the agentic-devex reason: one command has to bring
 * the whole thing up, which means every default must be correct for `docker
 * compose up` with no .env file and no credentials. There is no cloud service
 * and no secret manager anywhere in this repository; the webhook secret has a
 * development default and the comment says so out loud.
 */

import { duration, type Duration } from './core/time.ts';
import type { Bounds } from './core/clock.ts';
import type { BackoffConfig } from './core/backoff.ts';
import type { BreakerConfig } from './core/breaker.ts';
import type { Limits } from './core/ratelimit.ts';
import type { OverrideConfig } from './core/override.ts';
import type { ScheduleConfig } from './core/schedule.ts';

const str = (name: string, fallback: string): string => process.env[name] ?? fallback;
const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  // Refuse rather than silently fall back: a typo in a tuning value that
  // silently reverts to the default is a configuration change that appears to
  // have been applied and was not, which is the hardest kind to debug.
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  return n;
};
const ms = (name: string, fallback: number): Duration => duration(num(name, fallback));
const json = (name: string): Record<string, unknown> => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be JSON, got ${JSON.stringify(raw)}`);
  }
  // Same refusal as `num`: a tuning value that silently reverts to the default
  // is a configuration change that looks applied and is not.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${name} must be a JSON object of vendor names`);
  return parsed as Record<string, unknown>;
};

/**
 * The three numbers that decide whether a command is judged confirmed, failed
 * or still undecided. Grouped because they are only meaningful together: see
 * `clockConfirmationWindow` for the arithmetic that ties them.
 */
export type Timing = Readonly<{ commandTimeout: Duration; bounds: Bounds }>;

/**
 * PER VENDOR, BECAUSE A FLEET IS NOT UNIFORM.
 *
 * These numbers describe how a platform behaves, and a reconciler that talks to
 * several platforms is holding several different behaviours at once. A vendor
 * whose devices echo a generation is confirmed exactly and instantly; a vendor
 * reached over Modbus and polled every five minutes cannot be confirmed before
 * `maxLatency + skewBound` has passed and then a capture has arrived. One set
 * of numbers for both means sizing for the worst vendor, which taxes every
 * other one: the fast vendor waits the slow vendor's timeout to learn that a
 * command failed.
 *
 * The shape mirrors `gate.ts`, which already keeps a limiter and a breaker per
 * vendor for the same reason, and `readout.ts`, which already tallies
 * correlation outcomes per vendor because "a fleet average hides the one vendor
 * that is the problem". This closes the gap between those two and the numbers
 * that actually decide a command's fate.
 *
 * An absent vendor gets the fleet defaults, so adding a vendor never requires
 * configuring one. ponytail: one JSON env var, not a config file format.
 */
export type VendorTiming = Readonly<{
  fleet: Timing;
  byVendor: Readonly<Record<string, Timing>>;
}>;

/** The numbers that apply to this vendor. Unconfigured vendors get the fleet's. */
export const timingFor = (timing: VendorTiming, vendor: string): Timing =>
  timing.byVendor[vendor] ?? timing.fleet;

/**
 * Reads `VENDOR_TIMING`, a JSON object of vendor name to partial overrides:
 *
 *   {"acme":{"commandTimeout":60000},"old-modbus":{"commandTimeout":900000,"maxLatency":420000}}
 *
 * Each entry merges over the fleet values, so a vendor states only what differs
 * from the default. Unknown keys and non-numbers are refused rather than
 * ignored, for the reason given on `num`: a typo that silently keeps the
 * default is a change that looks applied and is not.
 */
function vendorTiming(fleet: Timing): VendorTiming {
  const byVendor: Record<string, Timing> = {};
  for (const [vendor, raw] of Object.entries(json('VENDOR_TIMING'))) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error(`VENDOR_TIMING.${vendor} must be an object`);
    const over = raw as Record<string, unknown>;
    const pick = (key: 'commandTimeout' | 'skewBound' | 'maxLatency', fallback: Duration): Duration => {
      const value = over[key];
      if (value === undefined) return fallback;
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error(`VENDOR_TIMING.${vendor}.${key} must be a number`);
      return duration(value);
    };
    for (const key of Object.keys(over)) {
      if (!['commandTimeout', 'skewBound', 'maxLatency'].includes(key))
        throw new Error(`VENDOR_TIMING.${vendor} has unknown key ${JSON.stringify(key)}`);
    }
    byVendor[vendor] = {
      commandTimeout: pick('commandTimeout', fleet.commandTimeout),
      bounds: {
        skewBound: pick('skewBound', fleet.bounds.skewBound),
        maxLatency: pick('maxLatency', fleet.bounds.maxLatency),
      },
    };
  }
  return { fleet, byVendor };
}

export type Config = Readonly<{
  databaseUrl: string;
  platformUrl: string;
  clientId: string;
  clientSecret: string;
  port: number;
  publicUrl: string;
  webhookSecret: string;
  signatureTolerance: Duration;
  /** Empty disables the twin projection entirely. See src/twin/ditto.ts. */
  dittoUrl: string;
  dittoNamespace: string;
  dittoSubject: string;
  timing: VendorTiming;
  schedule: ScheduleConfig;
  override: OverrideConfig;
  backoff: BackoffConfig;
  breaker: BreakerConfig;
  vendorLimits: Limits;
  /** Devices reconciled per batch; also the bound on concurrent platform calls. */
  concurrency: number;
  batchSize: number;
  /** How long a claimed device stays claimed if the worker dies holding it. */
  lease: Duration;
  /** Loop pause when there was no work. Keeps an idle fleet from spinning. */
  idlePause: Duration;
  seed: number;
}>;

export function loadConfig(): Config {
  return {
    databaseUrl: str('DATABASE_URL', 'postgres://reconciler:reconciler@localhost:5432/reconciler'),
    platformUrl: str('PLATFORM_URL', 'http://localhost:9900'),
    clientId: str('PLATFORM_CLIENT_ID', 'reconciler'),
    clientSecret: str('PLATFORM_CLIENT_SECRET', 'dev-client-secret'),
    port: num('PORT', 9910),
    // Where the platform should deliver webhooks. The platform is a container in
    // the same compose network, so the default is the service name, not
    // localhost — a webhook posted to localhost from inside a container reaches
    // the container itself and nothing is ever delivered.
    publicUrl: str('PUBLIC_URL', 'http://reconciler:9910'),
    // ponytail: a shared secret in an env var. There is no secret manager here
    // because there is no cloud here; the comment is the control. A real
    // deployment reads this from whatever it already uses and rotates it by
    // accepting two secrets during the overlap, which is a verify() that tries
    // both and is eight lines when it is needed.
    webhookSecret: str('WEBHOOK_SECRET', 'dev-webhook-secret'),
    // Five minutes, as Stripe and GitHub both use. Long enough to survive a
    // clock a few minutes out of sync, short enough that the inbox's dedupe
    // window is bounded. It is NOT a replay defence on its own — the unique
    // index on inbox.event_id is. See src/core/signature.ts.
    signatureTolerance: ms('SIGNATURE_TOLERANCE_MS', 5 * 60_000),

    // The twin store. Empty by default, deliberately: `npm test` and a bare
    // `node src/app.ts` must not require a five-container Ditto stack to be up,
    // and the twin is a projection rather than a critical path. Compose sets it.
    dittoUrl: str('DITTO_URL', ''),
    dittoNamespace: str('DITTO_NAMESPACE', 'energy'),
    // `<issuer>:<subject>`, the identity Ditto's own nginx forwards as
    // x-ditto-pre-authenticated. Keeping the issuer as `nginx` is not a
    // pretence that nginx is there — it is the issuer name Ditto's default
    // policies and its documentation use, so a thing created by this
    // reconciler is readable from Ditto's UI with the normal dev credentials.
    dittoSubject: str('DITTO_SUBJECT', 'nginx:ditto'),

    // A promise to a user, not a technical constant: it must exceed the worst
    // realistic telemetry interval by a comfortable margin, or confirmations
    // that were genuinely on their way get reported as failures.
    //
    // FIVE MINUTES, NOT THREE, and the extra two are arithmetic rather than
    // taste. A device that echoes no generation can only be confirmed by
    // `capturedAfter`, which cannot return 'after' until a capture is at least
    // `maxLatency + skewBound` past the command — 150s at the defaults below.
    // At a 180s timeout that left a ~30s window for a snapshot to both be
    // captured and arrive, so a fleet whose capture interval is a minute would
    // fail commands it had actually applied. See `clockConfirmationWindow`.
    // The declared bounds. See the header.
    timing: vendorTiming({
      commandTimeout: ms('COMMAND_TIMEOUT_MS', 300_000),
      bounds: { skewBound: ms('SKEW_BOUND_MS', 30_000), maxLatency: ms('MAX_LATENCY_MS', 120_000) },
    }),

    schedule: {
      sweepInterval: ms('SWEEP_INTERVAL_MS', 30_000),
      failedInterval: ms('FAILED_INTERVAL_MS', 10 * 60_000),
    },
    // Who wins when a human at the device disagrees with a schedule. Both of
    // these are product decisions wearing technical clothes: fifteen minutes of
    // deference is right for a charger on a half-hourly tariff and far too short
    // for someone who has just turned the heating up. See src/core/override.ts.
    override: {
      localHold: ms('LOCAL_HOLD_MS', 15 * 60_000),
      operatorFreshness: ms('OPERATOR_FRESHNESS_MS', 5 * 60_000),
    },
    backoff: {
      base: ms('BACKOFF_BASE_MS', 1_000),
      cap: ms('BACKOFF_CAP_MS', 60_000),
      maxAttempts: num('BACKOFF_MAX_ATTEMPTS', 8),
    },
    breaker: {
      threshold: num('BREAKER_THRESHOLD', 5),
      cooloff: ms('BREAKER_COOLOFF_MS', 15_000),
      probes: num('BREAKER_PROBES', 1),
    },
    // Deliberately low. A vendor quota is the scarcest resource in this system,
    // and the point of the simulator is that the limits bite often enough for
    // the backpressure path to be exercised on every run rather than only under
    // load nobody reproduces locally.
    vendorLimits: { perSecond: num('VENDOR_RPS', 5), burst: num('VENDOR_BURST', 10) },

    concurrency: num('CONCURRENCY', 8),
    batchSize: num('BATCH_SIZE', 32),
    lease: ms('LEASE_MS', 30_000),
    idlePause: ms('IDLE_PAUSE_MS', 250),
    seed: num('SEED', 20261107),
  };
}

/**
 * How long a clock-only device has to produce a confirming capture.
 *
 * WHY THIS IS A FUNCTION AND NOT A COMMENT. The three knobs are tuned
 * independently by whoever knows the fleet, and the failure when they
 * contradict each other is silent and expensive: commands that worked are
 * reported as failures, and the reason string blames the clock bounds rather
 * than the timeout that was too short to use them.
 *
 * `capturedAfter` needs `maxLatency + skewBound` of device-clock distance
 * before it can prove a capture post-dates the command (see the derivation in
 * clock.ts — the minimum sample bounds the offset from ABOVE only, so proving
 * 'after' costs an upper bound on latency). Whatever is left of the timeout
 * after that floor is the entire window in which a snapshot must be both
 * captured and delivered. Non-positive means a device that echoes no
 * generation can never be confirmed by telemetry and will always time out.
 *
 * The bar is higher than positive. `staleAfter` already declares how long a
 * feed may be silent and still count as healthy, so the window must be at
 * least that long or devices the sweep considers fine will fail commands they
 * applied. test/unit/config.test.ts holds the two together, for the fleet
 * defaults AND for every configured vendor — a per-vendor override is exactly
 * where this relationship is easiest to break by hand.
 *
 * Devices that DO echo a generation are unaffected: `byGeneration` is integer
 * comparison and never consults a clock.
 */
export const clockConfirmationWindow = (timing: Timing): Duration =>
  duration(timing.commandTimeout - timing.bounds.maxLatency - timing.bounds.skewBound);
