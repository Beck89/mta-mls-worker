import {
  pgTable,
  varchar,
  boolean,
  timestamp,
  jsonb,
} from 'drizzle-orm/pg-core';
import { customType } from 'drizzle-orm/pg-core';

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

export const members = pgTable('members', {
  memberKey: varchar('member_key').primaryKey(),
  memberMlsId: varchar('member_mls_id').unique(),
  originatingSystem: varchar('originating_system').notNull(),
  memberFullName: varchar('member_full_name'),
  memberEmail: varchar('member_email'),
  memberPhone: varchar('member_phone'),
  officeKey: varchar('office_key'),
  memberDesignation: textArray('member_designation'),
  photosChangeTs: timestamp('photos_change_ts', { withTimezone: true }),
  mlgCanView: boolean('mlg_can_view').notNull().default(true),
  modificationTs: timestamp('modification_ts', { withTimezone: true }).notNull(),
  localFields: jsonb('local_fields'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export type Member = typeof members.$inferSelect;
export type NewMember = typeof members.$inferInsert;
