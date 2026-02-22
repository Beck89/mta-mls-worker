import { eq } from 'drizzle-orm';
import { getDb } from '../db/connection.js';
import { properties } from '../db/schema/properties.js';
import { media } from '../db/schema/media.js';
import { rooms } from '../db/schema/rooms.js';
import { unitTypes } from '../db/schema/unit-types.js';
import { rawResponses } from '../db/schema/raw-responses.js';
import { priceHistory, statusHistory, propertyChangeLog } from '../db/schema/history.js';
import {
  transformProperty,
  transformRooms,
  transformUnitTypes,
  transformMediaRecords,
  stripExpandedResources,
} from '../transform/property-mapper.js';
import type { MlsGridPropertyRecord } from '../transform/property-mapper.js';
import { batchDeleteFromR2 } from '../storage/r2-client.js';
import { getLogger } from '../lib/logger.js';
import { notifyIfNeeded } from '../alerts/notify.js';

export interface ProcessingStats {
  inserted: number;
  updated: number;
  deleted: number;
  mediaQueued: number;
}

export interface ProcessRecordOptions {
  isInitialImport: boolean;
  runId: number;
}

/**
 * Process a single property record from MLS Grid.
 * Implements the full per-record pipeline from the Phase 1 spec.
 */
export async function processPropertyRecord(
  raw: MlsGridPropertyRecord,
  options: ProcessRecordOptions,
): Promise<ProcessingStats> {
  const db = getDb();
  const logger = getLogger();
  const stats: ProcessingStats = { inserted: 0, updated: 0, deleted: 0, mediaQueued: 0 };

  const listingKey = raw.ListingKey;
  if (!listingKey) {
    logger.warn({ raw: JSON.stringify(raw).substring(0, 200) }, 'Skipping record with no ListingKey');
    return stats;
  }

  // Step 1: CHECK MlgCanView
  if (raw.MlgCanView === false) {
    await handleSoftDelete(listingKey, raw, options);
    stats.deleted = 1;
    return stats;
  }

  // Step 2: LOAD existing record
  const existing = await db
    .select()
    .from(properties)
    .where(eq(properties.listingKey, listingKey))
    .limit(1);

  const isNew = existing.length === 0;
  const existingRecord = existing[0] ?? null;

  // Step 3: DIFF against existing (update path only, skip during initial import)
  if (!isNew && !options.isInitialImport && existingRecord) {
    await recordDiffs(listingKey, existingRecord, raw);
  }

  // Step 4: QUEUE MEDIA
  const mediaRecords = raw.Media;
  const photosChanged =
    isNew ||
    (existingRecord &&
      raw.PhotosChangeTimestamp &&
      existingRecord.photosChangeTs?.toISOString() !== new Date(raw.PhotosChangeTimestamp).toISOString());

  if (photosChanged && mediaRecords && mediaRecords.length > 0) {
    await queueMediaUpdates(listingKey, mediaRecords, existingRecord);
    stats.mediaQueued = mediaRecords.length;
  }

  // Step 5: PROCESS ROOMS AND UNIT_TYPES
  const roomRows = transformRooms(listingKey, raw.Rooms);
  const unitTypeRows = transformUnitTypes(listingKey, raw.UnitTypes);

  // Step 6: UPSERT property + raw_response (SINGLE TRANSACTION)
  const transformed = transformProperty(raw);
  const rawData = stripExpandedResources(raw as Record<string, unknown>);

  // Delete existing rooms/unit_types and re-insert (replace strategy)
  await db.delete(rooms).where(eq(rooms.listingKey, listingKey));
  await db.delete(unitTypes).where(eq(unitTypes.listingKey, listingKey));

  // Upsert property
  await db
    .insert(properties)
    .values(transformed)
    .onConflictDoUpdate({
      target: properties.listingKey,
      set: {
        ...transformed,
        createdAt: undefined, // Don't overwrite created_at on update
      },
    });

  // Upsert raw_response
  await db
    .insert(rawResponses)
    .values({
      listingKey,
      rawData,
      originatingSystem: transformed.originatingSystem,
      receivedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: rawResponses.listingKey,
      set: {
        rawData,
        receivedAt: new Date(),
      },
    });

  // Insert rooms
  if (roomRows.length > 0) {
    await db.insert(rooms).values(roomRows);
  }

  // Insert unit types
  if (unitTypeRows.length > 0) {
    await db.insert(unitTypes).values(unitTypeRows);
  }

  if (isNew) {
    stats.inserted = 1;
  } else {
    stats.updated = 1;
  }

  // Step 7: EVALUATE ALERTS (no-op in Phase 1)
  if (!options.isInitialImport && !isNew) {
    await notifyIfNeeded({
      type: 'property_updated',
      listingKey,
      oldValue: existingRecord?.listPrice?.toString() ?? null,
      newValue: raw.ListPrice?.toString() ?? null,
    });
  }

  return stats;
}

