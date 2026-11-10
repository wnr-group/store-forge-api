/**
 * Every string `path` held by an object (arrays excluded) anywhere in `root`; iterative, de-duplicated.
 * D41: Iterative walk so deeply nested inputs cannot overflow the call stack.
 */
export function collectImagePaths(root: unknown): string[] {
  const found = new Set<string>();
  const stack: unknown[] = [root];

  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== 'object' || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }

    const record = value as Record<string, unknown>;
    if (typeof record.path === 'string') found.add(record.path);
    for (const key of Object.keys(record)) stack.push(record[key]);
  }

  return [...found];
}
