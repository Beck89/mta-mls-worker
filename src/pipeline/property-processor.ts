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
import { downloadMedia, fetchPage, MlsGridApiError } from '../api/mlsgrid-client.js';
import { isMediaUrlExpired } from './media-downloader.js';
import { getEnv } from '../config/env.js';
import { getLogger } from '../lib/logger.js';
import { notifyIfNeeded } from '../alerts/notify.js';

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
    const mediaResult = await downloadMediaInline(listingKey, raw.ListingId ?? null, 'Property', mediaRecords, existingRecord);
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
 * Handle MlgCanView=false: update the flag but keep the property and its media.
 */
async function handleSoftDelete(
  listingKey: string,
  raw: MlsGridPropertyRecord,
  options: ProcessRecordOptions,
): Promise<void> {
  const db = getDb();
  const logger = getLogger();

  // Check if record exists and whether it's already marked as not viewable
  const existing = await db
    .select({
      listingKey: properties.listingKey,
      standardStatus: properties.standardStatus,
      mlgCanView: properties.mlgCanView,
    })
    .from(properties)
    .where(eq(properties.listingKey, listingKey))
    .limit(1);

  if (existing.length === 0) {
    // Record doesn't exist locally — nothing to update
    return;
  }

  const alreadyHidden = existing[0].mlgCanView === false;

  // Mark property as no longer viewable (keep media and do NOT set deletedAt)
  await db
    .update(properties)
    .set({
      mlgCanView: false,
      updatedAt: new Date(),
      modificationTs: new Date(raw.ModificationTimestamp!),
    })
    .where(eq(properties.listingKey, listingKey));

  // Log status change only if this is a new transition to MlgCanView=false
  if (!options.isInitialImport && !alreadyHidden) {
    await db.insert(statusHistory).values({
      listingKey,
      oldStatus: existing[0].standardStatus,
      newStatus: 'Deleted/Removed',
      modificationTs: new Date(raw.ModificationTimestamp!),
    });
  }

  // Notify only on new transitions (no-op in Phase 1)
  if (!options.isInitialImport && !alreadyHidden) {
    await notifyIfNeeded({
      type: 'property_deleted',
      listingKey,
      oldValue: existing[0].standardStatus,
      newValue: null,
    });
  }

  logger.info({ listingKey, alreadyHidden }, 'Property marked MlgCanView=false (media retained)');
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
  listingId: string | null,
  resourceType: string,
  incomingMedia: MlsGridMediaRecord[],
  _existingRecord: typeof properties.$inferSelect | null,
): Promise<{ downloaded: number; failed: number; skipped: number }> {
  const db = getDb();
  const logger = getLogger();
  const env = getEnv();
  let downloaded = 0;
  let failed = 0;
  let skipped = 0;

  // Get existing media keys for this listing
  const existingMedia = await db
    .select({
      mediaKey: media.mediaKey,
      mediaModTs: media.mediaModTs,
      r2ObjectKey: media.r2ObjectKey,
      publicUrl: media.publicUrl,
      fileSizeBytes: media.fileSizeBytes,
      status: media.status,
    })
    .from(media)
    .where(eq(media.listingKey, listingKey));

  const existingMediaMap = new Map(existingMedia.map((m) => [m.mediaKey, m]));
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

  // Pre-check: if the first media URL is already expired, fetch fresh URLs from
  // the API before entering the download loop. This handles the case where the
  // replication page was fetched hours ago and all URLs have since expired.
  let freshUrlMap: Map<string, string> | null = null;
  const firstUrl = incomingMedia[0]?.MediaURL;
  if (firstUrl && isMediaUrlExpired(firstUrl) && listingId) {
    logger.info(
      { listingKey, listingId },
      'Media URLs expired — fetching fresh URLs from API',
    );
    try {
      const apiUrl =
        `${env.MLSGRID_API_BASE_URL}/Property` +
        `?$filter=${encodeURIComponent(`OriginatingSystemName eq '${env.MLSGRID_ORIGINATING_SYSTEM}' and ListingId eq '${listingId}'`)}` +
        `&$expand=Media&$top=1`;
      const page = await fetchPage(apiUrl, 0);
      if (page.value.length > 0) {
        const record = page.value[0] as Record<string, unknown>;
        const mediaArray = record.Media as Array<Record<string, unknown>> | undefined;
        if (mediaArray) {
          freshUrlMap = new Map(
            mediaArray
              .filter((m) => m.MediaKey && m.MediaURL)
              .map((m) => [m.MediaKey as string, m.MediaURL as string]),
          );
          logger.info(
            { listingKey, freshUrls: freshUrlMap.size },
            'Fetched fresh media URLs',
          );
        }
      }
    } catch (err) {
      logger.warn(
        { listingKey, listingId, err: (err as Error).message },
        'Failed to fetch fresh media URLs — will mark as expired for recovery',
      );
    }
  }

  // Phase 1: Quick checks — handle skips, fast-paths, no-URL, expired URL
  // Collect items that need actual downloading into a separate list.
  interface DownloadTask {
    row: typeof mediaRows[0];
    rawMedia: (typeof incomingMedia)[0];
    existingRow: typeof existingMedia[0] | undefined;
    mediaUrl: string;
  }
  const downloadTasks: DownloadTask[] = [];

  for (let i = 0; i < mediaRows.length; i++) {
    const row = mediaRows[i];
    const rawMedia = incomingMedia[i];
    const existingRow = existingMediaMap.get(row.mediaKey);

    // Check if download is needed
    const needsDownload =
      !existingRow ||
      existingRow.status !== 'complete' ||
      (row.mediaModTs &&
        existingRow.mediaModTs?.toISOString() !== row.mediaModTs.toISOString());

    if (!needsDownload) {
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

    // Fast-path: already in R2
    if (
      existingRow?.r2ObjectKey &&
      existingRow.r2ObjectKey.length > 0 &&
      existingRow.publicUrl &&
      existingRow.fileSizeBytes != null &&
      existingRow.fileSizeBytes > 0
    ) {
      await db
        .update(media)
        .set({
          status: 'complete',
          mediaOrder: row.mediaOrder,
          mediaCategory: row.mediaCategory,
          mediaModTs: row.mediaModTs,
          updatedAt: new Date(),
        })
        .where(eq(media.mediaKey, row.mediaKey));
      skipped++;
      continue;
    }

    // Resolve URL
    const originalUrl = rawMedia.MediaURL;
    const mediaUrl = freshUrlMap?.get(row.mediaKey) ?? originalUrl;

    if (!mediaUrl) {
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

    // Pre-flight expired check
    if (isMediaUrlExpired(mediaUrl)) {
      if (existingRow?.status === 'expired') {
        skipped++;
        continue;
      }
      await db
        .insert(media)
        .values({ ...row, status: 'expired', mediaUrlSource: mediaUrl })
        .onConflictDoUpdate({
          target: media.mediaKey,
          set: { status: 'expired', mediaUrlSource: mediaUrl, updatedAt: new Date() },
        });
      failed++;
      continue;
    }

    // Needs actual download — add to task list
    downloadTasks.push({ row, rawMedia, existingRow, mediaUrl });
  }

  // Phase 2: Download in concurrent batches
  const INLINE_CONCURRENCY = env.WORKER_INLINE_MEDIA_CONCURRENCY;

  for (let batchStart = 0; batchStart < downloadTasks.length; batchStart += INLINE_CONCURRENCY) {
    const batch = downloadTasks.slice(batchStart, batchStart + INLINE_CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map(async (task) => {
        const { row, existingRow, mediaUrl } = task;

        for (let attempt = 0; attempt < MEDIA_MAX_RETRIES; attempt++) {
          try {
            const result = await downloadMedia(mediaUrl);
            const r2ObjectKey = buildR2ObjectKey(resourceType, listingKey, row.mediaKey, result.contentType);
            const publicUrl = buildPublicUrl(r2ObjectKey);

            await uploadToR2(r2ObjectKey, result.buffer, result.contentType);

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

            logger.debug(
              { mediaKey: row.mediaKey, bytes: result.bytes, listingKey },
              'Media downloaded inline',
            );
            return 'downloaded' as const;
          } catch (err) {
            const is429 = err instanceof MlsGridApiError && err.statusCode === 429;
            const isExpiredUrl = err instanceof MlsGridApiError && (err.statusCode === 400 || err.statusCode === 403);

            if (isExpiredUrl) {
              if (
                existingRow?.publicUrl &&
                existingRow.fileSizeBytes != null &&
                existingRow.fileSizeBytes > 0
              ) {
                return 'skipped' as const;
              }
              await db
                .insert(media)
                .values({ ...row, status: 'expired', mediaUrlSource: mediaUrl })
                .onConflictDoUpdate({
                  target: media.mediaKey,
                  set: { status: 'expired', mediaUrlSource: mediaUrl, updatedAt: new Date() },
                });
              return 'expired' as const;
            }
            if (is429 && attempt < MEDIA_MAX_RETRIES - 1) {
              const waitMs = 30_000 * (attempt + 1);
              logger.warn(
                { mediaKey: row.mediaKey, attempt: attempt + 1, waitMs },
                'Media download 429 — waiting before retry',
              );
              await sleep(waitMs);
              continue;
            }
            if (attempt < MEDIA_MAX_RETRIES - 1) {
              await sleep(2_000 * (attempt + 1));
              continue;
            }
            logger.error(
              { mediaKey: row.mediaKey, listingKey, err: (err as Error).message },
              'Media download failed after retries',
            );
          }
        }

        // All retries exhausted
        await db
          .insert(media)
          .values({ ...row, status: 'failed' })
          .onConflictDoUpdate({
            target: media.mediaKey,
            set: { status: 'failed', retryCount: MEDIA_MAX_RETRIES, updatedAt: new Date() },
          });
        return 'failed' as const;
      }),
    );

    // Tally results
    for (const result of results) {
      if (result.status === 'fulfilled') {
        switch (result.value) {
          case 'downloaded': downloaded++; break;
          case 'skipped': skipped++; break;
          case 'expired': failed++; break;
          case 'failed': failed++; break;
        }
      } else {
        // Promise rejected (unexpected)
        failed++;
        logger.error({ err: result.reason }, 'Unexpected error in media download batch');
      }
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
