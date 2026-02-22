import { pgTable, varchar, integer, numeric } from 'drizzle-orm/pg-core';
import { properties } from './properties';

export const unitTypes = pgTable('unit_types', {
  unitTypeKey: varchar('unit_type_key').primaryKey(),
  listingKey: varchar('listing_key')
    .notNull()
    .references(() => properties.listingKey, { onDelete: 'cascade' }),
  unitTypeType: varchar('unit_type_type'),
  unitTypeBeds: integer('unit_type_beds'),
  unitTypeBaths: numeric('unit_type_baths'),
  unitTypeRent: numeric('unit_type_rent'),
});

export type UnitType = typeof unitTypes.$inferSelect;
export type NewUnitType = typeof unitTypes.$inferInsert;
