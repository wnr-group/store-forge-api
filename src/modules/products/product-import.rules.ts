import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AppException } from '../../common/app.exception.js';
import { slugify } from '../../common/utils/slug.js';
import { unescapeCell } from '../../common/utils/spreadsheet.js';
import { CreateProductDto } from './products.dto.js';
import { assertProductRules, type ProductValues } from './product-rules.js';
import { ProductsService } from './products.service.js';

export const IMPORT_MAX_ROWS = 500;
export const IMPORT_MAX_ERRORS = 500;
const VALUE_MAX = 100;

export interface ImportRowInput {
  row: number;
  name?: string;
  price?: string;
  slug?: string;
  sku?: string;
  part_number?: string;
  short_description?: string;
  description?: string;
  product_type?: string;
  compare_at_price?: string;
  cost?: string;
  quantity?: string;
  track_inventory?: string;
  low_stock_threshold?: string;
  status?: string;
  category?: string;
  subcategory?: string;
  source_errors?: { column: string; message: string }[];
}
export interface RowError {
  row: number;
  column: string;
  message: string;
  value: string;
}
export interface ValidRow {
  row: number;
  values: ProductValues;
  sku: string | null;
  explicitSlug: string | null;
  category?: string;
  subcategory?: string;
}
export interface CategoryRef {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
}

const FIELD_TO_COLUMN: Record<string, string> = {
  name: 'name',
  price: 'price',
  slug: 'slug',
  sku: 'sku',
  partNumber: 'part_number',
  shortDescription: 'short_description',
  description: 'description',
  productType: 'product_type',
  compareAtPrice: 'compare_at_price',
  cost: 'cost',
  quantity: 'quantity',
  trackInventory: 'track_inventory',
  lowStockThreshold: 'low_stock_threshold',
  status: 'status',
};
const COLUMN_TO_FIELD = Object.fromEntries(
  Object.entries(FIELD_TO_COLUMN).map(([f, c]) => [c, f]),
);

const TRUE = new Set(['true', 'yes', '1']);
const FALSE = new Set(['false', 'no', '0']);
export function parseBoolean(v: string): boolean | 'invalid' {
  const k = v.trim().toLowerCase();
  return TRUE.has(k) ? true : FALSE.has(k) ? false : 'invalid';
}

/** Cells arrive as text; anything else (which the DTO already forbids) is shown as empty rather than "[object Object]". */
const asText = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : '';
const preview = (v: unknown) => asText(v).slice(0, VALUE_MAX);
const blank = (v: unknown) =>
  v === undefined || v === null || asText(v).trim() === '';

/** Validates one row with the SAME rules as POST /products (CreateProductDto + assertProductRules). */
export async function validateRow(
  input: ImportRowInput,
): Promise<{ errors: RowError[]; valid?: ValidRow }> {
  const errors: RowError[] = [];
  const add = (column: string, message: string) =>
    errors.push({
      row: input.row,
      column,
      message,
      value: preview((input as unknown as Record<string, unknown>)[column]),
    });
  for (const s of input.source_errors ?? []) add(s.column, s.message);

  const plain: Record<string, unknown> = {};
  for (const [column, field] of Object.entries(COLUMN_TO_FIELD)) {
    const raw = (input as unknown as Record<string, unknown>)[column];
    if (blank(raw)) continue;
    plain[field] = typeof raw === 'string' ? unescapeCell(raw.trim()) : raw;
  }
  if (typeof plain.status === 'string')
    plain.status = plain.status.toLowerCase();
  if (typeof plain.trackInventory === 'string') {
    const b = parseBoolean(plain.trackInventory);
    if (b === 'invalid') {
      add('track_inventory', 'Use true, false, yes, no, 1 or 0.');
      delete plain.trackInventory;
    } else plain.trackInventory = b;
  }
  const dto = plainToInstance(CreateProductDto, plain);
  for (const p of await validate(dto)) {
    const first = Object.values(p.constraints ?? {})[0];
    if (first) add(FIELD_TO_COLUMN[p.property] ?? p.property, first);
  }
  if (
    errors.some((e) => e.column === 'price' || e.column === 'compare_at_price')
  )
    return { errors };
  const values = ProductsService.fromCreate(dto, crypto.randomUUID());
  try {
    assertProductRules(values);
  } catch (e) {
    if (
      !(e instanceof AppException) ||
      typeof e.details !== 'object' ||
      e.details === null
    )
      throw e;
    for (const [k, msg] of Object.entries(e.details as Record<string, string>))
      add(FIELD_TO_COLUMN[k] ?? k, msg);
  }
  if (errors.length > 0) return { errors };
  return {
    errors,
    valid: {
      row: input.row,
      values,
      sku: values.sku,
      explicitSlug: values.slug ?? null,
      category: unescapeCell(input.category?.trim() ?? '') || undefined,
      subcategory: unescapeCell(input.subcategory?.trim() ?? '') || undefined,
    },
  };
}

