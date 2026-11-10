import { describe, expect, it } from 'vitest';
import type { TemplateDocument } from '../../../infrastructure/database/template-deps/document.js';
import { cloneWithFreshIds } from './fresh-ids.js';

describe('fresh-ids (D21)', () => {
  const createSampleDoc = (): TemplateDocument => ({
    schemaVersion: 1,
    layout: 'classic',
    sections: {
      sec_hero: {
        type: 'hero',
        settings: {
          heading: 'Welcome',
          image: { path: 'tenant/store/hero.jpg' },
        },
        blocks: {
          blk_btn1: {
            type: 'button',
            settings: { label: 'Shop Now' },
            blocks: {},
            block_order: [],
          },
          blk_btn2: {
            type: 'button',
            settings: { label: 'Learn More' },
            blocks: {},
            block_order: [],
          },
        },
        block_order: ['blk_btn1', 'blk_btn2'],
      },
      sec_featured: {
        type: 'featured-collection',
        settings: { title: 'Featured' },
        blocks: {},
        block_order: [],
      },
    },
    order: ['sec_hero', 'sec_featured'],
  });

  it('AC-LIFE-002: generates fresh IDs differing from source for every section and block', () => {
    const source = createSampleDoc();
    let counter = 1;
    const generate = (prefix: string) => `${prefix}_${counter++}`;

    const cloned = cloneWithFreshIds(source, generate);

    // Every section and block id must be new
    const oldSectionIds = Object.keys(source.sections);
    const newSectionIds = Object.keys(cloned.sections);
    expect(newSectionIds).not.toEqual(oldSectionIds);
    for (const oldId of oldSectionIds) {
      expect(newSectionIds).not.toContain(oldId);
    }

    // Check block ids
    const oldBlockIds = Object.keys(source.sections.sec_hero.blocks);
    const newHeroSec = Object.values(cloned.sections)[0];
    const newBlockIds = Object.keys(newHeroSec.blocks);
    expect(newBlockIds).toHaveLength(oldBlockIds.length);
    for (const oldId of oldBlockIds) {
      expect(newBlockIds).not.toContain(oldId);
    }
  });

  it('AC-LIFE-002: order and block_order map to the corresponding new IDs in the same order', () => {
    const source = createSampleDoc();
    let counter = 100;
    const generate = (prefix: string) => `${prefix}_${counter++}`;

    const cloned = cloneWithFreshIds(source, generate);

    expect(cloned.order).toHaveLength(source.order.length);
    expect(cloned.order[0]).toBe(Object.keys(cloned.sections)[0]);
    expect(cloned.order[1]).toBe(Object.keys(cloned.sections)[1]);

    const newHeroSec = cloned.sections[cloned.order[0]];
    expect(newHeroSec.block_order).toHaveLength(2);
    expect(newHeroSec.block_order[0]).toBe(Object.keys(newHeroSec.blocks)[0]);
    expect(newHeroSec.block_order[1]).toBe(Object.keys(newHeroSec.blocks)[1]);
  });

  it('AC-LIFE-002: settings are deep-equal and not aliased (modifications do not leak)', () => {
    const source = createSampleDoc();
    let counter = 1;
    const generate = (prefix: string) => `${prefix}_${counter++}`;

    const cloned = cloneWithFreshIds(source, generate);

    const firstClonedSec = cloned.sections[cloned.order[0]];
    expect(firstClonedSec.settings).toEqual(source.sections.sec_hero.settings);

    // Mutate cloned setting
    firstClonedSec.settings.heading = 'Changed';
    expect(source.sections.sec_hero.settings.heading).toBe('Welcome');
  });

  it('AC-LIFE-002: all generated IDs are strictly unique across sections and blocks', () => {
    const source = createSampleDoc();
    let counter = 1;
    const generate = (prefix: string) => `${prefix}_${counter++}`;

    const cloned = cloneWithFreshIds(source, generate);

    const allIds = new Set<string>();
    for (const secId of Object.keys(cloned.sections)) {
      expect(allIds.has(secId)).toBe(false);
      allIds.add(secId);
      for (const blkId of Object.keys(cloned.sections[secId].blocks)) {
        expect(allIds.has(blkId)).toBe(false);
        allIds.add(blkId);
      }
    }
  });

  it('AC-LIFE-002: throws if unique node id cannot be generated within max attempts', () => {
    const source = createSampleDoc();
    const generate = () => 'collision_id';

    expect(() => cloneWithFreshIds(source, generate)).toThrow(
      'Cannot generate a unique node id',
    );
  });

  it('AC-LIFE-002: throws if order references an unknown section', () => {
    const source = createSampleDoc();
    source.order.push('sec_unknown');

    let counter = 1;
    const generate = (prefix: string) => `${prefix}_${counter++}`;

    expect(() => cloneWithFreshIds(source, generate)).toThrow(
      'order references unknown section sec_unknown',
    );
  });

  it('AC-LIFE-002: throws if block_order references an unknown block', () => {
    const source = createSampleDoc();
    source.sections.sec_hero.block_order.push('blk_unknown');

    let counter = 1;
    const generate = (prefix: string) => `${prefix}_${counter++}`;

    expect(() => cloneWithFreshIds(source, generate)).toThrow(
      'block_order references unknown block blk_unknown',
    );
  });
});
