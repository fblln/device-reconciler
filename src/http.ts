/**
 * http.ts — the forty lines of HTTP plumbing both services share.
 *
 * WHY NOT A FRAMEWORK
 * -------------------
 * Between them, the mock platform and the reconciler expose nine endpoints.
 * Nine. A framework would add a dependency tree larger than this repository, a
 * middleware model nobody needs, and its own opinions about error handling —
 * in exchange for routing that is a switch statement and a body reader that is
 * an async iterator. `node:http` is stdlib, it is what every framework here
 * wraps, and keeping it means the whole request path is readable in one sitting,
 * which matters when the interesting part of the system is elsewhere.
 *
 * The one thing that is NOT skipped is the body size cap. An unbounded body
 * reader on a public endpoint is a one-line denial of service, and the webhook
 * ingest endpoint is the only thing in this system reachable from outside.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

export const MAX_BODY = 1 << 20;

/**
 * Read a request body, refusing anything oversized. Rejects rather than
 * truncating: a truncated JSON body would fail to parse and be reported as a
 * malformed request, which sends whoever is debugging it to the wrong place.
 */
export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new Error(`request body exceeds ${MAX_BODY} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export function sendText(res: ServerResponse, status: number, body: string, type = 'text/plain'): void {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8` });
  res.end(body);
}

/**
 * Wrap a handler so a throw becomes a 500 instead of an unhandled rejection
 * that kills the process. A reconciler that dies because one webhook was
 * malformed is a reconciler that an attacker, or a vendor with a bad release,
 * can stop by sending it one bad request.
 */
export function serve(port: number, handler: Handler): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        await handler(req, res);
      } catch (error) {
        if (!res.headersSent) sendJson(res, 500, { error: String(error) });
        else res.end();
      }
    })();
  });
  server.listen(port);
  return server;
}

/** The URL of a request, with a base, because IncomingMessage.url is path-only. */
export const urlOf = (req: IncomingMessage): URL => new URL(req.url ?? '/', 'http://localhost');
