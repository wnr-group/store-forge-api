import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  layoutPayloadSchema,
  publicCollectionPayloadSchema,
  publicCollectionsListSchema,
  publicProductPayloadSchema,
  storefrontSchema,
} from './storefront.schemas.js';

describe('Storefront Schemas and Golden Fixtures (AC-D-03, T-D2)', () => {
  const fixturesDir = resolve(process.cwd(), 'test/fixtures/public');

  it('AC-D-03: storefrontSchema validates storefront.fixture.json', () => {
    const raw = readFileSync(
      resolve(fixturesDir, 'storefront.fixture.json'),
      'utf-8',
    );
    const json = JSON.parse(raw);
    const parsed = storefrontSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe('Acme Store');
      expect(parsed.data.slug).toBe('acme-store');
      expect(parsed.data.currency).toBe('INR');
      expect(parsed.data.products).toHaveLength(1);
      expect(parsed.data.template?.key).toBe('minimal');
    }
  });

  it('keeps meta_title and meta_description through parsing, and accepts a database that does not send them', () => {
    const base = JSON.parse(
      readFileSync(resolve(fixturesDir, 'storefront.fixture.json'), 'utf-8'),
    );
    const withSeo = storefrontSchema.parse({
      ...base,
      meta_title: 'Acme | Handmade goods',
      meta_description: 'Premium handcrafted goods.',
    });
    expect(withSeo.meta_title).toBe('Acme | Handmade goods');
    expect(withSeo.meta_description).toBe('Premium handcrafted goods.');
    const nulls = storefrontSchema.parse({
      ...base,
      meta_title: null,
      meta_description: null,
    });
    expect(nulls.meta_title).toBeNull();
    expect(nulls.meta_description).toBeNull();
    // Older database function (before migration 0071): the keys are simply absent.
    expect(storefrontSchema.parse(base).meta_title).toBeUndefined();
  });

  it('AC-D-03: layoutPayloadSchema validates template-layout.fixture.json', () => {
    const raw = readFileSync(
      resolve(fixturesDir, 'template-layout.fixture.json'),
      'utf-8',
    );
    const json = JSON.parse(raw);
    const parsed = layoutPayloadSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.source).toBe('assigned');
      expect(parsed.data.template?.name).toBe('Custom Product Template');
      expect(parsed.data.theme).toBeDefined();
      expect(parsed.data.groups?.header).toBeDefined();
      expect(parsed.data.groups?.footer).toBeDefined();
      expect(parsed.data.groups?.announcement).toBeDefined();
    }
  });

  it('AC-D-03: publicProductPayloadSchema validates product.fixture.json', () => {
    const raw = readFileSync(
      resolve(fixturesDir, 'product.fixture.json'),
      'utf-8',
    );
    const json = JSON.parse(raw);
    const parsed = publicProductPayloadSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.store.slug).toBe('acme-store');
      expect(parsed.data.product.slug).toBe('classic-cotton-tshirt');
      expect(parsed.data.product.sku).toBe('TEE-COT-001');
      expect(parsed.data.images).toHaveLength(2);
      expect(parsed.data.options).toHaveLength(2);
      expect(parsed.data.variants).toHaveLength(1);
      expect(parsed.data.related).toHaveLength(1);
    }
  });

  it('AC-D-03: publicCollectionPayloadSchema validates collection.fixture.json', () => {
    const raw = readFileSync(
      resolve(fixturesDir, 'collection.fixture.json'),
      'utf-8',
    );
    const json = JSON.parse(raw);
    const parsed = publicCollectionPayloadSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.store.slug).toBe('acme-store');
      expect(parsed.data.collection.slug).toBe('summer-essentials');
      expect(parsed.data.products).toHaveLength(1);
    }
  });

  it('AC-D-03: publicCollectionsListSchema validates collections.fixture.json', () => {
    const raw = readFileSync(
      resolve(fixturesDir, 'collections.fixture.json'),
      'utf-8',
    );
    const json = JSON.parse(raw);
    const parsed = publicCollectionsListSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toHaveLength(2);
      expect(parsed.data[0].slug).toBe('summer-essentials');
      expect(parsed.data[0].product_count).toBe(12);
    }
  });

  it('AC-D-03: invalid schemas fail gracefully with zod issues', () => {
    const badStorefront = { name: 123, slug: false };
    const res = storefrontSchema.safeParse(badStorefront);
    expect(res.success).toBe(false);
  });
});
