import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Studio foundation tables (migrations 0037, 0038, 0039, 0040).
 * Check constraints, composite foreign keys, RLS, append-only triggers and privileged functions live in the SQL migrations.
 */

export const LEGAL_WORDING_STATUSES = ['draft', 'approved', 'retired'] as const;
export type LegalWordingStatus = (typeof LEGAL_WORDING_STATUSES)[number];
export const ATTESTATION_TYPES = ['badge_upload', 'review_import'] as const;
export type AttestationType = (typeof ATTESTATION_TYPES)[number];
export const MEDIA_KINDS = ['badge_image'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** No row = Studio disabled for the store. */
export const storeStudioRollout = pgTable(
  'store_studio_rollout',
  {
    storeId: uuid('store_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    enabledAt: timestamp('enabled_at', { withTimezone: true }),
    enabledBy: uuid('enabled_by'),
    pointOfNoReturnAt: timestamp('point_of_no_return_at', {
      withTimezone: true,
    }),
    pointOfNoReturnReason: text('point_of_no_return_reason'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('store_studio_rollout_tenant_idx').on(t.tenantId)],
).enableRLS();

/** Append-only. `actorId` is deliberately not a foreign key. */
export const storeStudioRolloutEvents = pgTable(
  'store_studio_rollout_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    action: text('action').notNull(),
    reason: text('reason').notNull(),
    previous: jsonb('previous').$type<Record<string, unknown> | null>(),
    new: jsonb('new').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('store_studio_rollout_events_store_idx').on(
      t.tenantId,
      t.storeId,
      t.createdAt.desc(),
    ),
  ],
).enableRLS();

/** Platform-wide wording. Approved rows are immutable (retire only). */
export const legalWordings = pgTable('legal_wordings', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull(),
  version: integer('version').notNull(),
  languageTag: text('language_tag').notNull(),
  text: text('text').notNull(),
  status: text('status', { enum: LEGAL_WORDING_STATUSES })
    .notNull()
    .default('draft'),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}).enableRLS();

/** Append-only legal approval of a feature against an approved wording version. Never seeded by migrations. */
export const featureApprovals = pgTable(
  'feature_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    featureKey: text('feature_key').notNull(),
    wordingKey: text('wording_key').notNull(),
    wordingVersion: integer('wording_version').notNull(),
    approverRef: text('approver_ref').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull(),
    release: text('release').notNull(),
    recordedBy: uuid('recorded_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('feature_approvals_feature_idx').on(
      t.featureKey,
      t.approvedAt.desc(),
    ),
  ],
).enableRLS();

/** Append-only. `userId`, `assetId` and `importId` are not foreign keys: the record outlives them. */
export const attestations = pgTable(
  'attestations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    userId: uuid('user_id').notNull(),
    type: text('type', { enum: ATTESTATION_TYPES }).notNull(),
    wordingId: uuid('wording_id').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    assetId: uuid('asset_id'),
    importId: uuid('import_id'),
    context: jsonb('context')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (t) => [
    index('attestations_store_idx').on(
      t.tenantId,
      t.storeId,
      t.acceptedAt.desc(),
    ),
    index('attestations_wording_idx').on(t.wordingId),
  ],
).enableRLS();

/** Studio media: a direct child of `{tenant_id}/` in the products bucket. JPEG, PNG and WebP only. */
export const mediaAssets = pgTable(
  'media_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    ownerUserId: uuid('owner_user_id').notNull(),
    kind: text('kind', { enum: MEDIA_KINDS }).notNull(),
    storagePath: text('storage_path').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    altText: text('alt_text'),
    attestationId: uuid('attestation_id'),
    /** Null until the upload was verified in Storage. */
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('media_assets_store_idx').on(
      t.tenantId,
      t.storeId,
      t.createdAt.desc(),
    ),
  ],
).enableRLS();

/** Append-only publish history, written inside the publish transaction (by the readiness task). */
export const studioPublishes = pgTable(
  'studio_publishes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    publishedBy: uuid('published_by').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    items: jsonb('items').$type<unknown[]>().notNull().default([]),
    warningAcknowledgements: jsonb('warning_acknowledgements')
      .$type<unknown[]>()
      .notNull()
      .default([]),
    readinessSummary: jsonb('readiness_summary')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    fingerprint: text('fingerprint'),
    studioSchemaVersion: integer('studio_schema_version').notNull(),
  },
  (t) => [
    index('studio_publishes_store_idx').on(
      t.tenantId,
      t.storeId,
      t.publishedAt.desc(),
    ),
  ],
).enableRLS();

/* ==================================================================================================
 * RELEASE 2 TABLES (Reviews, Recommendations, Cart Drawer Slot, Web Vitals, Studio Settings)
 * ================================================================================================== */

