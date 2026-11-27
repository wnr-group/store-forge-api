import { unescapeCell } from '../../common/utils/spreadsheet.js';
import {
  parseBoolean,
  type RowError,
} from '../products/product-import.rules.js';
import type {
  CatalogImportLevelDto,
  CatalogImportRowDto,
} from './catalog-import.dto.js';
import { MAX_LEVELS, SLUG_PATTERN } from './catalog-hierarchy.rules.js';

/**
 * The pure part of the catalog import (no database): reading the rows of the file into a checked form, reconciling the
 * levels of the file with the levels that exist, and finding contradictions inside the file.
 *
 * File format (one row per catalog item, optionally with one product to place on it):
 *   level_1 ... level_N   names of the items from the top level down; the row is about the item of the LAST filled cell
 *   status, description, position   optional, for that item
 *   product_id | product_sku | product_slug, product_position   optional: place this product on that item
 *   part_number, product_name   information only (from the export); never used to find a product
 * An item is identified by its parent and its name (capitalisation and extra spaces do not matter), so importing the same
 * file twice changes nothing.
 */

export const ITEM_NAME_MAX = 120;
export const LEVEL_NAME_MAX = 60;
const POSITION_MAX = 1_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALUE_MAX = 100;

const asText = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : '';
const preview = (v: unknown) => asText(v).slice(0, VALUE_MAX);

/** The text of a cell: trimmed, a leading formula-guard apostrophe removed. Empty cells are `undefined`. */
export function cellOf(v: unknown): string | undefined {
  const t = unescapeCell(asText(v).trim()).trim();
  return t === '' ? undefined : t;
}

/** Display form of a name: trimmed, inner whitespace collapsed. */
export const normName = (s: string) => s.trim().replace(/\s+/g, ' ');
/** Identity of a name inside one parent: capitalisation and spacing do not matter. */
export const nameKey = (s: string) => normName(s).toLowerCase();

export const PATH_SEPARATOR = '␟';
export const pathKey = (keys: readonly string[]) => keys.join(PATH_SEPARATOR);

export const STATUSES = ['draft', 'active'] as const;
export type ItemStatus = (typeof STATUSES)[number];

export interface ParsedLevel {
  row: number;
  name: string;
  canHold?: boolean;
}

export interface ParsedRow {
  row: number;
  /** Display names from the top level down to the item this row is about. */
  names: string[];
  /** The same names as identity keys. */
  keys: string[];
  depth: number;
  status?: ItemStatus;
  description?: string;
  position?: number;
  product: { id?: string; sku?: string; slug?: string } | null;
  productPosition?: number;
}

const rowErrors = (input: { row: number }, raw: Record<string, unknown>) => {
  const errors: RowError[] = [];
  const add = (column: string, message: string) =>
    errors.push({
      row: input.row,
      column,
      message,
      value: preview(raw[column]),
    });
  return { errors, add };
};

// ---------------------------------------------------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------------------------------------------------

export function parseLevels(levels: CatalogImportLevelDto[] | undefined): {
  levels: ParsedLevel[];
  errors: RowError[];
} {
  const out: ParsedLevel[] = [];
  const errors: RowError[] = [];
  const seen = new Map<string, number>();
  for (const input of levels ?? []) {
    const raw = input as unknown as Record<string, unknown>;
    const { errors: e, add } = rowErrors(input, raw);
    const name = cellOf(input.name);
    if (!name) add('name', 'The level needs a name.');
    else if (normName(name).length > LEVEL_NAME_MAX)
      add(
        'name',
        `A level name can have at most ${LEVEL_NAME_MAX} characters.`,
      );
    else {
      const first = seen.get(nameKey(name));
      if (first !== undefined)
        add('name', `This level name is already used on row ${first}.`);
      else seen.set(nameKey(name), input.row);
    }
    let canHold: boolean | undefined;
    const flag = cellOf(input.can_hold_products);
    if (flag !== undefined) {
      const b = parseBoolean(flag);
      if (b === 'invalid')
        add('can_hold_products', 'Use true, false, yes, no, 1 or 0.');
      else canHold = b;
    }
    errors.push(...e);
    if (e.length === 0)
      out.push({ row: input.row, name: normName(name!), canHold });
  }
  if ((levels?.length ?? 0) > MAX_LEVELS)
    errors.push({
      row: 0,
      column: 'levels',
      message: `A catalog can have at most ${MAX_LEVELS} levels.`,
      value: String(levels?.length),
    });
  return { levels: out, errors };
}

