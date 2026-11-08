/**
 * demo.ts — drives the running stack and prints the readout.
 *
 * WHAT IT PROVES
 * --------------
 * That the two numbers in src/core/readout.ts are produced by a real system
 * rather than by a unit test: a fleet of simulated devices across three vendors
 * with different quotas, each with its own clock skew, telemetry latency and
 * pathology, commanded through an HTTP platform with OAuth2, rate limits,
 * idempotency and retrying webhooks — and a reconciler that keeps its in-flight
 * state in Postgres.
 *
 * It talks to the stack over HTTP only, with no database access and no shared
 * code with the services beyond the readout's shape. That is deliberate: the
 * demo is a client, so if it works, the system works through its real
 * interfaces and not through a back door only the demo knows about.
 *
 * ponytail: a polling loop and a text table. Skipped a web dashboard; the same
 * numbers are on `/metrics` in Prometheus format for anything that wants to
 * graph them.
 */

const base = process.env['RECONCILER_URL'] ?? 'http://localhost:9910';
const runFor = Number(process.env['DEMO_SECONDS'] ?? 45) * 1000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForReady(deadline: number): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      // Not up yet. A demo that crashes because it started a second before the
      // stack did is a demo nobody runs twice.
    }
    if (Date.now() > deadline) throw new Error(`${base} never became ready`);
    await sleep(500);
  }
}

async function devices(): Promise<Array<{ deviceId: string; vendor: string }>> {
  const res = await fetch(`${base}/v1/devices`);
  return ((await res.json()) as { devices: Array<{ deviceId: string; vendor: string }> }).devices;
}

const started = Date.now();
console.log(`waiting for ${base} ...`);
await waitForReady(started + 60_000);

// The reconciler discovers the fleet from the platform on its sweep, so give it
// a moment rather than racing it.
let fleet = await devices();
for (let i = 0; i < 40 && fleet.length === 0; i++) {
  await sleep(500);
  fleet = await devices();
}
if (fleet.length === 0) throw new Error('the reconciler has not discovered any devices');
console.log(`fleet of ${fleet.length} across ${new Set(fleet.map((d) => d.vendor)).size} vendors`);

// Ask every device to charge. This is the command that has to cross two
// channels and come back confirmed — or honestly not confirmed.
for (const device of fleet) {
  await fetch(`${base}/v1/devices/${encodeURIComponent(device.deviceId)}/intent`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ charging: true }),
  });
}
console.log(`intent set: charging=true on all ${fleet.length} devices\n`);

const deadline = Date.now() + runFor;
while (Date.now() < deadline) {
  await sleep(5_000);
  const text = await (await fetch(`${base}/readout.txt`)).text();
  console.log(`\n--- t+${Math.round((Date.now() - started) / 1000)}s ---`);
  console.log(text);
}

const final = (await (await fetch(`${base}/readout`)).json()) as {
  correlation: {
    overall: { correlated: number; unknownRate: number | null; clockFallbackRate: number | null };
  };
};
const o = final.correlation.overall;
const pct = (r: number | null): string => (r === null ? 'n/a' : `${(r * 100).toFixed(1)}%`);
console.log(`
================================================================
  ${o.correlated} correlations performed
  unknown        ${pct(o.unknownRate)}   could not be decided at all; waited rather than guessed
  clock fallback ${pct(o.clockFallbackRate)}   decided by clock bounds because the device does not count
================================================================
A zero unknown rate would mean the tri-state is theatre. A high one means the
declared skew and latency bounds are too loose for this fleet. The fallback rate
is the cost of the fleet's hardware, in one number.
`);
