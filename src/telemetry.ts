/**
 * telemetry.ts — OpenTelemetry, wired to nothing in particular.
 *
 * WHY PROMETHEUS PULL AND NOT AN OTLP PUSH
 * ----------------------------------------
 * Hard constraint on this repository: everything runs locally, with no cloud
 * service and no credentials. A push exporter needs a collector endpoint, and a
 * collector that is not running turns startup into a retry loop and the logs
 * into export failures — which is exactly the kind of friction that makes
 * someone disable observability while they debug something else. A pull
 * exporter serves `/metrics` on a port and is correct with nothing on the other
 * end: `curl` is a sufficient backend, and so is an agent reading the endpoint.
 *
 * Traces default to off for the same reason. `OTEL_EXPORTER_OTLP_ENDPOINT` turns
 * them on, so pointing this at a local Jaeger or collector is one environment
 * variable and no code change. The instrumentation is in the code either way;
 * only the exporter is conditional.
 *
 * WHY MANUAL INSTRUMENTATION AND NOT AUTO
 * ---------------------------------------
 * ponytail: auto-instrumentation would bring in a large dependency tree to
 * produce spans for `pg` and `http` that say what the code already says. The
 * spans that matter here are domain spans — one per reconcile decision, one per
 * dispatch — and no auto-instrumentation can know which correlation branch a
 * decision took. Add `@opentelemetry/auto-instrumentations-node` when someone
 * actually needs query-level timings.
 */

import { metrics, trace, type Tracer } from '@opentelemetry/api';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { NodeSDK } from '@opentelemetry/sdk-node';

export type Telemetry = Readonly<{ tracer: Tracer; shutdown: () => Promise<void> }>;

export function startTelemetry(serviceName: string, metricsPort: number): Telemetry {
  const sdk = new NodeSDK({
    serviceName,
    metricReaders: [new PrometheusExporter({ port: metricsPort })],
    // No traceExporter unless an endpoint is configured; the SDK then keeps the
    // API's no-op tracer and the spans below cost nothing.
  });
  sdk.start();
  return {
    tracer: trace.getTracer(serviceName),
    shutdown: () => sdk.shutdown(),
  };
}

/**
 * The instruments, created once. The two that matter are
 * `reconciler.correlation` and the fallback share it implies: everything else is
 * ordinary throughput and latency that any system would have, while those two
 * are the measurement this repository exists to produce. See
 * src/core/readout.ts for why.
 */
export function createInstruments(): Instruments {
  const meter = metrics.getMeter('reconciler');
  return {
    decisions: meter.createCounter('reconciler.decisions', {
      description: 'Reconcile decisions, by resulting phase',
    }),
    correlations: meter.createCounter('reconciler.correlations', {
      description:
        'Telemetry/command correlations, by outcome (after|before|unknown) and strategy (generation|clock). The unknown share says whether the tri-state is earning its keep; the clock share is the cost of the fleet not counting.',
    }),
    commands: meter.createCounter('reconciler.commands_dispatched', {
      description: 'Commands successfully handed to the platform',
    }),
    dispatchFailures: meter.createCounter('reconciler.dispatch_failures', {
      description: 'Dispatch attempts that failed, by kind (rate-limited|unavailable|rejected|gated)',
    }),
    webhooks: meter.createCounter('reconciler.webhooks', {
      description: 'Webhook deliveries, by outcome (accepted|duplicate|unauthorized)',
    }),
    reconcileDuration: meter.createHistogram('reconciler.decision_duration', {
      description: 'Wall time for one device decision, including its database writes',
      unit: 'ms',
    }),
  };
}

export type Instruments = Readonly<{
  decisions: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']>;
  correlations: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']>;
  commands: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']>;
  dispatchFailures: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']>;
  webhooks: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']>;
  reconcileDuration: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']>;
}>;

/**
 * Structured logs, one JSON object per line.
 *
 * ponytail: `console.log(JSON.stringify(...))`. A logging library would buy log
 * levels, redaction and transports; what is needed here is a parseable line
 * with a correlation id in it, and stdout is already the transport because the
 * process runs in a container. The one thing that is NOT skipped is keeping the
 * device id on every line — a log you cannot filter to one device is a log you
 * cannot use to debug this system, because every interesting failure is a
 * sequence of events about a single device.
 */
export function log(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}
