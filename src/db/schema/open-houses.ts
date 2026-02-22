import {
  pgTable,
  varchar,
  boolean,
  timestamp,
  date,
  text,
  jsonb,
} from 'drizzle-orm/pg-core';

export const openHouses = pgTable('open_houses', {
  openHouseKey: varchar('open_house_key').primaryKey(),
  listingId: varchar('listing_id').notNull(), // FK reference to properties.listing_id
  originatingSystem: varchar('originating_system').notNull(),
  openHouseDate: date('open_house_date'),
  openHouseStart: timestamp('open_house_start', { withTimezone: true }),
  openHouseEnd: timestamp('open_house_end', { withTimezone: true }),
  openHouseRemarks: text('open_house_remarks'),
  showingAgentKey: varchar('showing_agent_key'),
  mlgCanView: boolean('mlg_can_view').notNull().default(true),
  modificationTs: timestamp('modification_ts', { withTimezone: true }).notNull(),
  localFields: jsonb('local_fields'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export type OpenHouse = typeof openHouses.$inferSelect;
export type NewOpenHouse = typeof openHouses.$inferInsert;
