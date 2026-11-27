import {
  buildTree,
  freeSlug,
  nodeSlugFromName,
  reorderProblems,
} from './catalog-hierarchy.rules.js';

const L = (id: string) => ({ id, name: id.toUpperCase() });

describe('nodeSlugFromName', () => {
  it('makes an address from a name', () => {
    expect(nodeSlugFromName('Toyota Camry LE 2.5')).toBe('toyota-camry-le-2-5');
    expect(nodeSlugFromName('  Área & Café ')).toBe('area-cafe');
  });
  it('never returns an empty address', () => {
    expect(nodeSlugFromName('###')).toBe('item');
    expect(nodeSlugFromName('')).toBe('item');
  });
  it('keeps one-character names (a level can hold "5" or "X")', () => {
    expect(nodeSlugFromName('X')).toBe('x');
  });
  it('stays within 80 characters and never ends with a hyphen', () => {
    const slug = nodeSlugFromName('word '.repeat(40));
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('freeSlug', () => {
  it('uses the base when it is free, else the next number', () => {
    expect(freeSlug('a', new Set())).toBe('a');
    expect(freeSlug('a', new Set(['a']))).toBe('a-2');
    expect(freeSlug('a', new Set(['a', 'a-2', 'a-3']))).toBe('a-4');
  });
  it('keeps the result within 80 characters', () => {
    const base = 'x'.repeat(80);
    const slug = freeSlug(base, new Set([base]));
    expect(slug.length).toBe(80);
    expect(slug.endsWith('-2')).toBe(true);
  });
});

describe('reorderProblems (is a new level order safe?)', () => {
  const usage = {
    // brand -> vehicle -> part, with top-level items on brand
    pairs: [
      { parentLevelId: 'brand', childLevelId: 'vehicle' },
      { parentLevelId: 'vehicle', childLevelId: 'part' },
    ],
    rootLevelIds: ['brand'],
  };

  it('accepts the current order', () => {
    expect(
      reorderProblems([L('brand'), L('vehicle'), L('part')], usage),
    ).toEqual([]);
  });

  it('accepts moving levels that no item uses', () => {
    const none = { pairs: [], rootLevelIds: [] };
    expect(
      reorderProblems([L('part'), L('brand'), L('vehicle')], none),
    ).toEqual([]);
    const used = {
      pairs: [{ parentLevelId: 'brand', childLevelId: 'vehicle' }],
      rootLevelIds: ['brand'],
    };
    // "part" and "extra" are unused: they may swap
    expect(
      reorderProblems([L('brand'), L('vehicle'), L('extra'), L('part')], used),
    ).toEqual([]);
  });

  it('refuses to invert a parent and its child level', () => {
    const problems = reorderProblems(
      [L('vehicle'), L('brand'), L('part')],
      usage,
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('"VEHICLE"');
  });

  it('refuses to push a level with top-level items away from the first place', () => {
    const problems = reorderProblems([L('part'), L('brand'), L('vehicle')], {
      pairs: [],
      rootLevelIds: ['brand'],
    });
    expect(problems).toEqual([
      '"BRAND" has top-level items, so it has to stay the first level.',
    ]);
  });

  it('refuses to put another level between a used parent and child', () => {
    const problems = reorderProblems(
      [L('brand'), L('extra'), L('vehicle'), L('part')],
      usage,
    );
    expect(problems.length).toBeGreaterThan(0);
  });

  it('treats a level that is missing from the order as a problem, not a crash', () => {
    expect(reorderProblems([L('brand')], usage).length).toBeGreaterThan(0);
  });
});

describe('buildTree', () => {
  const n = (id: string, parentId: string | null, position: number) => ({
    id,
    parentId,
    position,
    name: id,
  });

  it('nests children under parents and orders siblings by position, then name', () => {
    const tree = buildTree([
      n('b', null, 2),
      n('a', null, 1),
      n('a2', 'a', 2),
      n('a1', 'a', 1),
      n('a1x', 'a1', 0),
    ]);
    expect(tree.map((x) => x.id)).toEqual(['a', 'b']);
    expect(tree[0].children.map((x) => x.id)).toEqual(['a1', 'a2']);
    expect(tree[0].children[0].children.map((x) => x.id)).toEqual(['a1x']);
  });

  it('makes a node whose parent is not in the list a root', () => {
    const tree = buildTree([n('x', 'missing', 0)]);
    expect(tree.map((x) => x.id)).toEqual(['x']);
  });

  it('copes with an empty list', () => {
    expect(buildTree([])).toEqual([]);
  });
});
