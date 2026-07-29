// Run `fn` over `items` with at most `limit` calls in flight at once, preserving
// input order in the returned results array. Used to parallelize independent
// per-item work (e.g. per-page extraction) without overwhelming a provider's
// rate limits. If any call rejects, the returned promise rejects with that error
// (matching a serial loop that throws on the first failing item).
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}
