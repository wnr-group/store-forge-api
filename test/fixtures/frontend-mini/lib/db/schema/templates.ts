import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { TEMPLATE_KINDS, type TemplateDocument } from '@/lib/templates/document';
import { LIMITS } from '@/lib/templates/limits';
import { stores } from './stores';

export const templates = pgTable('templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull().references(() => stores.id),
  kind: text('kind', { enum: TEMPLATE_KINDS }).notNull(),
});