export function findInFileDuplicates(rows: ValidRow[]): RowError[] {
  const errors: RowError[] = [];
  const skus = new Map<string, number>();
  const slugs = new Map<string, number>();
  for (const r of rows) {
    if (r.sku) {
      const first = skus.get(r.sku.toLowerCase());
      if (first === undefined) skus.set(r.sku.toLowerCase(), r.row);
      else
        errors.push({
          row: r.row,
          column: 'sku',
          message: `This SKU is already used on row ${first} of this file.`,
          value: preview(r.sku),
        });
    }
    if (r.explicitSlug) {
      const first = slugs.get(r.explicitSlug.toLowerCase());
      if (first === undefined) slugs.set(r.explicitSlug.toLowerCase(), r.row);
      else
        errors.push({
          row: r.row,
          column: 'slug',
          message: `This slug is already used on row ${first} of this file.`,
          value: preview(r.explicitSlug),
        });
    }
  }
  return errors;
}

export function findConflicts(
  rows: ValidRow[],
  existingSkus: Set<string>,
  existingSlugs: Set<string>,
): RowError[] {
  const errors: RowError[] = [];
  for (const r of rows) {
    if (r.sku && existingSkus.has(r.sku))
      errors.push({
        row: r.row,
        column: 'sku',
        message: 'This SKU is already used by another product.',
        value: preview(r.sku),
      });
    if (r.explicitSlug && existingSlugs.has(r.explicitSlug))
      errors.push({
        row: r.row,
        column: 'slug',
        message: 'This slug is already used by another product.',
        value: preview(r.explicitSlug),
      });
  }
  return errors;
}

function pick(
  value: string,
  pool: CategoryRef[],
): { hit?: CategoryRef; ambiguous: boolean } {
  const needle = value.trim();
  const lower = needle.toLowerCase();
  const hits = new Map<string, CategoryRef>();
  for (const c of pool)
    if (c.slug === needle || c.name.trim().toLowerCase() === lower)
      hits.set(c.id, c);
  return {
    hit: hits.size === 1 ? [...hits.values()][0] : undefined,
    ambiguous: hits.size > 1,
  };
}

export function resolveCategories(
  rows: { row: number; category?: string; subcategory?: string }[],
  cats: CategoryRef[],
): { errors: RowError[]; ids: Map<number, string | null> } {
  const errors: RowError[] = [];
  const ids = new Map<number, string | null>();
  const top = cats.filter((c) => c.parentId === null);
  for (const r of rows) {
    const err = (column: string, message: string, value: string) =>
      errors.push({ row: r.row, column, message, value: preview(value) });
    if (!r.category && !r.subcategory) {
      ids.set(r.row, null);
      continue;
    }
    if (!r.category) {
      err(
        'subcategory',
        'Enter the parent category as well, or clear this cell.',
        r.subcategory ?? '',
      );
      continue;
    }
    const parent = pick(r.category, top);
    if (parent.ambiguous) {
      err(
        'category',
        'This matches more than one category. Use its handle instead.',
        r.category,
      );
      continue;
    }
    if (!parent.hit) {
      err(
        'category',
        `Category "${r.category}" was not found. Categories are not created by import.`,
        r.category,
      );
      continue;
    }
    if (!r.subcategory) {
      ids.set(r.row, parent.hit.id);
      continue;
    }
    const child = pick(
      r.subcategory,
      cats.filter((c) => c.parentId === parent.hit!.id),
    );
    if (child.ambiguous) {
      err(
        'subcategory',
        'This matches more than one subcategory. Use its handle instead.',
        r.subcategory,
      );
      continue;
    }
    if (child.hit) {
      ids.set(r.row, child.hit.id);
      continue;
    }
    const elsewhere = pick(
      r.subcategory,
      cats.filter((c) => c.parentId !== null),
    );
    err(
      'subcategory',
      elsewhere.hit || elsewhere.ambiguous
        ? `"${r.subcategory}" is not a subcategory of "${parent.hit.name}".`
        : `Subcategory "${r.subcategory}" was not found.`,
      r.subcategory,
    );
  }
  return { errors, ids };
}

