-- ============================================================================
-- schema.sql — the durable half of the reconciler.
--
-- WHY THIS FILE EXISTS AT ALL
-- ---------------------------
-- The sibling `device-reconciler` repository holds in-flight command state in
-- memory: a deadline, a command id, a generation and a device-clock watermark,
-- all inside the phase. Its README names that as its biggest real gap, and it
-- is right to. A process restart loses the phase, the loop sees a device that
-- does not match intent, and it issues a SECOND command for one that is still
-- outstanding — the exact failure the whole design exists to prevent. Every
-- table below is here to close that hole.
--
-- TIME IS STORED AS BIGINT MILLISECONDS, NOT timestamptz
-- ------------------------------------------------------
-- Deliberately, and it is the most surprising decision in this file.
--
-- The domain has two clocks (see src/core/time.ts). `device_time` is on the
-- DEVICE's clock and is not comparable to ours; everything else is on ours.
-- Storing both as timestamptz would make them look like the same kind of thing
-- to every tool that touches the database, and it would let a reviewer write
-- `where device_time < now()` — which is precisely the cross-clock comparison
-- the type system in src/core forbids at compile time. Keeping them as raw
-- milliseconds, named to say whose clock they are on, means SQL cannot quietly
-- undo what TypeScript enforces.
--
-- It also means `now` is passed in from the application rather than taken from
-- `now()` in each statement. One clock source for the whole system: easier to
-- reason about, and it is what lets an integration test drive the loop to an
-- exact instant. The `_wall` columns are timestamptz and exist purely so a
-- human reading the table with psql can see when something happened.
-- ============================================================================

create table if not exists device (
  device_id       text primary key,
  vendor          text not null,

  -- Desired state. One boolean, as in the sibling repo: the interesting part is
  -- the correlation, not the schema.
  intent_charging boolean not null default false,

  -- The Phase union and the ClockModel, stored verbatim as JSON.
  --
  -- WHY JSONB AND NOT COLUMNS: the phase is a discriminated union where each
  -- variant carries different fields (ISSUED has a deadline and a command id,
  -- CONVERGED has a watermark and an optional generation, FAILED has a reason).
  -- Flattening it into columns means a wide table of mostly-null fields plus a
  -- check constraint per variant to stop illegal combinations — in other words
  -- re-implementing the type system that src/core/reconcile.ts already has, in
  -- a second language, with no compiler. The database is not the place that
  -- decides which phases are legal; the pure core is, and it is the only writer.
  -- ponytail: jsonb and one audited parse boundary (src/store/devices.ts).
  phase           jsonb not null,
  clock           jsonb not null,

  -- Monotonic counters, minted here because the database is the only thing in
  -- the system that survives everything. A generation handed out twice would
  -- make a device's echo ambiguous, which is the one thing the counter exists
  -- to prevent (contract I8), so it cannot live in a process that can restart.
  generation      bigint not null default 0,
  command_seq     bigint not null default 0,

  -- THE DURABLE TIMER. A deadline is not a setTimeout: a process that dies with
  -- a timer pending must still time the command out after it comes back, or an
  -- unconfirmed command stays ISSUED forever and the device is never retried.
  -- So "when does this device next need attention" is a column, and the work
  -- claim below is a query against it. No timer service, no scheduler process.
  wake_at         bigint not null,

  -- Work-claim lease. Null or expired means claimable. A lease rather than a
  -- boolean flag because a worker that is SIGKILLed mid-reconcile cannot clear
  -- a flag, and a device whose flag is stuck set is a device that silently
  -- stops reconciling — a quiet failure, which is the worst kind.
  leased_until    bigint,

  updated_at_wall timestamptz not null default now()
);

create index if not exists device_claimable on device (wake_at);

