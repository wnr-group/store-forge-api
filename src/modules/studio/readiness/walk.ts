export interface WalkedNode {
  id: string;
  kind: 'section' | 'block';
  node: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function* walkNodes(
  nodes: unknown,
  kind: 'section' | 'block',
  activeOnly: boolean,
  depth: number,
): Generator<WalkedNode> {
  if (!isRecord(nodes) || depth > 8) return;
  for (const [id, node] of Object.entries(nodes)) {
    if (!isRecord(node)) continue;
    // A disabled node does not render, and neither does anything inside it.
    if (activeOnly && node.disabled === true) continue;
    yield { id, kind, node };
    yield* walkNodes(node.blocks, 'block', activeOnly, depth + 1);
  }
}

/**
 * Every section and block of a document, including the pages a theme_settings document redesigns. Never throws.
 * With `activeOnly` a disabled node and its children are skipped.
 */
export function* walkDocument(
  doc: unknown,
  activeOnly = true,
): Generator<WalkedNode> {
  if (!isRecord(doc)) return;
  yield* walkNodes(doc.sections, 'section', activeOnly, 0);
  const settings = doc.settings;
  if (isRecord(settings) && isRecord(settings.pages))
    for (const page of Object.values(settings.pages))
      if (isRecord(page))
        yield* walkNodes(page.sections, 'section', activeOnly, 0);
}
