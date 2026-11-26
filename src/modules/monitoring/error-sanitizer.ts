/**
 * What may be kept of an error message. Monitoring data is read by platform staff, so it must never carry what a message can contain:
 * database values and ids, e-mail addresses, tokens, keys, long numbers or the SQL text with its parameters. Everything that looks like
 * one of those is replaced by a placeholder, and the result is cut short.
 */
const MAX = 300;

export function sanitizeMessage(raw: unknown): string {
  let m =
    raw instanceof Error
      ? raw.message
      : typeof raw === 'string'
        ? raw
        : 'Unknown error';
  // The database driver puts the whole query, with its parameters, in the message.
  if (/^Failed query/i.test(m)) m = 'Database query failed';
  m = m
    .split(/\r?\n/)[0]
    .replace(/\b(?:params|detail|key)\s*[:(=].*$/i, '')
    .replace(/eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}/g, '<token>')
    .replace(/\bBearer\s+\S+/gi, 'Bearer <token>')
    .replace(/\brzp_(?:test|live)_[A-Za-z0-9]+/g, '<key>')
    .replace(/\b(?:sk|pk|key|secret)[_-][A-Za-z0-9_-]{8,}\b/gi, '<key>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      '<id>',
    )
    .replace(/\b[0-9a-f]{24,}\b/gi, '<hex>')
    .replace(/\d{6,}/g, '<n>')
    .replace(/(["'`])(?:(?!\1).){12,}\1/g, '$1<text>$1')
    .trim();
  return (m || 'Unknown error').slice(0, MAX);
}

/** "functionName file.ts:12" from the first stack frame that belongs to the application; undefined when there is none. */
export function sourceOf(error: unknown): string | undefined {
  const stack = error instanceof Error ? error.stack : undefined;
  if (!stack) return undefined;
  for (const line of stack.split('\n').slice(1)) {
    if (line.includes('node_modules') || line.includes('node:internal'))
      continue;
    const m = /at (?:(.+?) \()?.*?([^/\\()]+):(\d+):\d+\)?\s*$/.exec(line);
    if (m) return `${m[1] ? `${m[1]} ` : ''}${m[2]}:${m[3]}`.slice(0, 150);
  }
  return undefined;
}

/** A route to group errors by when Express has no template for it (a 404 never reaches here, so this is only a fallback). */
export function templateOf(path: string): string {
  return path
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      ':id',
    )
    .replace(/\/\d+(?=\/|$)/g, '/:n')
    .slice(0, 200);
}

/** Only small, plain values survive: a job summary is counts and flags, not data. */
export function summarize(
  result: unknown,
): Record<string, number | boolean | string> | null {
  if (!result || typeof result !== 'object' || Array.isArray(result))
    return null;
  const out: Record<string, number | boolean | string> = {};
  for (const [k, v] of Object.entries(result as Record<string, unknown>).slice(
    0,
    20,
  )) {
    if (typeof v === 'number' || typeof v === 'boolean')
      out[k.slice(0, 40)] = v;
    else if (typeof v === 'string')
      out[k.slice(0, 40)] = sanitizeMessage(v).slice(0, 80);
  }
  return Object.keys(out).length ? out : null;
}
