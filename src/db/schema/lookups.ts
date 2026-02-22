import {
  pgTable,
  varchar,
  boolean,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

export const lookups = pgTable(
  'lookups',
  {
    lookupKey: varchar('lookup_key').primaryKey(),
    lookupName: varchar('lookup_name').notNull(),
    lookupValue: varchar('lookup_value').notNull(),
    standardLookupValue: varchar('standard_lookup_value'),
    originatingSystem: varchar('originating_system').notNull(),
    mlgCanView: boolean('mlg_can_view').notNull().default(true),
    modificationTs: timestamp('modification_ts', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_lookups_system_name').on(table.originatingSystem, table.lookupName),
  ],
);

export type Lookup = typeof lookups.$inferSelect;
export type NewLookup = typeof lookups.$inferInsert;
