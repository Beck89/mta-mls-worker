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
import type { MlsGridPropertyRecord, MlsGridMediaRecord } from '../transform/property-mapper.js';
import { batchDeleteFromR2, uploadToR2, buildR2ObjectKey, buildPublicUrl } from '../storage/r2-client.js';
import { downloadMedia, MlsGridApiError } from '../api/mlsgrid-client.js';
import { getLogger } from '../lib/logger.js';
import { notifyIfNeeded } from '../alerts/notify.js';

const MEDIA_DOWNLOAD_STAGGER_MS = 200; // Delay between sequential media downloads
const MEDIA_MAX_RETRIES = 3;

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

  // Step 4: TRANSFORM data
  const transformed = transformProperty(raw);
  const rawData = stripExpandedResources(raw as Record<string, unknown>);
  const roomRows = transformRooms(listingKey, raw.Rooms);
  const unitTypeRows = transformUnitTypes(listingKey, raw.UnitTypes);

  // Step 5: UPSERT property + rooms + unit_types + raw_response
  // Property must be upserted BEFORE media (FK constraint)

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

  // Step 6: DOWNLOAD MEDIA INLINE (URLs expire ~11h, must download immediately)
  const mediaRecords = raw.Media;
  const photosChanged =
    isNew ||
    (existingRecord &&
      raw.PhotosChangeTimestamp &&
      existingRecord.photosChangeTs?.toISOString() !== new Date(raw.PhotosChangeTimestamp).toISOString());

  if (photosChanged && mediaRecords && mediaRecords.length > 0) {
    const mediaResult = await downloadMediaInline(listingKey, 'Property', mediaRecords, existingRecord);
    stats.mediaQueued = mediaResult.downloaded + mediaResult.failed;
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
 * Download media inline during record processing.
 * URLs expire ~11h after receipt, so we download immediately while they're fresh.
 * Also handles deletion of media that no longer exists.
 */
async function downloadMediaInline(
  listingKey: string,
  resourceType: string,
  incomingMedia: MlsGridMediaRecord[],
  _existingRecord: typeof properties.$inferSelect | null,
): Promise<{ downloaded: number; failed: number; skipped: number }> {
  const db = getDb();
  const logger = getLogger();
  let downloaded = 0;
  let failed = 0;
  let skipped = 0;

  // Get existing media keys for this listing
  const existingMedia = await db
    .select({ mediaKey: media.mediaKey, mediaModTs: media.mediaModTs, r2ObjectKey: media.r2ObjectKey })
    .from(media)
    .where(eq(media.listingKey, listingKey));

  const existingMediaMap = new Map(existingMedia.map((m: { mediaKey: string; mediaModTs: Date | null; r2ObjectKey: string }) => [m.mediaKey, m]));
  const incomingMediaKeys = new Set(incomingMedia.map((m) => m.MediaKey).filter(Boolean));

  // Find media to delete (no longer in incoming data)
  const mediaToDelete = existingMedia.filter((m: { mediaKey: string; r2ObjectKey: string }) => !incomingMediaKeys.has(m.mediaKey));
  if (mediaToDelete.length > 0) {
    const r2Keys = mediaToDelete.map((m: { r2ObjectKey: string }) => m.r2ObjectKey);
    try {
      await batchDeleteFromR2(r2Keys);
    } catch (err) {
      logger.error({ err, listingKey, count: r2Keys.length }, 'Failed to delete removed media from R2');
    }
    for (const m of mediaToDelete) {
      await db.delete(media).where(eq(media.mediaKey, (m as { mediaKey: string }).mediaKey));
    }
  }

  // Process each incoming media record: upsert metadata + download + upload to R2
  const mediaRows = transformMediaRecords(listingKey, resourceType, incomingMedia);

  for (let i = 0; i < mediaRows.length; i++) {
    const row = mediaRows[i];
    const rawMedia = incomingMedia[i];
    const existingRow = existingMediaMap.get(row.mediaKey);

    // Check if download is needed (new or MediaModificationTimestamp changed)
    const needsDownload =
      !existingRow ||
      (row.mediaModTs &&
        existingRow.mediaModTs?.toISOString() !== row.mediaModTs.toISOString());

    if (!needsDownload) {
      // Media unchanged — just update metadata
      await db
        .insert(media)
        .values({ ...row, status: 'complete' })
        .onConflictDoUpdate({
          target: media.mediaKey,
          set: {
            mediaOrder: row.mediaOrder,
            mediaCategory: row.mediaCategory,
            updatedAt: new Date(),
          },
        });
      skipped++;
      continue;
    }

    const mediaUrl = rawMedia.MediaURL;
    if (!mediaUrl) {
      // No URL — insert as failed
      await db
        .insert(media)
        .values({ ...row, status: 'failed' })
        .onConflictDoUpdate({
          target: media.mediaKey,
          set: { status: 'failed', updatedAt: new Date() },
        });
      failed++;
      continue;
    }

    // Download and upload with retry
    let success = false;
    for (let attempt = 0; attempt < MEDIA_MAX_RETRIES; attempt++) {
      try {
        const result = await downloadMedia(mediaUrl);

        // Build R2 key with actual content type
        const r2ObjectKey = buildR2ObjectKey(resourceType, listingKey, row.mediaKey, result.contentType);
        const publicUrl = buildPublicUrl(r2ObjectKey);

        // Upload to R2
        await uploadToR2(r2ObjectKey, result.buffer, result.contentType);

        // Upsert media row as complete
        await db
          .insert(media)
          .values({
            ...row,
            status: 'complete',
            r2ObjectKey,
            publicUrl,
            fileSizeBytes: result.bytes,
            contentType: result.contentType,
          })
          .onConflictDoUpdate({
            target: media.mediaKey,
            set: {
              status: 'complete',
              r2ObjectKey,
              publicUrl,
              mediaUrlSource: row.mediaUrlSource,
              mediaModTs: row.mediaModTs,
              mediaOrder: row.mediaOrder,
              fileSizeBytes: result.bytes,
              contentType: result.contentType,
              updatedAt: new Date(),
            },
          });

        downloaded++;
        success = true;

        logger.debug(
          { mediaKey: row.mediaKey, bytes: result.bytes, listingKey },
          'Media downloaded inline',
        );
        break;
      } catch (err) {
        const is429 = err instanceof MlsGridApiError && err.statusCode === 429;
        if (is429 && attempt < MEDIA_MAX_RETRIES - 1) {
          // Wait longer on 429
          const waitMs = 30_000 * (attempt + 1); // 30s, 60s, 90s
          logger.warn(
            { mediaKey: row.mediaKey, attempt: attempt + 1, waitMs },
            'Media download 429 — waiting before retry',
          );
          await sleep(waitMs);
          continue;
        }
        if (attempt < MEDIA_MAX_RETRIES - 1) {
          // Non-429 error — brief backoff
          await sleep(2_000 * (attempt + 1));
          continue;
        }
        // Final attempt failed
        logger.error(
          { mediaKey: row.mediaKey, listingKey, err: (err as Error).message },
          'Media download failed after retries',
        );
      }
    }

    if (!success) {
      // Insert/update as failed
      await db
        .insert(media)
        .values({ ...row, status: 'failed' })
        .onConflictDoUpdate({
          target: media.mediaKey,
          set: { status: 'failed', retryCount: MEDIA_MAX_RETRIES, updatedAt: new Date() },
        });
      failed++;
    }

    // Stagger between downloads to avoid CDN rate limits
    if (i < mediaRows.length - 1) {
      await sleep(MEDIA_DOWNLOAD_STAGGER_MS);
    }
  }

  logger.info(
    { listingKey, downloaded, failed, skipped, total: mediaRows.length },
    'Media processing complete for listing',
  );

  return { downloaded, failed, skipped };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
