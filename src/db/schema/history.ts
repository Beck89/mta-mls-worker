import {
  pgTable,
  varchar,
  numeric,
  text,
  timestamp,
  bigserial,
  index,
} from 'drizzle-orm/pg-core';

// ─── Price History ───────────────────────────────────────────────────────────

export const priceHistory = pgTable(
  'price_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    listingKey: varchar('listing_key').notNull(),
    oldPrice: numeric('old_price'),
    newPrice: numeric('new_price').notNull(),
    changeType: varchar('change_type'), // "Price Increase", "Price Decrease"
    modificationTs: timestamp('modification_ts', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_price_history_listing').on(table.listingKey),
    index('idx_price_history_recorded').on(table.recordedAt),
  ],
);

// ─── Status History ──────────────────────────────────────────────────────────

export const statusHistory = pgTable(
  'status_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    listingKey: varchar('listing_key').notNull(),
    oldStatus: varchar('old_status'),
    newStatus: varchar('new_status').notNull(),
    modificationTs: timestamp('modification_ts', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_status_history_listing').on(table.listingKey),
    index('idx_status_history_recorded').on(table.recordedAt),
  ],
);

// ─── Property Change Log ─────────────────────────────────────────────────────

export const propertyChangeLog = pgTable(
  'property_change_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    listingKey: varchar('listing_key').notNull(),
    fieldName: varchar('field_name').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    modificationTs: timestamp('modification_ts', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_change_log_listing_field').on(table.listingKey, table.fieldName),
    index('idx_change_log_recorded').on(table.recordedAt),
  ],
);

export type PriceHistoryRecord = typeof priceHistory.$inferSelect;
export type StatusHistoryRecord = typeof statusHistory.$inferSelect;
export type PropertyChangeLogRecord = typeof propertyChangeLog.$inferSelect;
