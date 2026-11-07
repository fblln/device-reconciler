# The real two-channel path

This optional local stack puts the article's distinction on a real transport:

```text
 device application → local MQTT → Kanto local twin
                                    │
                      telemetry / events ↑    ↓ command & control
                                    │
                              Hono MQTT adapter
                                    │
                      separate Kafka topics for each direction
                                    │
                           Ditto connectivity
                                    │
                      reported ← cloud twin → desired
                           │                    ↑
                     capture + generation      outbox
                           ↓                    │
                      durable reconciler + Postgres
```

## Why each layer earns its place

| Layer              | Responsibility                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Kanto**          | A real local twin, persisted on the device, and a real reconnection synchronization path.                                               |
| **Hono**           | Structurally separate telemetry/events upstream and command & control downstream. A transport acknowledgement does not prove actuation. |
| **Ditto**          | Persisted desired and reported state; it deliberately leaves reconciliation to the application.                                         |
| **The reconciler** | Evidence ranking, tri-state correlation, deadlines, outbox durability, and override precedence.                                         |

The device application in the tests supplies controlled measurements. It is not
physical charging hardware. Kanto, Hono, Kafka, Ditto and Postgres are real
processes, and the edge runs the existing `src/app.ts` worker and dispatcher.

## Run

From the repository root:

```sh
npm ci
npm run hono:up          # infrastructure, then provision tenant/device/policy/connection
npm run hono:test        # direct Hono protocol and identity-isolation test
npm run hono:edge        # Kanto and the durable edge reconciler
npm run hono:test:edge   # all four layers, including Kanto reconnect synchronization
```

Run the direct protocol test before starting Kanto: it uses the same device
identity and changes its reported and desired state. The edge test restarts
Kanto deliberately and changes the lab device's intent and samples. These tests
are explicit opt-ins; `npm run check` needs only the ordinary Ditto stack.

The edge reconciler is at `http://localhost:9920/v1/devices`, with its evidence
readout at `http://localhost:9920/readout.txt`. The original simulated fleet still
runs at port 9910. A separate Postgres instance keeps the two workers from
claiming each other's outbox rows. The simulator remains useful for controlled
fault injection; it is not used to answer the edge test.

```sh
curl -X PUT 'http://localhost:9920/v1/devices/energy%3Aedge-0001/intent' \
  -H 'Content-Type: application/json' -d '{"charging":true}'
```

`npm run hono:down` stops the combined stack without deleting volumes. Kanto's
local twin has a named volume. The other datastores retain the base lab's
container-lifetime persistence policy; this is not a backup/deployment recipe.

## Evidence contract

The device application registers the `charging` feature on Kanto's local MQTT
bus (`localhost:1884`), then publishes Ditto Protocol commands to `e` to update
`/features/charging/properties`:

```json
{
  "sampleId": "a-unique-capture-id",
  "deviceTime": 1794080000000,
  "powerDeliveryState": "PLUGGED_IN:STOPPED",
  "observedGeneration": null
}
```

`deviceTime` is capture time on the **device clock**. `sampleId` identifies a
capture, not a poll. A repeated sample is deduplicated transactionally through
the inbox, so reading cached Ditto properties neither refreshes liveness nor
adds clock samples. An absent counter is explicitly `null`.

Only the outbox dispatcher writes `charging.desiredProperties`:

```json
{ "charging": true, "generation": 1, "commandId": "energy:edge-0001/1" }
```

An HTTP success means the desired document was persisted. The adapter returns
`PENDING`, creates no device command report, and never manufactures `APPLIED`.
The device application echoes `observedGeneration` only after applying that
instruction. Redelivery keeps the same command ID and generation; actuator
applications must deduplicate side effects using that identity.

The ordinary simulated-fleet twin projector is intentionally disabled on this
path: its derived reported-state projection must not overwrite device evidence.
The edge's verdict and UI model remain available from its reconciler API.

The edge test uses a device clock ten minutes ahead. A matching reported state
without a generation must remain `unknown`/`ISSUED`; the device's generation echo
then yields `CONVERGED` and `confirmed-exact`. The test observes the operational
readout to ensure the ambiguous sample was actually processed before asserting.

## Kanto synchronization is specific

Kanto 1.0 forwards live cloud desired-property events to local applications on
`command///req/#`. Its built-in persisted desired-property synchronization runs
when the hub reconnects. Those are distinct observations: the test checks the
live command on the local bus, restarts Kanto, and retrieves the synchronized
value from Kanto's own local twin. A successful cloud PUT alone proves neither.

A device application must register its feature locally before modifying its
individual properties. Kanto can forward an update that fails locally, so merely
seeing that update in Ditto is not a test of the local twin.

## Boundaries and costs

- Hono 2.6.0 is pinned because its service images are published on Docker Hub;
  the GitHub 2.7.0 release had no matching published MQTT image when checked.
  The published images run as `linux/amd64`, including on Apple Silicon.
- Internal request timeouts allow cold Kafka topic creation under emulation.
  Health checks use real HTTP/Kafka/Postgres clients, never shell socket redirects.
- Local credentials and plaintext networking are development settings. The Hono
  registry, MQTT adapter and local broker host ports bind to loopback. Kafka and
  internal authentication endpoints are not published.
- Ditto enforces Hono's authenticated `device_id` against the payload's thing ID.
  A test gives two twins the same policy and verifies that identity enforcement
  still blocks a forged write to the other twin.
- The connection uses Ditto's Kafka binding with explicit Hono topic/header
  mappings, allowing this local broker to run without SASL. Hono still performs
  device authentication and command routing; Kafka is its northbound transport.
- The lab polls the persisted twin instead of consuming every telemetry event.
  Intermediate captures may be coalesced. Poll delay is part of the declared
  latency budget; a durable Kafka consumer is the upgrade for a full fleet.
- `assumed_state` currently uses the existing clock-sample/generation proxy; it
  does not persist an "ever successfully correlated" fact. `optimistic` remains
  a per-device configuration flag. This integration does not change those rules.

## Upstream contracts

- [Hono MQTT adapter](https://eclipse.dev/hono/docs/user-guide/mqtt-adapter/)
- [Hono Kafka topics](https://eclipse.dev/hono/docs/admin-guide/kafka-config/)
- [Ditto Hono binding and header mapping](https://eclipse.dev/ditto/connectivity-protocol-bindings-hono.html)
- [Kanto local digital twins](https://github.com/eclipse-kanto/local-digital-twins)
