import {
  pgTable,
  varchar,
  boolean,
  timestamp,
  jsonb,
} from 'drizzle-orm/pg-core';

export const offices = pgTable('offices', {
  officeKey: varchar('office_key').primaryKey(),
  officeMlsId: varchar('office_mls_id').unique(),
  originatingSystem: varchar('originating_system').notNull(),
  officeName: varchar('office_name'),
  officePhone: varchar('office_phone'),
  officeEmail: varchar('office_email'),
  officeAddress: varchar('office_address'),
  officeCity: varchar('office_city'),
  officeState: varchar('office_state'),
  officePostalCode: varchar('office_postal_code'),
  photosChangeTs: timestamp('photos_change_ts', { withTimezone: true }),
  mlgCanView: boolean('mlg_can_view').notNull().default(true),
  modificationTs: timestamp('modification_ts', { withTimezone: true }).notNull(),
  localFields: jsonb('local_fields'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export type Office = typeof offices.$inferSelect;
export type NewOffice = typeof offices.$inferInsert;
