/**
 * readout.ts — the two numbers that justify the whole design.
 *
 * WHY THESE NUMBERS AND NOT A DASHBOARD OF THIRTY
 * -----------------------------------------------
 * The sibling repository argues that correlating telemetry with a command
 * crosses two clocks, so it has three answers and not two, and that a counter
 * (`observedGeneration`) beats clock arithmetic whenever a device offers one.
 * That is an argument. It becomes an engineering fact only if the running system
 * can say how often each branch was actually taken:
 *
 *   unknown rate         the share of correlations that could not be decided at
 *                        all. If this is zero, the tri-state is theatre and a
 *                        boolean would have done. If it is high, the declared
 *                        skew and latency bounds are too loose for the fleet, or
 *                        the telemetry feed is slower than it claims — and the
 *                        fix is an operational one, not a code change.
 *   clock fallback rate  the share of correlations decided by clock bounds
 *                        rather than by a generation echo. This is the cost of
 *                        the fleet's hardware, in one number. It is also the
 *                        business case for preferring vendors whose devices
 *                        count, which is a procurement argument that needs a
 *                        measurement behind it.
 *
 * Everything else here exists to make those two readable: a denominator, a
 * per-vendor split (one bad vendor can carry the whole fleet average), and the
 * phase census that says whether the reconciler is actually converging anything
 * while it reports those rates.
 *
 * WHY PURE
 * --------
 * Aggregation is the part with arithmetic in it, so it is the part that can be
 * wrong. Keeping it a pure function of rows means the rate definitions are unit
 * tested — including the division-by-zero cases that a freshly started system
 * hits on its first scrape and that are the classic source of a NaN on a
 * dashboard.
 */

import type { Correlation, CorrelationSource } from './correlate.ts';
import type { FailReason, PhaseName } from './reconcile.ts';

/**
 * One decision, as persisted. `correlation` and `source` are null when the
 * decision needed no correlation at all — a telemetry outage, a rejection on the
 * command channel, a device sitting unplugged. Counting those in the
 * denominator would dilute both rates with decisions that never asked the
 * question, which is the obvious way to make this readout quietly meaningless.
 *
 * `count` is here so the store can hand over the result of a `GROUP BY` rather
 * than every decision ever made. A readout that has to stream the audit log to
 * compute a percentage stops being scrapeable at exactly the fleet size where
 * the percentage starts to matter.
 */
export type DecisionRow = Readonly<{
  vendor: string;
  phase: PhaseName;
  correlation: Correlation | null;
  source: CorrelationSource | null;
  count: number;
}>;

/**
 * One phase transition, grouped. See `outcomes` in src/store/decisions.ts for
 * why transitions and not phases.
 */
export type OutcomeRow = Readonly<{
  deviceId: string;
  vendor: string;
  prevPhase: PhaseName;
  phase: PhaseName;
  failReason: FailReason | null;
  count: number;
}>;

/**
 * How a single device has behaved, as counters rather than as a score.
 *
 * WHY NOT ONE NUMBER. A weighted composite would rank the fleet in one column
 * and destroy the only thing the ranking is for: knowing who to call. These
 * four outcomes have four different owners. A rejection is the vendor
 * answering; a timeout is nobody answering; drift is somebody at the device
 * disagreeing with us; a dark feed is the network. Averaging them produces a
 * number that moves for reasons you cannot act on, which is how reliability
 * dashboards end up being watched by nobody.
 *
 * `confirmationRate` is the one rate here, and it is deliberately narrow: the
 * share of commands that reached a verdict AND that verdict was confirmation.
 * It is not a success rate for the hardware. A `timeout-unconfirmed` means the
 * loop could not prove the command landed, which on a clock-only device may say
 * more about the telemetry interval than about the charger (see
 * `clockConfirmationWindow`), and the two columns sit next to each other so
 * that reading is available rather than hidden inside an average.
 */
export type DeviceHealth = Readonly<{
  vendor: string;
  /** Commands that reached a verdict. Superseded commands are not counted. */
  commands: number;
  confirmed: number;
  /** The vendor said no. A real answer, and the only crisp failure available. */
  rejected: number;
  /** Nobody said anything before the deadline. */
  unconfirmed: number;
  /** Converged, then moved without us. Somebody else is driving this device. */
  drifted: number;
  /** Times the telemetry feed went dark under it. */
  wentDark: number;
  /** confirmed / commands, or null when this device has had no verdict yet. */
  confirmationRate: number | null;
}>;

const emptyHealth = (vendor: string): DeviceHealth => ({
  vendor,
  commands: 0,
  confirmed: 0,
  rejected: 0,
  unconfirmed: 0,
  drifted: 0,
  wentDark: 0,
  confirmationRate: null,
});

/** Per-device counters, from the grouped transitions. Pure, so the arithmetic is testable. */
export function deviceReliability(rows: readonly OutcomeRow[]): Record<string, DeviceHealth> {
  const out = new Map<string, { -readonly [K in keyof DeviceHealth]: DeviceHealth[K] }>();
  for (const row of rows) {
    const d = out.get(row.deviceId) ?? { ...emptyHealth(row.vendor) };
    out.set(row.deviceId, d);
    if (row.prevPhase === 'ISSUED' && row.phase === 'CONVERGED') {
      d.commands += row.count;
      d.confirmed += row.count;
    } else if (row.prevPhase === 'ISSUED' && row.phase === 'FAILED') {
      d.commands += row.count;
      if (row.failReason === 'rejected-by-vendor') d.rejected += row.count;
      else d.unconfirmed += row.count;
    } else if (row.prevPhase === 'CONVERGED' && row.phase === 'ISSUED') {
      d.drifted += row.count;
    } else if (row.phase === 'SUSPENDED') {
      d.wentDark += row.count;
    }
  }
  return Object.fromEntries(
    [...out].map(([id, d]) => [id, { ...d, confirmationRate: ratio(d.confirmed, d.commands) }]),
  );
}

