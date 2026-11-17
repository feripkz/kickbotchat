import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
export const preferences = pgTable('preferences', {
  id: text('id').primaryKey(),
  settings: jsonb('settings').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
