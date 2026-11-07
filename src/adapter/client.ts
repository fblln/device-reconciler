/**
 * client.ts — the HTTP client for the aggregator platform.
 *
 * THE ERROR MODEL IS THE DESIGN
 * -----------------------------
 * Every call returns an outcome rather than throwing, and the outcomes are
 * split by WHAT THE CALLER SHOULD DO, not by what went wrong on the wire:
 *
 *   rate-limited  the request was refused for quota. Retry after the stated
 *                 delay. Not a failure of the vendor, and must NOT trip the
 *                 breaker — a breaker that opens on 429s turns our own pacing
 *                 error into an outage.
 *   unavailable   5xx, timeout, connection refused. Retry with backoff. DOES
 *                 trip the breaker.
 *   rejected      4xx that is not 429. The request is wrong and will be wrong
 *                 again; retrying is pure load. Does not trip the breaker,
 *                 because the vendor is healthy — we are the broken one.
 *
 * Collapsing these into one `Error` is how a dispatcher ends up retrying a 400
 * eight times with exponential backoff and opening a circuit breaker because a
 * vendor correctly rejected a malformed command.
 *
 * TIMEOUTS ARE NOT OPTIONAL
 * -------------------------
 * `fetch` has no default timeout. Without `AbortSignal.timeout` a single hung
 * vendor connection occupies a worker until the OS gives up, which on Linux is
 * minutes — long enough for a handful of hung calls to consume the whole bounded
 * queue while the rest of the fleet waits. A missing timeout is the most common
 * way a bounded-concurrency system turns into an unbounded outage.
 */

import { duration, instant, type Duration, type Instant } from '../core/time.ts';
import { parseRetryAfter } from '../core/ratelimit.ts';
import type { Command, CommandReportState } from '../core/reconcile.ts';

export type Outcome<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; kind: 'rate-limited'; retryAfter: Duration }>
  | Readonly<{ ok: false; kind: 'unavailable'; detail: string }>
  | Readonly<{ ok: false; kind: 'rejected'; status: number; detail: string }>;

export type DeviceSummary = Readonly<{ deviceId: string; vendor: string }>;

export type ClientOptions = Readonly<{
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  requestTimeout: Duration;
  /** Default cooloff when a 429 arrives without a parseable Retry-After. */
  defaultRetryAfter: Duration;
}>;

export type PlatformClient = Readonly<{
  listDevices: () => Promise<Outcome<DeviceSummary[]>>;
  sendCommand: (deviceId: string, command: Command) => Promise<Outcome<CommandReportState>>;
  fetchReport: (commandId: string) => Promise<Outcome<{ state: CommandReportState; at: Instant }>>;
}>;

type Token = { value: string; expiresAt: number };

export function createClient(opts: ClientOptions): PlatformClient {
  let token: Token | null = null;

  async function authenticate(): Promise<Outcome<string>> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    });
    const res = await request('POST', '/oauth/token', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) return res;
    const parsed = res.value as { access_token: string; expires_in: number };
    // Refresh early. Refreshing exactly at expiry means every token's last
    // request races the clock, and the one that loses the race is a spurious
    // 401 in the middle of a command dispatch.
    token = { value: parsed.access_token, expiresAt: Date.now() + parsed.expires_in * 900 };
    return { ok: true, value: parsed.access_token };
  }

  async function bearer(): Promise<Outcome<string>> {
    if (token !== null && token.expiresAt > Date.now()) return { ok: true, value: token.value };
    return authenticate();
  }

  /** One HTTP call, with every failure mapped to the outcome the caller acts on. */
  async function request(
    method: string,
    path: string,
    init: Readonly<{ headers?: Record<string, string>; body?: string }> = {},
  ): Promise<Outcome<unknown>> {
    let res: Response;
    try {
      res = await fetch(new URL(path, opts.baseUrl), {
        method,
        ...(init.headers === undefined ? {} : { headers: init.headers }),
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: AbortSignal.timeout(opts.requestTimeout),
      });
    } catch (error) {
      // A timeout and a connection refusal are the same thing to the caller:
      // the request did not happen, try again later, and count it against the
      // vendor's health.
      return { ok: false, kind: 'unavailable', detail: String(error) };
    }

    if (res.status === 429) {
      return {
        ok: false,
        kind: 'rate-limited',
        retryAfter: parseRetryAfter(
          res.headers.get('retry-after'),
          instant(Date.now()),
          opts.defaultRetryAfter,
        ),
      };
    }
    if (res.status >= 500) {
      return { ok: false, kind: 'unavailable', detail: `${res.status} ${await text(res)}` };
    }
    if (!res.ok) {
      return { ok: false, kind: 'rejected', status: res.status, detail: await text(res) };
    }
    return { ok: true, value: await res.json() };
  }

  /** Authenticated call, retrying ONCE on a 401 with a fresh token. */
  async function authed(
    method: string,
    path: string,
    body?: Readonly<{ json: unknown; headers?: Record<string, string> }>,
  ): Promise<Outcome<unknown>> {
    const attempt = async (): Promise<Outcome<unknown>> => {
      const auth = await bearer();
      if (!auth.ok) return auth;
      return request(method, path, {
        headers: {
          authorization: `Bearer ${auth.value}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...body?.headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body.json) }),
      });
    };

    const first = await attempt();
    // A single retry, and only for 401. Tokens expire, clocks differ, and a
    // platform can revoke one early; re-authenticating once is correct. Looping
    // would turn a genuinely wrong credential into an authentication storm, so
    // the second 401 is returned as a rejection for the caller to surface.
    if (first.ok || first.kind !== 'rejected' || first.status !== 401) return first;
    token = null;
    return attempt();
  }

  return {
    async listDevices() {
      const devices: DeviceSummary[] = [];
      let cursor: string | null = null;
      // Follow the cursor to the end. A client that reads one page silently
      // reconciles only the first N devices in the fleet — a bug that stays
      // invisible until the fleet outgrows a page, at which point the devices
      // that stop being reconciled are the ones added most recently.
      do {
        const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
        const page = await authed('GET', `/v1/devices${query}`);
        if (!page.ok) return page;
        const parsed = page.value as { devices: DeviceSummary[]; nextCursor: string | null };
        devices.push(...parsed.devices);
        cursor = parsed.nextCursor;
      } while (cursor !== null);
      return { ok: true, value: devices };
    },

    async sendCommand(deviceId, command) {
      const res = await authed('POST', `/v1/devices/${encodeURIComponent(deviceId)}/commands`, {
        json: { target: command.target, generation: command.generation },
        // THE IDEMPOTENCY KEY. Our command id, which is also the outbox's
        // primary key, which is why at-least-once dispatch cannot produce a
        // second actuation. The two halves are a pair: without the key the
        // outbox is unsafe, and without the outbox the key has nothing to
        // deduplicate.
        headers: { 'idempotency-key': command.commandId },
      });
      if (!res.ok) return res;
      return { ok: true, value: (res.value as { state: CommandReportState }).state };
    },

    async fetchReport(commandId) {
      const res = await authed('GET', `/v1/commands/${encodeURIComponent(commandId)}`);
      if (!res.ok) return res;
      const parsed = res.value as { state: CommandReportState; at: number };
      return { ok: true, value: { state: parsed.state, at: instant(parsed.at) } };
    },
  };
}

const text = async (res: Response): Promise<string> => (await res.text()).slice(0, 200);

export const defaultRequestTimeout = duration(5_000);
