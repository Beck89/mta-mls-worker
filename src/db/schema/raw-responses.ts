import { pgTable, varchar, jsonb, timestamp } from 'drizzle-orm/pg-core';

export const rawResponses = pgTable('raw_responses', {
  listingKey: varchar('listing_key').primaryKey(), // one-to-one with properties
  rawData: jsonb('raw_data').notNull(), // property-level fields only, no expanded sub-resources
  originatingSystem: varchar('originating_system').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow(),
});

export type RawResponse = typeof rawResponses.$inferSelect;
export type NewRawResponse = typeof rawResponses.$inferInsert;
