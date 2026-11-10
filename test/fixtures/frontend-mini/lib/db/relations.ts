import { relations } from 'drizzle-orm';
import { stores } from './schema';

export const storesRelations = relations(stores, () => ({}));
