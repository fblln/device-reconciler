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
import type { BackoffConfig } from './core/backoff.ts';
import type { BreakerConfig } from './core/breaker.ts';
import type { Limits } from './core/ratelimit.ts';
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

export type Config = Readonly<{
  databaseUrl: string;
  platformUrl: string;
  clientId: string;
  clientSecret: string;
  port: number;
  publicUrl: string;
  webhookSecret: string;
  signatureTolerance: Duration;
  commandTimeout: Duration;
  skewBound: Duration;
  maxLatency: Duration;
  schedule: ScheduleConfig;
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

    // A promise to a user, not a technical constant: it must exceed the worst
    // realistic telemetry interval by a comfortable margin, or confirmations
    // that were genuinely on their way get reported as failures.
    commandTimeout: ms('COMMAND_TIMEOUT_MS', 180_000),
    // The declared bounds. See the header.
    skewBound: ms('SKEW_BOUND_MS', 30_000),
    maxLatency: ms('MAX_LATENCY_MS', 120_000),

    schedule: {
      sweepInterval: ms('SWEEP_INTERVAL_MS', 30_000),
      failedInterval: ms('FAILED_INTERVAL_MS', 10 * 60_000),
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
