import {
  pgTable,
  varchar,
  integer,
  bigint,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { properties } from './properties';

export const media = pgTable(
  'media',
  {
    mediaKey: varchar('media_key').primaryKey(),
    listingKey: varchar('listing_key')
      .notNull()
      .references(() => properties.listingKey, { onDelete: 'cascade' }),
    resourceType: varchar('resource_type').notNull(), // 'Property', 'Member', 'Office'
    mediaUrlSource: varchar('media_url_source'), // original MLS Grid URL (download reference only)
    r2ObjectKey: varchar('r2_object_key').notNull(),
    publicUrl: varchar('public_url'), // publicly-served URL via custom domain (e.g., https://mls-media.movingtoaustin.com/...)
    mediaModTs: timestamp('media_mod_ts', { withTimezone: true }),
    mediaOrder: integer('media_order'),
    mediaCategory: varchar('media_category'),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }),
    contentType: varchar('content_type'),
    status: varchar('status').notNull().default('pending_download'), // 'pending_download', 'complete', 'failed'
    retryCount: integer('retry_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_media_listing_order').on(table.listingKey, table.mediaOrder),
    index('idx_media_resource_type').on(table.resourceType),
    index('idx_media_status').on(table.status),
  ],
);

export type Media = typeof media.$inferSelect;
export type NewMedia = typeof media.$inferInsert;
