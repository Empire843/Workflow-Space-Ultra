/**
 * Map async with bounded concurrency. Preserves input order in the result.
 * Small in-house implementation — no p-limit dependency.
 *
 * - `limit` is clamped to `[1, items.length]`.
 * - If any `fn` rejects, the entire map rejects (like `Promise.all`). Wrap
 *   individual items in `try/catch` + return a discriminated result if you
 *   want per-item error handling (see `resolveVeoMediaId` usage).
 */
export async function pMapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (!items.length) return results;
  const actualLimit = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const workers = Array.from({ length: actualLimit }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}
