import { eq } from 'drizzle-orm';
import { getDb } from '../db/connection.js';
import { members } from '../db/schema/members.js';
import { offices } from '../db/schema/offices.js';
import { openHouses } from '../db/schema/open-houses.js';
import { lookups } from '../db/schema/lookups.js';
import { media } from '../db/schema/media.js';
import { transformMediaRecords } from '../transform/property-mapper.js';
import type { ProcessingStats } from './property-processor.js';

// ─── Member Processor ────────────────────────────────────────────────────────

export async function processMemberRecord(
  raw: Record<string, unknown>,
  _isInitialImport: boolean,
): Promise<ProcessingStats> {
  const db = getDb();
  const stats: ProcessingStats = { inserted: 0, updated: 0, deleted: 0, mediaQueued: 0 };

  const memberKey = raw.MemberKey as string;
  if (!memberKey) return stats;

  // Check MlgCanView
  if (raw.MlgCanView === false) {
    await db
      .update(members)
      .set({ mlgCanView: false, deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(members.memberKey, memberKey));
    stats.deleted = 1;
    return stats;
  }

  // Extract local fields
  const localFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.match(/^[A-Z]{2,3}_/)) {
      localFields[key] = value;
    }
  }

  const memberData = {
    memberKey,
    memberMlsId: (raw.MemberMlsId as string) ?? null,
    originatingSystem: (raw.OriginatingSystemName as string) ?? 'actris',
    memberFullName: (raw.MemberFullName as string) ?? null,
    memberEmail: (raw.MemberEmail as string) ?? null,
    memberPhone: (raw.MemberDirectPhone as string) ?? (raw.MemberPreferredPhone as string) ?? null,
    officeKey: (raw.OfficeKey as string) ?? null,
    memberDesignation: (raw.MemberDesignation as string[]) ?? null,
    photosChangeTs: raw.PhotosChangeTimestamp
      ? new Date(raw.PhotosChangeTimestamp as string)
      : null,
    mlgCanView: true,
    modificationTs: new Date(raw.ModificationTimestamp as string),
    localFields: Object.keys(localFields).length > 0 ? localFields : null,
    updatedAt: new Date(),
  };

  // Check for existing
  const existing = await db
    .select({ memberKey: members.memberKey, photosChangeTs: members.photosChangeTs })
    .from(members)
    .where(eq(members.memberKey, memberKey))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(members).values(memberData);
    stats.inserted = 1;
  } else {
    await db.update(members).set(memberData).where(eq(members.memberKey, memberKey));
    stats.updated = 1;
  }

  // Handle media if PhotosChangeTimestamp changed
  const mediaRecords = raw.Media as Array<Record<string, unknown>> | undefined;
  if (mediaRecords && mediaRecords.length > 0) {
    const photosChanged =
      existing.length === 0 ||
      (memberData.photosChangeTs &&
        existing[0].photosChangeTs?.toISOString() !== memberData.photosChangeTs.toISOString());

    if (photosChanged) {
      const transformed = transformMediaRecords(
        memberKey,
        'Member',
        mediaRecords.map((m) => ({
          MediaKey: m.MediaKey as string,
          MediaURL: m.MediaURL as string,
          MediaModificationTimestamp: m.MediaModificationTimestamp as string,
          Order: m.Order as number,
          MediaCategory: m.MediaCategory as string,
        })),
      );
      for (const row of transformed) {
        await db
          .insert(media)
          .values(row)
          .onConflictDoUpdate({
            target: media.mediaKey,
            set: {
              mediaUrlSource: row.mediaUrlSource,
              mediaModTs: row.mediaModTs,
              status: 'pending_download',
              updatedAt: new Date(),
            },
          });
      }
      stats.mediaQueued = transformed.length;
    }
  }

  return stats;
}

// ─── Office Processor ────────────────────────────────────────────────────────

