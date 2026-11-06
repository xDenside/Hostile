const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function reuse<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return next;
  if (Array.isArray(prev) && Array.isArray(next)) {
    const items = next.map((item, i) => reuse(prev[i], item as unknown));
    const same = items.length === prev.length && items.every((item, i) => item === prev[i]);
    return (same ? prev : items) as T;
  }
  if (isRecord(prev) && isRecord(next)) {
    const keys = Object.keys(next);
    let same = keys.length === Object.keys(prev).length;
    const fields: Record<string, unknown> = {};
    for (const key of keys) {
      fields[key] = reuse(prev[key], next[key]);
      if (fields[key] !== prev[key] || !Object.hasOwn(prev, key)) same = false;
    }
    return (same ? prev : fields) as T;
  }
  return next;
}