export const REVIEW_STATUSES = ['published', 'unpublished'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const REVIEW_SOURCES = ['merchant_entered', 'imported'] as const;
export type ReviewSource = (typeof REVIEW_SOURCES)[number];
export const RECOMMENDATION_RELATIONS = ['cross_sell', 'upsell', 'related'] as const;
export type RecommendationRelation = (typeof RECOMMENDATION_RELATIONS)[number];

export const storeStudioSettings = pgTable(
  'store_studio_settings',
  {
    storeId: uuid('store_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    reviewDisclosureText: text('review_disclosure_text').notNull().default('Feedback collected by the store.'),
    reviewDisclosureLanguage: text('review_disclosure_language').notNull().default('en'),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('store_studio_settings_tenant_idx').on(t.tenantId)],
).enableRLS();

export const productReviews = pgTable(
  'product_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    productId: uuid('product_id').notNull(),
    authorName: text('author_name').notNull(),
    rating: integer('rating').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().defaultNow(),
    status: text('status', { enum: REVIEW_STATUSES }).notNull().default('published'),
    source: text('source', { enum: REVIEW_SOURCES }).notNull().default('merchant_entered'),
    originLabel: text('origin_label'),
    verifiedPurchase: boolean('verified_purchase').notNull().default(false),
    importId: uuid('import_id'),
    createdBy: uuid('created_by').notNull(),
    updatedBy: uuid('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('product_reviews_product_status_idx').on(t.tenantId, t.productId, t.status, t.reviewedAt.desc()),
    index('product_reviews_store_idx').on(t.tenantId, t.storeId, t.reviewedAt.desc()),
  ],
).enableRLS();

export type ProductReview = typeof productReviews.$inferSelect;

export const reviewImports = pgTable(
  'review_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    userId: uuid('user_id').notNull(),
    fileName: text('file_name').notNull(),
    rowsTotal: integer('rows_total').notNull(),
    rowsImported: integer('rows_imported').notNull(),
    status: text('status', { enum: ['success', 'partial', 'failed'] }).notNull(),
    attestationId: uuid('attestation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('review_imports_store_idx').on(t.tenantId, t.storeId)],
).enableRLS();

export const productRecommendations = pgTable(
  'product_recommendations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    productId: uuid('product_id').notNull(),
    recommendedProductId: uuid('recommended_product_id').notNull(),
    relationKind: text('relation_kind', { enum: RECOMMENDATION_RELATIONS }).notNull().default('cross_sell'),
    position: integer('position').notNull().default(0),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('product_recommendations_product_idx').on(t.tenantId, t.productId, t.position),
  ],
).enableRLS();

export const webVitalsDaily = pgTable(
  'web_vitals_daily',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull(),
    publishId: uuid('publish_id'),
    routeKind: text('route_kind').notNull(),
    deviceClass: text('device_class').notNull(),
    metric: text('metric').notNull(),
    day: date('day').notNull(),
    bucketCounts: jsonb('bucket_counts').$type<Record<string, number>>().notNull().default({}),
    sampleCount: integer('sample_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('web_vitals_store_day_idx').on(t.storeId, t.day),
  ],
).enableRLS();

/* ==================================================================================================
 * RELEASE 3 TABLES (Reusable sections, Review workflow, Change ledger, Discard audit)
 * ================================================================================================== */

export const reusableSections = pgTable(
  'reusable_sections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    componentId: text('component_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    currentVersionId: uuid('current_version_id'),
    status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('reusable_sections_store_idx').on(t.tenantId, t.storeId, t.status)],
).enableRLS();

export const reusableSectionVersions = pgTable(
  'reusable_section_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reusableId: uuid('reusable_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('reusable_versions_reusable_idx').on(t.reusableId, t.versionNumber)],
).enableRLS();

export const draftReviewRequests = pgTable(
  'draft_review_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    items: jsonb('items').$type<unknown[]>().notNull(),
    submittedBy: uuid('submitted_by').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    clearedReason: text('cleared_reason'),
  },
  (t) => [index('draft_review_requests_store_idx').on(t.tenantId, t.storeId)],
).enableRLS();

export const changeLedger = pgTable(
  'change_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    editorId: uuid('editor_id').notNull(),
    documentType: text('document_type').notNull(),
    documentId: text('document_id').notNull(),
    nodeId: text('node_id').notNull(),
    changeKind: text('change_kind').notNull(),
    beforeHash: text('before_hash'),
    afterHash: text('after_hash').notNull(),
    draftRevision: integer('draft_revision').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [index('change_ledger_node_idx').on(t.tenantId, t.storeId, t.documentType, t.documentId, t.nodeId)],
).enableRLS();

export const draftDiscardAudit = pgTable(
  'draft_discard_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    actingUserId: uuid('acting_user_id').notNull(),
    affectedUserId: uuid('affected_user_id').notNull(),
    documentType: text('document_type').notNull(),
    documentId: text('document_id').notNull(),
    nodeId: text('node_id').notNull(),
    discardedRevisions: integer('discarded_revisions').array().notNull(),
    reason: text('reason').notNull(),
    beforeHash: text('before_hash'),
    afterHash: text('after_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('draft_discard_audit_store_idx').on(t.tenantId, t.storeId, t.createdAt.desc())],
).enableRLS();