/**
 * Handle soft-delete when MlgCanView is false.
 */
async function handleSoftDelete(
  listingKey: string,
  raw: MlsGridPropertyRecord,
  options: ProcessRecordOptions,
): Promise<void> {
  const db = getDb();
  const logger = getLogger();

  // Check if record exists
  const existing = await db
    .select({ listingKey: properties.listingKey, standardStatus: properties.standardStatus })
    .from(properties)
    .where(eq(properties.listingKey, listingKey))
    .limit(1);

  if (existing.length === 0) {
    // Record doesn't exist locally — nothing to delete
    return;
  }

  // Soft-delete the property
  await db
    .update(properties)
    .set({
      mlgCanView: false,
      deletedAt: new Date(),
      updatedAt: new Date(),
      modificationTs: new Date(raw.ModificationTimestamp!),
    })
    .where(eq(properties.listingKey, listingKey));

  // Log status change
  if (!options.isInitialImport) {
    await db.insert(statusHistory).values({
      listingKey,
      oldStatus: existing[0].standardStatus,
      newStatus: 'Deleted/Removed',
      modificationTs: new Date(raw.ModificationTimestamp!),
    });
  }

  // Delete media from R2 immediately
  const mediaRows = await db
    .select({ r2ObjectKey: media.r2ObjectKey })
    .from(media)
    .where(eq(media.listingKey, listingKey));

  if (mediaRows.length > 0) {
    const keys = mediaRows.map((m) => m.r2ObjectKey);
    try {
      await batchDeleteFromR2(keys);
    } catch (err) {
      logger.error({ err, listingKey, mediaCount: keys.length }, 'Failed to delete media from R2');
    }
    // Delete media rows from database
    await db.delete(media).where(eq(media.listingKey, listingKey));
  }

  // Notify (no-op in Phase 1)
  if (!options.isInitialImport) {
    await notifyIfNeeded({
      type: 'property_deleted',
      listingKey,
      oldValue: existing[0].standardStatus,
      newValue: null,
    });
  }

  logger.info({ listingKey }, 'Property soft-deleted (MlgCanView=false)');
}

/**
 * Record diffs between existing and incoming record.
 * Inserts into price_history, status_history, and property_change_log.
 */