export async function processOfficeRecord(
  raw: Record<string, unknown>,
  _isInitialImport: boolean,
): Promise<ProcessingStats> {
  const db = getDb();
  const stats: ProcessingStats = { inserted: 0, updated: 0, deleted: 0, mediaQueued: 0 };

  const officeKey = raw.OfficeKey as string;
  if (!officeKey) return stats;

  if (raw.MlgCanView === false) {
    await db
      .update(offices)
      .set({ mlgCanView: false, deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(offices.officeKey, officeKey));
    stats.deleted = 1;
    return stats;
  }

  const localFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.match(/^[A-Z]{2,3}_/)) {
      localFields[key] = value;
    }
  }

  const officeData = {
    officeKey,
    officeMlsId: (raw.OfficeMlsId as string) ?? null,
    originatingSystem: (raw.OriginatingSystemName as string) ?? 'actris',
    officeName: (raw.OfficeName as string) ?? null,
    officePhone: (raw.OfficePhone as string) ?? null,
    officeEmail: (raw.OfficeEmail as string) ?? null,
    officeAddress: (raw.OfficeAddress1 as string) ?? null,
    officeCity: (raw.OfficeCity as string) ?? null,
    officeState: (raw.OfficeStateOrProvince as string) ?? null,
    officePostalCode: (raw.OfficePostalCode as string) ?? null,
    photosChangeTs: raw.PhotosChangeTimestamp
      ? new Date(raw.PhotosChangeTimestamp as string)
      : null,
    mlgCanView: true,
    modificationTs: new Date(raw.ModificationTimestamp as string),
    localFields: Object.keys(localFields).length > 0 ? localFields : null,
    updatedAt: new Date(),
  };

  const existing = await db
    .select({ officeKey: offices.officeKey, photosChangeTs: offices.photosChangeTs })
    .from(offices)
    .where(eq(offices.officeKey, officeKey))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(offices).values(officeData);
    stats.inserted = 1;
  } else {
    await db.update(offices).set(officeData).where(eq(offices.officeKey, officeKey));
    stats.updated = 1;
  }

  // Handle media
  const mediaRecords = raw.Media as Array<Record<string, unknown>> | undefined;
  if (mediaRecords && mediaRecords.length > 0) {
    const photosChanged =
      existing.length === 0 ||
      (officeData.photosChangeTs &&
        existing[0].photosChangeTs?.toISOString() !== officeData.photosChangeTs.toISOString());

    if (photosChanged) {
      const transformed = transformMediaRecords(
        officeKey,
        'Office',
        mediaRecords.map((m) => ({
          MediaKey: m.MediaKey as string,
          MediaURL: m.MediaURL as string,
          MediaModificationTimestamp: m.MediaModificationTimestamp as string,
          Order: m.Order as number,
          MediaCategory: m.MediaCategory as string,
        })),
      );
      for (const row of transformed) {
        await db
          .insert(media)
          .values(row)
          .onConflictDoUpdate({
            target: media.mediaKey,
            set: {
              mediaUrlSource: row.mediaUrlSource,
              mediaModTs: row.mediaModTs,
              status: 'pending_download',
              updatedAt: new Date(),
            },
          });
      }
      stats.mediaQueued = transformed.length;
    }
  }

  return stats;
}

// ─── OpenHouse Processor ─────────────────────────────────────────────────────

export async function processOpenHouseRecord(
  raw: Record<string, unknown>,
  _isInitialImport: boolean,
): Promise<ProcessingStats> {
  const db = getDb();
  const stats: ProcessingStats = { inserted: 0, updated: 0, deleted: 0, mediaQueued: 0 };

  const openHouseKey = raw.OpenHouseKey as string;
  if (!openHouseKey) return stats;

  if (raw.MlgCanView === false) {
    await db.delete(openHouses).where(eq(openHouses.openHouseKey, openHouseKey));
    stats.deleted = 1;
    return stats;
  }

  const listingId = raw.ListingId as string;
  if (!listingId) return stats;

  // Silently drop if parent property doesn't exist (per Q3 answer)
  // We don't enforce FK at the DB level for open_houses, so just insert

  const localFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.match(/^[A-Z]{2,3}_/)) {
      localFields[key] = value;
    }
  }

  const openHouseData = {
    openHouseKey,
    listingId,
    originatingSystem: (raw.OriginatingSystemName as string) ?? 'actris',
    openHouseDate: (raw.OpenHouseDate as string) ?? null,
    openHouseStart: raw.OpenHouseStartTime
      ? new Date(raw.OpenHouseStartTime as string)
      : null,
    openHouseEnd: raw.OpenHouseEndTime
      ? new Date(raw.OpenHouseEndTime as string)
      : null,
    openHouseRemarks: (raw.OpenHouseRemarks as string) ?? null,
    showingAgentKey: (raw.ShowingAgentKey as string) ?? null,
    mlgCanView: true,
    modificationTs: new Date(raw.ModificationTimestamp as string),
    localFields: Object.keys(localFields).length > 0 ? localFields : null,
    updatedAt: new Date(),
  };

  await db
    .insert(openHouses)
    .values(openHouseData)
    .onConflictDoUpdate({
      target: openHouses.openHouseKey,
      set: openHouseData,
    });

  stats.inserted = 1; // Simplified — could check for existing
  return stats;
}

// ─── Lookup Processor ────────────────────────────────────────────────────────

export async function processLookupRecord(
  raw: Record<string, unknown>,
  _isInitialImport: boolean,
): Promise<ProcessingStats> {
  const db = getDb();
  const stats: ProcessingStats = { inserted: 0, updated: 0, deleted: 0, mediaQueued: 0 };

  const lookupKey = raw.LookupKey as string;
  if (!lookupKey) return stats;

  if (raw.MlgCanView === false) {
    await db
      .update(lookups)
      .set({ mlgCanView: false, updatedAt: new Date() })
      .where(eq(lookups.lookupKey, lookupKey));
    stats.deleted = 1;
    return stats;
  }

  const lookupData = {
    lookupKey,
    lookupName: (raw.LookupName as string) ?? '',
    lookupValue: (raw.LookupValue as string) ?? '',
    standardLookupValue: (raw.StandardLookupValue as string) ?? null,
    originatingSystem: (raw.OriginatingSystemName as string) ?? 'actris',
    mlgCanView: true,
    modificationTs: new Date(raw.ModificationTimestamp as string),
    updatedAt: new Date(),
  };

  await db
    .insert(lookups)
    .values(lookupData)
    .onConflictDoUpdate({
      target: lookups.lookupKey,
      set: lookupData,
    });

  stats.inserted = 1;
  return stats;
}
