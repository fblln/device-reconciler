/**
 * queue.ts — bounded concurrency, in twenty lines.
 *
 * WHY BOUNDED AT ALL
 * ------------------
 * `Promise.all(devices.map(reconcile))` on a fleet of ten thousand opens ten
 * thousand concurrent HTTP requests and ten thousand database queries. The pool
 * has ten connections, so most of those queue inside the pool and time out
 * there; the sockets exhaust the ephemeral port range; and every vendor sees the
 * entire fleet arrive at once, which is the thundering herd the rate limiter is
 * supposed to prevent being created by the layer above it.
 *
 * The bound is the pool size's sibling: the queue limit is what the connection
 * pool is sized FROM, not the other way round, so the two cannot disagree.
 *
 * WHY NOT p-limit
 * ---------------
 * ponytail: it is this file. An index into an array and N workers pulling from
 * it is the whole algorithm, and it has no behaviour worth a dependency —
 * no priorities, no cancellation, no dynamic resizing. If any of those are ever
 * needed, that is the moment to take the dependency.
 *
 * Note that it never rejects: a task that throws yields an entry in the results
 * rather than killing its siblings. One device whose vendor returned nonsense
 * must not stop the other thirty-one in the batch from reconciling, and a
 * rejected `Promise.all` would do exactly that while also losing the results of
 * everything that had already succeeded.
 */

export type Settled<R> = Readonly<{ ok: true; value: R } | { ok: false; error: unknown }>;

export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<Array<Settled<R>>> {
  const results: Array<Settled<R>> = Array.from({ length: items.length });
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      // Bounds, not `item === undefined`: an array that legitimately holds
      // undefined would make the pool stop early, silently dropping work.
      if (index >= items.length) return;
      const item = items[index]!;
      try {
        results[index] = { ok: true, value: await work(item) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