export type Rates = Readonly<{
  /** Correlations attempted. The denominator for both rates below. */
  correlated: number;
  after: number;
  before: number;
  unknown: number;
  byGeneration: number;
  byClock: number;
  /** unknown / correlated, or null when nothing has been correlated yet. */
  unknownRate: number | null;
  /** byClock / correlated, or null when nothing has been correlated yet. */
  clockFallbackRate: number | null;
}>;

export type Readout = Readonly<{
  decisions: number;
  phases: Readonly<Record<PhaseName, number>>;
  overall: Rates;
  /** Per vendor, because a fleet average hides the one vendor that is the problem. */
  byVendor: Readonly<Record<string, Rates>>;
}>;

type Tally = { after: number; before: number; unknown: number; byGeneration: number; byClock: number };

const emptyTally = (): Tally => ({ after: 0, before: 0, unknown: 0, byGeneration: 0, byClock: 0 });

function add(t: Tally, row: DecisionRow): void {
  if (row.correlation === null || row.source === null) return;
  t[row.correlation] += row.count;
  if (row.source === 'generation') t.byGeneration += row.count;
  else t.byClock += row.count;
}

/**
 * Null, not zero, for an empty denominator. A zero unknown-rate on a system that
 * has correlated nothing reads as "the design is working perfectly", which is
 * the opposite of the truth, and it is exactly the state a scrape hits in the
 * first seconds after a restart.
 */
const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);

function finish(t: Tally): Rates {
  const correlated = t.after + t.before + t.unknown;
  return {
    correlated,
    ...t,
    unknownRate: ratio(t.unknown, correlated),
    clockFallbackRate: ratio(t.byClock, correlated),
  };
}

const noPhases = (): Record<PhaseName, number> => ({
  IDLE: 0,
  CONVERGED: 0,
  ISSUED: 0,
  SUSPENDED: 0,
  FAILED: 0,
});

export function summarise(rows: readonly DecisionRow[]): Readout {
  const overall = emptyTally();
  const vendors = new Map<string, Tally>();
  const phases = noPhases();

  let decisions = 0;
  for (const row of rows) {
    decisions += row.count;
    phases[row.phase] += row.count;
    add(overall, row);
    let t = vendors.get(row.vendor);
    if (t === undefined) {
      t = emptyTally();
      vendors.set(row.vendor, t);
    }
    add(t, row);
  }

  return {
    decisions,
    phases,
    overall: finish(overall),
    byVendor: Object.fromEntries([...vendors].map(([v, t]) => [v, finish(t)])),
  };
}

const pct = (r: number | null): string => (r === null ? '  n/a' : `${(r * 100).toFixed(1).padStart(5)}%`);

/**
 * The readout as text, because the demo has to be readable in a terminal by a
 * human or an agent with no browser. The same numbers are exported as
 * OpenTelemetry metrics; this is the view that needs no collector running.
 */
/**
 * The least reliable devices first, which is the only order this table is read
 * in. A device with no verdict yet sorts last rather than best: a null rate is
 * an absence of evidence, and putting it at the top of a "worst first" list
 * would send somebody to look at a device nothing has been asked of.
 */
/*
 * One row builder for the header and the data, so the columns cannot drift
 * apart. They did while this was two format strings: `pct` returns five
 * characters for null and six for a number, which is invisible until one
 * device has no verdict and everything below it steps left by one.
 */
const deviceRow = (c: readonly string[]): string =>
  `${c[0]!.padEnd(15)} ${c[1]!.padEnd(10)} ${c[2]!.padStart(5)}   ${c[3]!.padStart(9)}   ` +
  `${c[4]!.padStart(8)}   ${c[5]!.padStart(11)}   ${c[6]!.padStart(5)}   ${c[7]!.padStart(4)}`;

export function renderDevices(health: Record<string, DeviceHealth>, limit = 10): string {
  const ranked = Object.entries(health)
    .filter(([, d]) => d.commands > 0 || d.drifted > 0 || d.wentDark > 0)
    .toSorted(([a, x], [b, y]) => (x.confirmationRate ?? 2) - (y.confirmationRate ?? 2) || a.localeCompare(b))
    .slice(0, limit);
  if (ranked.length === 0) return 'devices        (no verdicts yet)';
  return [
    deviceRow(['device', 'vendor', 'cmds', 'confirmed', 'rejected', 'unconfirmed', 'drift', 'dark']),
    ...ranked.map(([id, d]) =>
      deviceRow([
        id,
        d.vendor,
        String(d.commands),
        pct(d.confirmationRate),
        String(d.rejected),
        String(d.unconfirmed),
        String(d.drifted),
        String(d.wentDark),
      ]),
    ),
  ].join('\n');
}

export function render(r: Readout): string {
  const lines: string[] = [];
  lines.push(
    `decisions ${r.decisions}  (${Object.entries(r.phases)
      .map(([p, n]) => `${p} ${n}`)
      .join('  ')})`,
  );
  lines.push('');
  lines.push('vendor          correlated   unknown   clock-fallback   after   before');
  const rows: Array<readonly [string, Rates]> = [
    ['ALL', r.overall],
    ...Object.entries(r.byVendor).toSorted(),
  ];
  for (const [name, s] of rows) {
    lines.push(
      `${name.padEnd(14)} ${String(s.correlated).padStart(10)}   ${pct(s.unknownRate)}          ${pct(
        s.clockFallbackRate,
      )}  ${String(s.after).padStart(6)}   ${String(s.before).padStart(6)}`,
    );
  }
  return lines.join('\n');
}