async function recordDiffs(
  listingKey: string,
  existing: typeof properties.$inferSelect,
  raw: MlsGridPropertyRecord,
): Promise<void> {
  const db = getDb();
  const modTs = new Date(raw.ModificationTimestamp!);

  // Price change
  const oldPrice = existing.listPrice;
  const newPrice = raw.ListPrice?.toString() ?? null;
  if (oldPrice !== newPrice && newPrice !== null) {
    const changeType =
      oldPrice && newPrice && parseFloat(newPrice) > parseFloat(oldPrice)
        ? 'Price Increase'
        : 'Price Decrease';

    await db.insert(priceHistory).values({
      listingKey,
      oldPrice,
      newPrice,
      changeType: raw.MajorChangeType ?? changeType,
      modificationTs: modTs,
    });
  }

  // Status change
  const oldStatus = existing.standardStatus;
  const newStatus = raw.StandardStatus ?? null;
  if (oldStatus !== newStatus && newStatus !== null) {
    await db.insert(statusHistory).values({
      listingKey,
      oldStatus,
      newStatus,
      modificationTs: modTs,
    });
  }

  // General field-level change log for watched fields
  const fieldMap: Record<string, { old: string | null; new: string | null }> = {
    ListPrice: { old: existing.listPrice, new: raw.ListPrice?.toString() ?? null },
    StandardStatus: { old: existing.standardStatus, new: raw.StandardStatus ?? null },
    PhotosCount: {
      old: existing.photosCount?.toString() ?? null,
      new: raw.PhotosCount?.toString() ?? null,
    },
    PublicRemarks: { old: existing.publicRemarks, new: raw.PublicRemarks ?? null },
    LivingArea: { old: existing.livingArea, new: raw.LivingArea?.toString() ?? null },
  };

  for (const [fieldName, values] of Object.entries(fieldMap)) {
    if (values.old !== values.new && values.new !== null) {
      await db.insert(propertyChangeLog).values({
        listingKey,
        fieldName,
        oldValue: values.old,
        newValue: values.new,
        modificationTs: modTs,
      });
    }
  }
}

/**
 * Queue media updates: upsert media rows with pending_download status.
 * Also handles deletion of media that no longer exists.
 */
async function queueMediaUpdates(
  listingKey: string,
  incomingMedia: NonNullable<MlsGridPropertyRecord['Media']>,
  _existingRecord: typeof properties.$inferSelect | null,
): Promise<void> {
  const db = getDb();
  const logger = getLogger();

  // Get existing media keys for this listing
  const existingMedia = await db
    .select({ mediaKey: media.mediaKey, mediaModTs: media.mediaModTs, r2ObjectKey: media.r2ObjectKey })
    .from(media)
    .where(eq(media.listingKey, listingKey));

  const existingMediaMap = new Map(existingMedia.map((m) => [m.mediaKey, m]));
  const incomingMediaKeys = new Set(incomingMedia.map((m) => m.MediaKey).filter(Boolean));

  // Find media to delete (no longer in incoming data)
  const mediaToDelete = existingMedia.filter((m) => !incomingMediaKeys.has(m.mediaKey));
  if (mediaToDelete.length > 0) {
    const r2Keys = mediaToDelete.map((m) => m.r2ObjectKey);
    try {
      await batchDeleteFromR2(r2Keys);
    } catch (err) {
      logger.error({ err, listingKey, count: r2Keys.length }, 'Failed to delete removed media from R2');
    }
    for (const m of mediaToDelete) {
      await db.delete(media).where(eq(media.mediaKey, m.mediaKey));
    }
  }

  // Upsert incoming media
  const newMediaRows = transformMediaRecords(listingKey, 'Property', incomingMedia);
  for (const row of newMediaRows) {
    const existingRow = existingMediaMap.get(row.mediaKey);

    // Only queue for download if new or MediaModificationTimestamp changed
    const needsDownload =
      !existingRow ||
      (row.mediaModTs &&
        existingRow.mediaModTs?.toISOString() !== row.mediaModTs.toISOString());

    await db
      .insert(media)
      .values({
        ...row,
        status: needsDownload ? 'pending_download' : 'complete',
      })
      .onConflictDoUpdate({
        target: media.mediaKey,
        set: {
          mediaUrlSource: row.mediaUrlSource,
          mediaModTs: row.mediaModTs,
          mediaOrder: row.mediaOrder,
          mediaCategory: row.mediaCategory,
          status: needsDownload ? 'pending_download' : undefined,
          updatedAt: new Date(),
        },
      });
  }
}
