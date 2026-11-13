import { describe, expect, it } from 'vitest';
import { migrateDocument } from '../src/infrastructure/templates-engine/engine/migrate.js';
import { validateDocument } from '../src/infrastructure/templates-engine/engine/validate.js';
import { getRegistry } from '../src/infrastructure/templates-engine/registry/index.js';
import { classicPreset } from '../src/infrastructure/templates-engine/presets.js';
import type { TemplateDocument } from '../src/infrastructure/templates-engine/document.js';

describe('engine parity and invariants (D2, D3, Task 1.1)', () => {
  const registry = getRegistry();

  it('AC-LIFE-001: validates and migrates an approved preset document (valid page doc)', () => {
    // 1. migrateDocument on valid preset is an identity structured clone
    const migrated = migrateDocument('index', classicPreset);
    expect(migrated).toEqual(classicPreset);
    expect(migrated).not.toBe(classicPreset); // must not alias

    // 2. validateDocument passes with tenant context
    const result = validateDocument('index', classicPreset, registry, {
      tenantId: 'tenant-1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.schemaVersion).toBe(1);
      expect(result.document.layout).toBe('classic');
      expect(result.issues).toEqual([]);
    }
  });

  it('AC-LIFE-001: migrates doc without layout by defaulting to classic; raw doc fails validation', () => {
    // Create doc without layout property
    const { layout: _, ...docWithoutLayout } = classicPreset;
    expect(
      (docWithoutLayout as Record<string, unknown>).layout,
    ).toBeUndefined();

    // Raw document fails validation because layout is missing
    const rawValidation = validateDocument(
      'index',
      docWithoutLayout,
      registry,
      {
        tenantId: 'tenant-1',
      },
    );
    expect(rawValidation.ok).toBe(false);
    expect(rawValidation.issues.some((i) => i.path === 'layout')).toBe(true);

    // migrateDocument supplies DEFAULT_LAYOUT ("classic")
    const migrated = migrateDocument('index', docWithoutLayout);
    expect(migrated.layout).toBe('classic');

    // Migrated document passes validation
    const migratedValidation = validateDocument('index', migrated, registry, {
      tenantId: 'tenant-1',
    });
    expect(migratedValidation.ok).toBe(true);
  });

  it('AC-LIFE-001: rejects unsupported schemaVersion at both migration and validation boundaries', () => {
    const invalidDoc = { ...classicPreset, schemaVersion: 2 };

    // migrateDocument throws
    expect(() => migrateDocument('index', invalidDoc)).toThrow(
      'Unsupported schemaVersion: 2. Current supported version is 1',
    );

    // validateDocument reports validation issue
    const result = validateDocument('index', invalidDoc, registry, {
      tenantId: 'tenant-1',
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === 'schemaVersion')).toBe(true);
  });

  it('AC-LIFE-001: rejects document exceeding jsonb size limit (LIMITS.maxDocumentBytes)', () => {
    // Construct doc exceeding 262,144 jsonb bytes
    const largeHeading = 'A'.repeat(4_900); // under maxTextLength (5000)
    const largeDoc: TemplateDocument = structuredClone(classicPreset);

    // Add multiple sections with large text to push total jsonb size over LIMITS.maxDocumentBytes
    for (let i = 0; i < 20; i++) {
      const secId = `sec_extra_${i}`;
      largeDoc.sections[secId] = {
        type: 'rich-text',
        settings: { heading: largeHeading },
        blocks: {
          [`blk_${i}_1`]: {
            type: 'text',
            settings: { content: largeHeading },
            blocks: {},
            block_order: [],
          },
          [`blk_${i}_2`]: {
            type: 'text',
            settings: { content: largeHeading },
            blocks: {},
            block_order: [],
          },
        },
        block_order: [`blk_${i}_1`, `blk_${i}_2`],
      };
      largeDoc.order.push(secId);
    }

    const result = validateDocument('index', largeDoc, registry, {
      tenantId: 'tenant-1',
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'DOCUMENT_SIZE_EXCEEDED')).toBe(
      true,
    );
  });

  it('AC-LIFE-016: enforces tenant storage isolation on image paths (foreign-tenant image path fails)', () => {
    const docWithImage: TemplateDocument = structuredClone(classicPreset);
    // hero section banner image path pointing to foreign tenant
    docWithImage.sections.hero = {
      type: 'hero',
      settings: {
        heading: 'Hero Heading',
        image: { path: 'foreign-tenant/store/banner.jpg', alt: 'Banner' },
      },
      blocks: {},
      block_order: [],
    };

    // Validating as "my-tenant" must reject "foreign-tenant" path
    const foreignValidation = validateDocument(
      'index',
      docWithImage,
      registry,
      {
        tenantId: 'my-tenant',
      },
    );
    expect(foreignValidation.ok).toBe(false);
    const crossTenantIssue = foreignValidation.issues.find(
      (i) => i.code === 'CROSS_TENANT_PATH',
    );
    expect(crossTenantIssue).toBeDefined();
    expect(crossTenantIssue?.message).toContain(
      "Image must be a file in this store's own image folder",
    );

    // Validating as "foreign-tenant" must accept the path
    const ownValidation = validateDocument('index', docWithImage, registry, {
      tenantId: 'foreign-tenant',
    });
    expect(ownValidation.ok).toBe(true);
  });
});
