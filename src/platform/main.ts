/**
 * main.ts — the mock platform as a process. Entry point only; no logic.
 *
 * Excluded from the coverage gate along with the other entry points: there is
 * nothing here to test that is not better tested by starting the server
 * in-process, which is what the integration tests do.
 */

import { startPlatform } from './server.ts';

const num = (name: string, fallback: number): number => Number(process.env[name] ?? fallback);

const platform = startPlatform({
  port: num('PORT', 9900),
  fleetSize: num('FLEET_SIZE', 24),
  seed: num('SEED', 20261107),
  tickMs: num('TICK_MS', 1000),
  clientId: process.env['CLIENT_ID'] ?? 'reconciler',
  clientSecret: process.env['CLIENT_SECRET'] ?? 'dev-client-secret',
  webhookSecret: process.env['WEBHOOK_SECRET'] ?? 'dev-webhook-secret',
  webhookUrl: process.env['WEBHOOK_URL'] ?? '',
});

console.log(
  JSON.stringify({
    msg: 'mock aggregator platform listening',
    url: platform.url,
    fleet: num('FLEET_SIZE', 24),
    seed: num('SEED', 20261107),
    webhookUrl: process.env['WEBHOOK_URL'] ?? '(delivery disabled)',
  }),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void platform.stop().then(() => process.exit(0));
  });
}