/** Sorted by row then column, one error per column per row, at most 500 returned, with the true total. */
export function capErrors(errors: RowError[]): {
  total: number;
  errors: RowError[];
} {
  const sorted = [...errors].sort(
    (a, b) => a.row - b.row || a.column.localeCompare(b.column),
  );
  const seen = new Set<string>();
  const unique = sorted.filter(
    (e) =>
      !seen.has(`${e.row}:${e.column}`) && seen.add(`${e.row}:${e.column}`),
  );
  return {
    total: unique.length,
    errors: unique
      .slice(0, IMPORT_MAX_ERRORS)
      .map((e) => ({ ...e, value: e.value.slice(0, VALUE_MAX) })),
  };
}

/** Same root `ProductsService.uniqueSlug` derives: padded so the 2-80 char DB check holds. */
export function slugRoot(name: string): string {
  const base = slugify(name);
  return base.length >= 2 ? base : `${base || 'product'}-item`;
}

const SLUG_MAX_SUFFIX = 999;
const slugAt = (root: string, n: number) => (n === 1 ? root : `${root}-${n}`);

/**
 * Generates slugs for rows without an explicit one, in file order, without touching the database per row.
 * Same sequence as uniqueSlug (root, root-2 ... root-999, then a timestamp); explicit slugs anywhere in the file are
 * reserved. `windows` is how many candidates per root were looked up; roots that ran out are returned in `short`.
 */
export function assignSlugs(
  rows: ValidRow[],
  taken: ReadonlySet<string>,
  windows: ReadonlyMap<string, number>,
): { slugs: Map<number, string>; short: Set<string> } {
  const used = new Set(taken);
  for (const r of rows) if (r.explicitSlug) used.add(r.explicitSlug);
  const slugs = new Map<number, string>();
  const short = new Set<string>();
  for (const r of rows) {
    if (r.explicitSlug) continue;
    const root = slugRoot(r.values.name);
    const limit = Math.min(windows.get(root) ?? 1, SLUG_MAX_SUFFIX);
    let n = 1;
    while (n <= limit && used.has(slugAt(root, n))) n++;
    if (n <= limit) {
      const slug = slugAt(root, n);
      used.add(slug);
      slugs.set(r.row, slug);
    } else if (limit < SLUG_MAX_SUFFIX) {
      short.add(root);
    } else {
      slugs.set(r.row, `${root}-${Date.now()}`);
    }
  }
  return { slugs, short };
}

/** Candidate slugs to look up for each root, given its window. */
export function slugCandidates(windows: ReadonlyMap<string, number>): string[] {
  const out: string[] = [];
  for (const [root, w] of windows)
    for (let n = 1; n <= Math.min(w, SLUG_MAX_SUFFIX); n++)
      out.push(slugAt(root, n));
  return out;
}

/** Initial windows: as many candidates as rows sharing the root. */
export function initialSlugWindows(rows: ValidRow[]): Map<string, number> {
  const w = new Map<string, number>();
  for (const r of rows) {
    if (r.explicitSlug) continue;
    const root = slugRoot(r.values.name);
    w.set(root, (w.get(root) ?? 0) + 1);
  }
  return w;
}
