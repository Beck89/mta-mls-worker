import { pgTable, varchar } from 'drizzle-orm/pg-core';
import { customType } from 'drizzle-orm/pg-core';
import { properties } from './properties.js';

const textArray = customType<{
  data: string[];
  driverParam: string;
}>({
  dataType() {
    return 'text[]';
  },
  toDriver(value: string[]): string {
    return `{${value.map((v) => `"${v.replace(/"/g, '\\"')}"`).join(',')}}`;
  },
});

export const rooms = pgTable('rooms', {
  roomKey: varchar('room_key').primaryKey(),
  listingKey: varchar('listing_key')
    .notNull()
    .references(() => properties.listingKey, { onDelete: 'cascade' }),
  roomType: varchar('room_type'),
  roomDimensions: varchar('room_dimensions'),
  roomFeatures: textArray('room_features'),
});

export type Room = typeof rooms.$inferSelect;
export type NewRoom = typeof rooms.$inferInsert;
