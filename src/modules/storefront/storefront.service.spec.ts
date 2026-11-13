import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../database/database.service.js';
import { StorefrontService } from './storefront.service.js';

describe('StorefrontService unit tests (PR-D, T-D3)', () => {
  let withPublicMock: any;

  const createMockDb = (
    withPublicImpl: (fn: (tx: any) => Promise<any>) => Promise<any>,
  ): DatabaseService => {
    withPublicMock = vi.fn(withPublicImpl);
    return {
      withPublic: withPublicMock,
    } as unknown as DatabaseService;
  };

  describe('isEngineReadEnabled (AC-D-04 cutover gate)', () => {
    it('returns true only when template_engine_cutover_complete returns boolean true', async () => {
      const mockDb = createMockDb(async (fn) =>
        fn({
          execute: vi.fn().mockResolvedValue([{ ok: true }]),
        }),
      );
      const service = new StorefrontService(mockDb);

      expect(await service.isEngineReadEnabled()).toBe(true);
    });

    it('returns false when function returns boolean false', async () => {
      const mockDb = createMockDb(async (fn) =>
        fn({
          execute: vi.fn().mockResolvedValue([{ ok: false }]),
        }),
      );
      const service = new StorefrontService(mockDb);

      expect(await service.isEngineReadEnabled()).toBe(false);
    });

    it('returns false when function returns a non-boolean (e.g. string "true" or null)', async () => {
      const mockDb = createMockDb(async (fn) =>
        fn({
          execute: vi.fn().mockResolvedValue([{ ok: 'true' }]),
        }),
      );
      const service = new StorefrontService(mockDb);

      expect(await service.isEngineReadEnabled()).toBe(false);
    });

    it('returns false when function returns no rows', async () => {
      const mockDb = createMockDb(async (fn) =>
        fn({
          execute: vi.fn().mockResolvedValue([]),
        }),
      );
      const service = new StorefrontService(mockDb);

      expect(await service.isEngineReadEnabled()).toBe(false);
    });

    it('returns false when database throws (missing function, connection lost, timeout)', async () => {
      const mockDb = createMockDb(async () => {
        throw new Error(
          'function public.template_engine_cutover_complete() does not exist',
        );
      });
      const service = new StorefrontService(mockDb);

      expect(await service.isEngineReadEnabled()).toBe(false);
    });
  });

  describe('getStorefront (legacy ungated read)', () => {
    it('returns parsed storefront when store exists', async () => {
      const rawStore = {
        name: 'Test Store',
        slug: 'test-store',
        description: null,
        logo_path: null,
        currency: 'INR',
        products: [],
        template: null,
      };

      const mockDb = createMockDb(async (fn) =>
        fn({
          execute: vi.fn().mockResolvedValue([{ s: rawStore }]),
        }),
      );
      const service = new StorefrontService(mockDb);

      const res = await service.getStorefront('test-store');
      expect(res).toBeDefined();
      expect(res?.slug).toBe('test-store');
    });

    it('returns null without querying DB when slug is empty or whitespace', async () => {
      const mockDb = createMockDb(async () => {});
      const service = new StorefrontService(mockDb);

      expect(await service.getStorefront('')).toBeNull();
      expect(await service.getStorefront('   ')).toBeNull();
      expect(withPublicMock).not.toHaveBeenCalled();
    });

    it('returns null when store not found (DB returns s: null)', async () => {
      const mockDb = createMockDb(async (fn) =>
        fn({
          execute: vi.fn().mockResolvedValue([{ s: null }]),
        }),
      );
      const service = new StorefrontService(mockDb);

      expect(await service.getStorefront('unknown-store')).toBeNull();
    });

    it('propagates DB error if query fails', async () => {
      const mockDb = createMockDb(async () => {
        throw new Error('database connection lost');
      });
      const service = new StorefrontService(mockDb);

      await expect(service.getStorefront('test-store')).rejects.toThrow(
        'database connection lost',
      );
    });
  });

  describe('gated operations when cutover gate is closed (AC-D-04, PD-O1)', () => {
    let closedService: StorefrontService;
    let mockDb: DatabaseService;

    beforeEach(() => {
      mockDb = createMockDb(async (fn) =>
        fn({
          execute: vi.fn().mockResolvedValue([{ ok: false }]),
        }),
      );
      closedService = new StorefrontService(mockDb);
    });

    it('getTemplateLayout returns null when gate is closed', async () => {
      const res = await closedService.getTemplateLayout('store', 'index');
      expect(res).toBeNull();
    });

    it('getProduct returns null when gate is closed', async () => {
      const res = await closedService.getProduct('store', 'prod');
      expect(res).toBeNull();
    });

    it('getCollection returns null when gate is closed', async () => {
      const res = await closedService.getCollection('store', 'coll');
      expect(res).toBeNull();
    });

    it('getCollections returns null when gate is closed', async () => {
      const res = await closedService.getCollections('store');
      expect(res).toBeNull();
    });
  });

  describe('gated operations when cutover gate is open', () => {
    it('getTemplateLayout returns parsed layout', async () => {
      const layoutData = {
        source: 'assigned',
        template: {
          name: 'Tmpl',
          version_number: 1,
          document: { schemaVersion: 1 },
        },
        theme: null,
        groups: { header: null, footer: null, announcement: null },
      };

      let call = 0;
      const mockDb = createMockDb(async (fn) =>
        fn({
          execute: vi.fn().mockImplementation(() => {
            if (call++ === 0) return [{ ok: true }];
            return [{ l: layoutData }];
          }),
        }),
      );
      const service = new StorefrontService(mockDb);

      const res = await service.getTemplateLayout('store', 'index');
      expect(res?.source).toBe('assigned');
      expect(res?.template?.name).toBe('Tmpl');
    });

    it('getProduct returns parsed product', async () => {
      const productData = {
        store: { name: 'S', slug: 's', currency: 'INR' },
        product: { name: 'P', slug: 'p', price_minor: 1000 },
        images: [],
        options: [],
        variants: [],
        related: [],
      };

      let call = 0;
      const mockDb = createMockDb(async (fn) =>
        fn({
          execute: vi.fn().mockImplementation(() => {
            if (call++ === 0) return [{ ok: true }];
            return [{ p: productData }];
          }),
        }),
      );
      const service = new StorefrontService(mockDb);

      const res = await service.getProduct('store', 'prod');
      expect(res?.product.slug).toBe('p');
    });

    it('getCollection returns parsed collection', async () => {
      const collectionData = {
        store: { name: 'S', slug: 's', currency: 'INR' },
        collection: { id: 'c1', name: 'C', slug: 'c' },
        products: [],
      };

      let call = 0;
      const mockDb = createMockDb(async (fn) =>
        fn({
          execute: vi.fn().mockImplementation(() => {
            if (call++ === 0) return [{ ok: true }];
            return [{ c: collectionData }];
          }),
        }),
      );
      const service = new StorefrontService(mockDb);

      const res = await service.getCollection('store', 'coll');
      expect(res?.collection.slug).toBe('c');
    });

    it('getCollections returns parsed collections list', async () => {
      const collectionsData = [
        { id: 'c1', name: 'C1', slug: 'c1', product_count: 5 },
      ];

      let call = 0;
      const mockDb = createMockDb(async (fn) =>
        fn({
          execute: vi.fn().mockImplementation(() => {
            if (call++ === 0) return [{ ok: true }];
            return [{ cols: collectionsData }];
          }),
        }),
      );
      const service = new StorefrontService(mockDb);

      const res = await service.getCollections('store');
      expect(res).toHaveLength(1);
      expect(res?.[0].product_count).toBe(5);
    });

    it('gated functions propagate data DB errors when gate is open', async () => {
      let callCount = 0;
      const mockDb = createMockDb(async (fn) =>
        fn({
          execute: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
              return [{ ok: true }]; // Gate open
            }
            throw new Error('DB connection failure on data query');
          }),
        }),
      );
      const service = new StorefrontService(mockDb);

      await expect(service.getProduct('store', 'prod')).rejects.toThrow(
        'DB connection failure on data query',
      );
    });
  });
});