export interface ExistingLevel {
  id: string;
  name: string;
  position: number;
  canHoldProducts: boolean;
}
export interface FinalLevel {
  /** null for a level the import will create. */
  id: string | null;
  name: string;
  position: number;
  canHoldProducts: boolean;
}

/**
 * The levels of the file against the levels that exist. An import never renames, reorders or deletes a level: the first
 * levels of the file must be the existing levels (same names, same order), and any further levels are appended.
 * Leaving the `levels` section out keeps the existing levels.
 */
export function reconcileLevels(
  existing: readonly ExistingLevel[],
  wanted: readonly ParsedLevel[],
): {
  final: FinalLevel[];
  create: { name: string; position: number; canHoldProducts: boolean }[];
  update: { id: string; canHoldProducts: boolean }[];
  errors: RowError[];
} {
  const errors: RowError[] = [];
  const final: FinalLevel[] = existing.map((l) => ({ ...l }));
  const create: { name: string; position: number; canHoldProducts: boolean }[] =
    [];
  const update: { id: string; canHoldProducts: boolean }[] = [];
  wanted.forEach((w, i) => {
    const have = existing[i];
    if (have) {
      if (nameKey(have.name) !== nameKey(w.name)) {
        errors.push({
          row: w.row,
          column: 'name',
          message: `Level ${i + 1} of your catalog is called "${have.name}". An import does not rename or reorder levels: change them in the catalog settings first.`,
          value: w.name.slice(0, VALUE_MAX),
        });
        return;
      }
      if (w.canHold !== undefined && w.canHold !== have.canHoldProducts) {
        update.push({ id: have.id, canHoldProducts: w.canHold });
        final[i] = { ...final[i], canHoldProducts: w.canHold };
      }
      return;
    }
    const level = {
      name: w.name,
      position: i + 1,
      canHoldProducts: w.canHold ?? false,
    };
    create.push(level);
    final.push({ id: null, ...level });
  });
  if (final.length > MAX_LEVELS)
    errors.push({
      row: 0,
      column: 'levels',
      message: `A catalog can have at most ${MAX_LEVELS} levels.`,
      value: String(final.length),
    });
  return { final, create, update, errors };
}

// ---------------------------------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------------------------------

const levelColumn = (n: number) => `level_${n}`;

