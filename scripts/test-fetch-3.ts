/**
 * Test script: Fetch 3 properties from MLS Grid, process them into DB,
 * and download their media to R2.
 *
 * Run with: npx tsx scripts/test-fetch-3.ts
 */
import 'dotenv/config';
import { loadEnv, getEnv } from '../src/config/env.js';
import { createLogger, getLogger } from '../src/lib/logger.js';
import { createDb, getDb, closeDb } from '../src/db/connection.js';
import { createRateLimiter } from '../src/lib/rate-limiter.js';
import { createR2Client } from '../src/storage/r2-client.js';
import { buildPublicUrl } from '../src/storage/r2-client.js';
import { fetchPage } from '../src/api/mlsgrid-client.js';
import { processPropertyRecord } from '../src/pipeline/property-processor.js';
import { replicationRuns } from '../src/db/schema/monitoring.js';
import { properties } from '../src/db/schema/properties.js';
import { media } from '../src/db/schema/media.js';
import { rooms } from '../src/db/schema/rooms.js';
import { unitTypes } from '../src/db/schema/unit-types.js';
import { eq } from 'drizzle-orm';
import { downloadMedia } from '../src/api/mlsgrid-client.js';
import { uploadToR2, buildR2ObjectKey } from '../src/storage/r2-client.js';

async function main() {
  // Initialize everything
  const env = loadEnv();
  const logger = createLogger();
  createDb();
  createRateLimiter();
  createR2Client();

  const db = getDb();

  logger.info('=== Test: Fetch 3 Properties from MLS Grid ===');

  // Create a test replication run
  const [run] = await db
    .insert(replicationRuns)
    .values({
      resourceType: 'Property',
      runMode: 'initial_import',
      startedAt: new Date(),
      status: 'running',
    })
    .returning({ id: replicationRuns.id });

  const runId = run.id;
  logger.info({ runId }, 'Created test replication run');

  // Fetch 3 properties from ACTRIS with $expand=Media,Rooms,UnitTypes
  const originatingSystem = env.MLSGRID_ORIGINATING_SYSTEM;
  const url = `${env.MLSGRID_API_BASE_URL}/Property?$filter=OriginatingSystemName%20eq%20%27${originatingSystem}%27%20and%20MlgCanView%20eq%20true&$expand=Media,Rooms,UnitTypes&$top=3`;

  logger.info({ url: url.substring(0, 120) + '...' }, 'Fetching 3 properties');

  const page = await fetchPage(url, runId);
  logger.info({ recordsReceived: page.value.length, responseBytes: page.responseBytes }, 'Page fetched');

  // Process each record
  for (const record of page.value) {
    const listingKey = (record as any).ListingKey as string;
    const address = (record as any).UnparsedAddress as string;
    const mediaCount = ((record as any).Media as any[])?.length ?? 0;

    logger.info({ listingKey, address: address?.trim(), mediaCount }, 'Processing property');

    const stats = await processPropertyRecord(record as any, {
      isInitialImport: true,
      runId,
    });

    logger.info({ listingKey, ...stats }, 'Property processed');
  }

  // Now download media for these 3 properties
  logger.info('=== Downloading media for test properties ===');

  const pendingMedia = await db
    .select({
      mediaKey: media.mediaKey,
      listingKey: media.listingKey,
      resourceType: media.resourceType,
      mediaUrlSource: media.mediaUrlSource,
    })
    .from(media)
    .where(eq(media.status, 'pending_download'));

  logger.info({ pendingCount: pendingMedia.length }, 'Pending media downloads');

  let downloaded = 0;
  let failed = 0;

  for (const row of pendingMedia) {
    if (!row.mediaUrlSource) {
      logger.warn({ mediaKey: row.mediaKey }, 'No source URL — skipping');
      failed++;
      continue;
    }

    try {
      // Download from MLS Grid
      const result = await downloadMedia(row.mediaUrlSource);

      // Build R2 key with actual content type
      const r2ObjectKey = buildR2ObjectKey(
        row.resourceType,
        row.listingKey,
        row.mediaKey,
        result.contentType,
      );

      // Upload to R2
      await uploadToR2(r2ObjectKey, result.buffer, result.contentType);

      // Build public URL
      const publicUrl = buildPublicUrl(r2ObjectKey);

      // Update media row
      await db
        .update(media)
        .set({
          status: 'complete',
          r2ObjectKey,
          publicUrl,
          fileSizeBytes: result.bytes,
          contentType: result.contentType,
          updatedAt: new Date(),
        })
        .where(eq(media.mediaKey, row.mediaKey));

      downloaded++;
      logger.info({
        mediaKey: row.mediaKey,
        bytes: result.bytes,
        contentType: result.contentType,
        publicUrl,
      }, 'Media downloaded and uploaded');
    } catch (err) {
      failed++;
      logger.error({ mediaKey: row.mediaKey, err: (err as Error).message }, 'Media download failed');
    }
  }

  // Update run status
  await db
    .update(replicationRuns)
    .set({
      completedAt: new Date(),
      status: 'completed',
      totalRecordsReceived: page.value.length,
      recordsInserted: page.value.length,
      mediaDownloaded: downloaded,
    })
    .where(eq(replicationRuns.id, runId));

  // Print summary
  logger.info('=== Test Summary ===');

  const propCount = await db.select({ key: properties.listingKey }).from(properties);
  const mediaCount = await db.select({ key: media.mediaKey }).from(media);
  const completeMedia = await db
    .select({ key: media.mediaKey, publicUrl: media.publicUrl })
    .from(media)
    .where(eq(media.status, 'complete'))
    .limit(3);

  logger.info({
    propertiesInDb: propCount.length,
    mediaRowsInDb: mediaCount.length,
    mediaDownloaded: downloaded,
    mediaFailed: failed,
  }, 'Final counts');

  if (completeMedia.length > 0) {
    logger.info('Sample public URLs:');
    for (const m of completeMedia) {
      console.log(`  ${m.publicUrl}`);
    }
  }

  await closeDb();
  logger.info('Test complete!');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
