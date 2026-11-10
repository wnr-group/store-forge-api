import type {
  ComponentNode,
  TemplateDocument,
} from '../../../infrastructure/database/template-deps/document.js';

const MAX_ATTEMPTS = 50;

export function cloneWithFreshIds(
  doc: TemplateDocument,
  generate: (prefix: string) => string,
): TemplateDocument {
  const used = new Set<string>(['__proto__']);
  const fresh = (prefix: string): string => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const id = generate(prefix);
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
    throw new Error('Cannot generate a unique node id');
  };

  const copyNode = (node: ComponentNode): ComponentNode => {
    const { blocks, block_order, settings, ...rest } = node;
    const map = new Map<string, string>();
    const newBlocks: Record<string, ComponentNode> = {};

    for (const [oldId, child] of Object.entries(blocks)) {
      const id = fresh('blk');
      map.set(oldId, id);
      newBlocks[id] = copyNode(child);
    }

    const order = block_order.map((oldId) => {
      const id = map.get(oldId);
      if (!id) throw new Error(`block_order references unknown block ${oldId}`);
      return id;
    });

    return {
      ...structuredClone(rest),
      settings: structuredClone(settings),
      blocks: newBlocks,
      block_order: order,
    };
  };

  const { sections, order, ...top } = doc;
  const map = new Map<string, string>();
  const newSections: Record<string, ComponentNode> = {};

  for (const [oldId, section] of Object.entries(sections)) {
    const id = fresh('sec');
    map.set(oldId, id);
    newSections[id] = copyNode(section);
  }

  const newOrder = order.map((oldId) => {
    const id = map.get(oldId);
    if (!id) throw new Error(`order references unknown section ${oldId}`);
    return id;
  });

  return { ...structuredClone(top), sections: newSections, order: newOrder };
}