export function parseRow(input: CatalogImportRowDto): {
  errors: RowError[];
  parsed?: ParsedRow;
} {
  const raw = input as unknown as Record<string, unknown>;
  const { errors, add } = rowErrors(input, raw);
  for (const s of input.source_errors ?? []) add(s.column, s.message);

  const cells: (string | undefined)[] = [];
  for (let n = 1; n <= MAX_LEVELS; n++) cells.push(cellOf(raw[levelColumn(n)]));
  const depth = cells.reduce<number>(
    (d, c, i) => (c !== undefined ? i + 1 : d),
    0,
  );
  if (depth === 0)
    add('level_1', 'Fill in at least level_1: the name of the item.');
  for (let i = 0; i < depth; i++) {
    if (cells[i] === undefined)
      add(
        levelColumn(i + 1),
        `${levelColumn(i + 1)} is empty but ${levelColumn(depth)} is filled. Fill the levels from level_1 down without gaps.`,
      );
    else if (normName(cells[i]!).length > ITEM_NAME_MAX)
      add(
        levelColumn(i + 1),
        `A name can have at most ${ITEM_NAME_MAX} characters.`,
      );
  }

  let status: ItemStatus | undefined;
  const statusText = cellOf(input.status);
  if (statusText !== undefined) {
    const s = statusText.toLowerCase();
    if ((STATUSES as readonly string[]).includes(s)) status = s as ItemStatus;
    else add('status', 'Use draft or active.');
  }

  // An empty cell means "not given": the import never clears a description.
  const description = cellOf(input.description);

  const wholeNumber = (column: string, value: unknown): number | undefined => {
    const t = cellOf(value);
    if (t === undefined) return undefined;
    if (!/^\d{1,7}$/.test(t) || Number(t) > POSITION_MAX) {
      add(column, `Use a whole number from 0 to ${POSITION_MAX}.`);
      return undefined;
    }
    return Number(t);
  };
  const position = wholeNumber('position', input.position);
  const productPosition = wholeNumber(
    'product_position',
    input.product_position,
  );

  const id = cellOf(input.product_id);
  const sku = cellOf(input.product_sku);
  const slugText = cellOf(input.product_slug);
  if (id !== undefined && !UUID.test(id))
    add('product_id', 'This is not a product id.');
  if (sku !== undefined && sku.length > 64)
    add('product_sku', 'A SKU has at most 64 characters.');
  const slug = slugText?.toLowerCase();
  if (slug !== undefined && (slug.length > 200 || !SLUG_PATTERN.test(slug)))
    add('product_slug', 'This is not a product slug.');
  const hasRef = id !== undefined || sku !== undefined || slug !== undefined;
  if (
    !hasRef &&
    (cellOf(input.part_number) !== undefined ||
      cellOf(input.product_name) !== undefined)
  )
    add(
      'product_sku',
      'A part number or a name does not identify a product (they are not unique). Give product_sku, product_slug or product_id.',
    );
  if (!hasRef && productPosition !== undefined)
    add('product_position', 'There is no product on this row to put in order.');

  if (errors.length > 0) return { errors };
  const names = cells.slice(0, depth).map((c) => normName(c!));
  return {
    errors,
    parsed: {
      row: input.row,
      names,
      keys: names.map(nameKey),
      depth,
      status,
      description,
      position,
      product: hasRef
        ? {
            ...(id !== undefined ? { id: id.toLowerCase() } : {}),
            ...(sku !== undefined ? { sku } : {}),
            ...(slug !== undefined ? { slug } : {}),
          }
        : null,
      productPosition,
    },
  };
}

/** What the rows say about one item, merged. The first row that says something about an attribute wins; a different value later is an error. */
export interface ItemAttributes {
  status?: ItemStatus;
  description?: string;
  position?: number;
}

export function mergeAttributes(parsed: readonly ParsedRow[]): {
  attributes: Map<string, ItemAttributes>;
  errors: RowError[];
} {
  const attributes = new Map<string, ItemAttributes>();
  const source = new Map<string, Record<string, number>>();
  const errors: RowError[] = [];
  for (const r of parsed) {
    const key = pathKey(r.keys);
    const have = attributes.get(key) ?? {};
    const rows = source.get(key) ?? {};
    for (const attr of ['status', 'description', 'position'] as const) {
      const value = r[attr];
      if (value === undefined) continue;
      if (have[attr] === undefined) {
        (have as Record<string, unknown>)[attr] = value;
        rows[attr] = r.row;
      } else if (have[attr] !== value)
        errors.push({
          row: r.row,
          column: attr,
          message: `This item is also on row ${rows[attr]} with a different ${attr}.`,
          value: String(value ?? '').slice(0, VALUE_MAX),
        });
    }
    attributes.set(key, have);
    source.set(key, rows);
  }
  return { attributes, errors };
}

export const emptySummary = () => ({
  hierarchyCreated: false,
  levelsCreated: 0,
  levelsUpdated: 0,
  nodesCreated: 0,
  nodesUpdated: 0,
  nodesUnchanged: 0,
  assignmentsCreated: 0,
  assignmentsExisting: 0,
});
