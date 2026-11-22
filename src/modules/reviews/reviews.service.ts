import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AppException, invalid, notFound } from '../../common/app.exception.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { DatabaseService } from '../../database/database.service.js';
import {
  attestations,
  productReviews,
  products,
  reviewImports,
  stores,
  type ProductReview,
} from '../../database/schema/index.js';
import { requireStore } from '../themes/themes.shared.js';
import type {
  CreateReviewDto,
  ReviewFilterQueryDto,
  ReviewImportRequestDto,
  ReviewImportResponseDto,
  ReviewImportRowErrorDto,
  UpdateReviewDto,
} from './reviews.dto.js';

/** Formula injection characters in CSV. Neutralized by prepending a single quote. */
const FORMULA_START = /^[=+\-@]/;

export function sanitizeCsvCell(value: string): string {
  const trimmed = value.trim();
  if (FORMULA_START.test(trimmed)) {
    return `'${trimmed}`;
  }
  return trimmed;
}

@Injectable()
export class ReviewsService {
  constructor(private readonly db: DatabaseService) {}

  async list(org: OrgContext, query: ReviewFilterQueryDto) {
    return this.db.withUser(org.userId, async (tx) => {
      const store = await requireStore(tx, org);
      const conditions = [
        eq(productReviews.tenantId, org.tenantId),
        eq(productReviews.storeId, store.id),
      ];

      if (query.productId) {
        conditions.push(eq(productReviews.productId, query.productId));
      }
      if (query.status) {
        conditions.push(eq(productReviews.status, query.status));
      }
      if (query.source) {
        conditions.push(eq(productReviews.source, query.source));
      }

      const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
      const offset = Math.max(query.offset ?? 0, 0);

      let orderBy = desc(productReviews.reviewedAt);
      if (query.sort === 'oldest') {
        orderBy = sql`${productReviews.reviewedAt} ASC`;
      } else if (query.sort === 'rating_desc') {
        orderBy = desc(productReviews.rating);
      } else if (query.sort === 'rating_asc') {
        orderBy = sql`${productReviews.rating} ASC`;
      }

      const rows = await tx
        .select()
        .from(productReviews)
        .where(and(...conditions))
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset);

      const totalResult = await tx
        .select({ count: sql<number>`count(*)` })
        .from(productReviews)
        .where(and(...conditions));

      const total = Number(totalResult[0]?.count ?? 0);

      return {
        items: rows,
        total,
        limit,
        offset,
      };
    });
  }

  async create(org: OrgContext, dto: CreateReviewDto) {
    return this.db.withUser(org.userId, async (tx) => {
      const store = await requireStore(tx, org);
      // Composite check: product must belong to current tenant (AC-REV-02)
      const p = await tx
        .select({ id: products.id })
        .from(products)
        .where(
          and(
            eq(products.tenantId, org.tenantId),
            eq(products.id, dto.productId),
          ),
        )
        .limit(1);

      if (!p.length) {
        throw notFound('Product not found.');
      }

      const [review] = await tx
        .insert(productReviews)
        .values({
          tenantId: org.tenantId,
          storeId: store.id,
          productId: dto.productId,
          authorName: sanitizeCsvCell(dto.authorName),
          rating: dto.rating,
          title: sanitizeCsvCell(dto.title),
          body: sanitizeCsvCell(dto.body),
          originLabel: dto.originLabel
            ? sanitizeCsvCell(dto.originLabel)
            : null,
          status: dto.status ?? 'published',
          source: 'merchant_entered',
          verifiedPurchase: false,
          createdBy: org.userId,
        })
        .returning();

      return review;
    });
  }

  async update(org: OrgContext, id: string, dto: UpdateReviewDto) {
    return this.db.withUser(org.userId, async (tx) => {
      const store = await requireStore(tx, org);
      const existing = await tx
        .select()
        .from(productReviews)
        .where(
          and(
            eq(productReviews.id, id),
            eq(productReviews.tenantId, org.tenantId),
            eq(productReviews.storeId, store.id),
          ),
        )
        .limit(1);

      if (!existing.length) {
        throw notFound('Review not found.');
      }

      const updates: Record<string, unknown> = {
        updatedBy: org.userId,
        updatedAt: new Date(),
      };

      if (dto.authorName !== undefined)
        updates.authorName = sanitizeCsvCell(dto.authorName);
      if (dto.rating !== undefined) updates.rating = dto.rating;
      if (dto.title !== undefined) updates.title = sanitizeCsvCell(dto.title);
      if (dto.body !== undefined) updates.body = sanitizeCsvCell(dto.body);
      if (dto.originLabel !== undefined)
        updates.originLabel = dto.originLabel
          ? sanitizeCsvCell(dto.originLabel)
          : null;
      if (dto.status !== undefined) updates.status = dto.status;

      const [updated] = await tx
        .update(productReviews)
        .set(updates)
        .where(eq(productReviews.id, id))
        .returning();

      return updated;
    });
  }

  async delete(org: OrgContext, id: string) {
    return this.db.withUser(org.userId, async (tx) => {
      const store = await requireStore(tx, org);
      const existing = await tx
        .select({ id: productReviews.id })
        .from(productReviews)
        .where(
          and(
            eq(productReviews.id, id),
            eq(productReviews.tenantId, org.tenantId),
            eq(productReviews.storeId, store.id),
          ),
        )
        .limit(1);

      if (!existing.length) {
        throw notFound('Review not found.');
      }

      await tx.delete(productReviews).where(eq(productReviews.id, id));
      return { success: true };
    });
  }

  async setStatus(
    org: OrgContext,
    id: string,
    status: 'published' | 'unpublished',
  ) {
    return this.update(org, id, { status });
  }

  getImportTemplate(): string {
    return 'author_name,rating,title,body,product_id,product_slug,origin_label\n"Jane Doe",5,"Excellent product!","Really enjoyed this item.",,"sample-product","Website"\n';
  }

  async importReviews(
    org: OrgContext,
    dto: ReviewImportRequestDto,
  ): Promise<ReviewImportResponseDto> {
    return this.db.withUser(org.userId, async (tx) => {
      const store = await requireStore(tx, org);
      // 1. Verify attestation if real import (validateOnly is false)
      if (!dto.validateOnly) {
        if (!dto.attestationId) {
          throw invalid(
            'Attestation is required before importing reviews.',
            {
              attestationId:
                'An attestation by an authorized user must be recorded.',
            },
            'ATTESTATION_REQUIRED',
          );
        }

        const att = await tx
          .select()
          .from(attestations)
          .where(
            and(
              eq(attestations.id, dto.attestationId),
              eq(attestations.tenantId, org.tenantId),
              eq(attestations.storeId, store.id),
            ),
          )
          .limit(1);

        if (!att.length) {
          throw invalid(
            'Attestation not found or does not belong to this store.',
            { attestationId: 'Unknown attestation.' },
            'ATTESTATION_INVALID',
          );
        }
      }

      // 2. Fetch all products of tenant for lookup
      const tenantProducts = await tx
        .select({ id: products.id, slug: products.slug })
        .from(products)
        .where(eq(products.tenantId, org.tenantId));

      const productById = new Map<string, string>();
      const productBySlug = new Map<string, string>();
      for (const p of tenantProducts) {
        productById.set(p.id, p.id);
        productBySlug.set(p.slug.toLowerCase(), p.id);
      }

      // 3. Parse CSV rows
      const lines = dto.csvContent
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      if (lines.length <= 1) {
        return {
          valid: false,
          errors: [
            {
              row: 1,
              column: 'csv',
              reason: 'CSV must contain a header and at least one data row.',
            },
          ],
          totalRows: 0,
        };
      }

      const headerLine = lines[0];
      const headers = headerLine.split(',').map((h) =>
        h
          .replace(/^["']|["']$/g, '')
          .trim()
          .toLowerCase(),
      );

      const authorIdx = headers.indexOf('author_name');
      const ratingIdx = headers.indexOf('rating');
      const titleIdx = headers.indexOf('title');
      const bodyIdx = headers.indexOf('body');
      const productIdIdx = headers.indexOf('product_id');
      const productSlugIdx = headers.indexOf('product_slug');
      const originIdx = headers.indexOf('origin_label');

      if (
        authorIdx === -1 ||
        ratingIdx === -1 ||
        titleIdx === -1 ||
        bodyIdx === -1
      ) {
        return {
          valid: false,
          errors: [
            {
              row: 1,
              column: 'header',
              reason:
                'CSV header must include author_name, rating, title, body, and either product_id or product_slug.',
            },
          ],
          totalRows: lines.length - 1,
        };
      }

      const errors: ReviewImportRowErrorDto[] = [];
      type ParsedRow = {
        rowNum: number;
        productId: string;
        authorName: string;
        rating: number;
        title: string;
        body: string;
        originLabel: string | null;
      };
      const parsedRows: ParsedRow[] = [];

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        const rowNum = i + 1;
        // Simple CSV splitter respecting quotes
        const cols: string[] = [];
        let inQuotes = false;
        let cur = '';
        for (let c = 0; c < line.length; c++) {
          const ch = line[c];
          if (ch === '"') {
            inQuotes = !inQuotes;
          } else if (ch === ',' && !inQuotes) {
            cols.push(cur.replace(/^["']|["']$/g, '').trim());
            cur = '';
          } else {
            cur += ch;
          }
        }
        cols.push(cur.replace(/^["']|["']$/g, '').trim());

        const author = cols[authorIdx] ?? '';
        const ratingStr = cols[ratingIdx] ?? '';
        const title = cols[titleIdx] ?? '';
        const body = cols[bodyIdx] ?? '';
        const prodId = productIdIdx >= 0 ? cols[productIdIdx] : '';
        const prodSlug = productSlugIdx >= 0 ? cols[productSlugIdx] : '';
        const origin = originIdx >= 0 ? cols[originIdx] : null;

        if (!author || author.length > 80) {
          errors.push({
            row: rowNum,
            column: 'author_name',
            reason: 'Author name must be between 1 and 80 characters.',
          });
        }

        const ratingNum = parseInt(ratingStr, 10);
        if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
          errors.push({
            row: rowNum,
            column: 'rating',
            reason:
              'Rating must be an integer between 1 and 5 (0 and 6 are rejected).',
          });
        }

        if (!title || title.length > 120) {
          errors.push({
            row: rowNum,
            column: 'title',
            reason: 'Title must be between 1 and 120 characters.',
          });
        }

        if (!body || body.length > 5000) {
          errors.push({
            row: rowNum,
            column: 'body',
            reason: 'Body must be between 1 and 5000 characters.',
          });
        }

        // Product resolution
        let resolvedProductId: string | undefined;
        if (prodId && productById.has(prodId)) {
          resolvedProductId = productById.get(prodId);
        } else if (prodSlug && productBySlug.has(prodSlug.toLowerCase())) {
          resolvedProductId = productBySlug.get(prodSlug.toLowerCase());
        }

        if (!resolvedProductId) {
          errors.push({
            row: rowNum,
            column: 'product',
            reason:
              'Specified product_id or product_slug does not exist in this store.',
          });
        }

        if (origin && origin.length > 60) {
          errors.push({
            row: rowNum,
            column: 'origin_label',
            reason: 'Origin label cannot exceed 60 characters.',
          });
        }

        if (resolvedProductId) {
          parsedRows.push({
            rowNum,
            productId: resolvedProductId,
            authorName: sanitizeCsvCell(author),
            rating: ratingNum,
            title: sanitizeCsvCell(title),
            body: sanitizeCsvCell(body),
            originLabel: origin ? sanitizeCsvCell(origin) : null,
          });
        }
      }

      if (errors.length > 0 || dto.validateOnly) {
        return {
          valid: errors.length === 0,
          errors,
          totalRows: lines.length - 1,
          importedRows: 0,
        };
      }

      // 4. Real import: insert all-or-nothing
      const [importRecord] = await tx
        .insert(reviewImports)
        .values({
          tenantId: org.tenantId,
          storeId: store.id,
          userId: org.userId,
          fileName: 'reviews-import.csv',
          rowsTotal: lines.length - 1,
          rowsImported: parsedRows.length,
          status: 'success',
          attestationId: dto.attestationId!,
        })
        .returning();

      for (const row of parsedRows) {
        await tx.insert(productReviews).values({
          tenantId: org.tenantId,
          storeId: store.id,
          productId: row.productId,
          authorName: row.authorName,
          rating: row.rating,
          title: row.title,
          body: row.body,
          originLabel: row.originLabel,
          status: 'published',
          source: 'imported',
          verifiedPurchase: false,
          importId: importRecord.id,
          createdBy: org.userId,
        });
      }

      return {
        valid: true,
        errors: [],
        totalRows: lines.length - 1,
        importedRows: parsedRows.length,
        importId: importRecord.id,
      };
    });
  }
}