-- ---------------------------------------------------------------------------
-- OUTBOX. The decision to send a command and the sending of it are separated by
-- a transaction boundary, on purpose.
--
-- THE FAILURE THIS PREVENTS: without it, the reconciler would POST the command
-- and then write the phase. Crash in between and the device has the command
-- while our state says we never sent one, so on restart we send it again. Doing
-- it the other way round (write phase, then POST) loses commands instead.
-- Neither ordering is safe, because two systems cannot be updated atomically.
--
-- The outbox makes the ONE atomic write that matters — phase and intent-to-send
-- in the same transaction — and leaves delivery to a separate drain. Delivery is
-- then at-least-once, which is fine, because `command_id` is the primary key
-- here AND the Idempotency-Key on the wire: the platform returns the original
-- response for a repeat, so at-least-once delivery cannot produce a second
-- actuation. That is the whole trick, and test/integration/restart.test.ts
-- proves it by killing the process between the write and the send.
-- ---------------------------------------------------------------------------
create table if not exists outbox (
  command_id      text primary key,
  device_id       text not null references device (device_id) on delete cascade,
  generation      bigint not null,
  target          boolean not null,

  created_at      bigint not null,
  attempts        integer not null default 0,
  next_attempt_at bigint not null,
  dispatched_at   bigint,
  -- Set when the attempt budget is spent. Kept rather than deleted: "we gave up
  -- sending this" is the thing an operator most needs to see, and a row that
  -- deletes itself on failure is a row that cannot be asked about.
  abandoned_at    bigint,
  last_error      text,
  created_at_wall timestamptz not null default now()
);

create index if not exists outbox_due on outbox (next_attempt_at)
  where dispatched_at is null and abandoned_at is null;

-- ---------------------------------------------------------------------------
-- INBOX. Webhook replay protection, as a unique index.
--
-- A webhook signature is valid forever, so a captured request can be resent;
-- and an at-least-once delivering platform resends on its own whenever our
-- acknowledgement is lost. Both arrive as the same event id twice. The
-- signature's freshness window (src/core/signature.ts) bounds how long a replay
-- stays useful and nothing more — inside the window it is still perfectly
-- valid. `insert ... on conflict do nothing` is what makes the second copy a
-- no-op, and the window is what keeps this table finite.
--
-- Payloads are kept, not just ids: when a correlation lands on `unknown` the
-- first question is always "what exactly did the device send us", and a system
-- that discarded the body cannot answer it.
-- ---------------------------------------------------------------------------
create table if not exists inbox (
  event_id        text primary key,
  device_id       text not null,
  kind            text not null check (kind in ('telemetry', 'report')),
  payload         jsonb not null,
  signed_at       bigint not null,
  received_at     bigint not null,
  processed_at    bigint,
  received_at_wall timestamptz not null default now()
);

create index if not exists inbox_unprocessed on inbox (received_at) where processed_at is null;

-- ---------------------------------------------------------------------------
-- The latest thing each channel said. Two tables, because they are two channels
-- with two clocks and merging them into one row is the original sin of this
-- domain (see src/core/reconcile.ts).
--
-- NOTE the deliberate absence of an out-of-order guard on `observation`: this
-- holds the LATEST ARRIVED snapshot, not the latest captured one. Snapshots do
-- arrive out of order, and dropping the older one here would hide that from the
-- decision function — which has a device-clock watermark precisely so it can
-- recognise and ignore a stale capture itself, exactly, on one clock. Fixing
-- reordering at the storage layer would mean the watermark is never exercised
-- and the pathology reappears the first time this table is bypassed.
-- ---------------------------------------------------------------------------
create table if not exists observation (
  device_id           text primary key references device (device_id) on delete cascade,
  is_reachable        boolean not null,
  -- On the DEVICE's clock. Never compare this to any other column here.
  device_time         bigint not null,
  -- On OUR clock.
  received_at         bigint not null,
  power_delivery_state text not null,
  -- Null for the many devices that do not count. Selects the clock fallback.
  observed_generation bigint
);

create table if not exists command_report (
  device_id  text primary key references device (device_id) on delete cascade,
  command_id uuid not null,
  state      text not null check (state in ('PENDING', 'ACCEPTED', 'REJECTED', 'APPLIED')),
  -- On OUR clock: the command channel is stamped by us, which is why it needs
  -- no correlation at all.
  at         bigint not null
);

-- ---------------------------------------------------------------------------
-- DECISION LOG. Every decision, with which correlation branch it took.
--
-- This is not a debug log, it is the deliverable. The design's claim is that
-- correlation is tri-state and that a generation beats a clock estimate; the
-- only way to turn that claim into an operational fact is to count how often
-- each branch actually fires in a running fleet. src/core/readout.ts turns
-- these rows into the two rates that matter, and it reads them through a
-- GROUP BY so the readout stays scrapeable at fleet size.
-- ---------------------------------------------------------------------------
create table if not exists decision (
  id          bigserial primary key,
  device_id   text not null,
  vendor      text not null,
  at          bigint not null,
  phase       text not null,
  correlation text check (correlation in ('after', 'before', 'unknown')),
  source      text check (source in ('generation', 'clock')),
  reason      text not null,
  at_wall     timestamptz not null default now()
);

create index if not exists decision_rollup on decision (vendor, phase, correlation, source);
