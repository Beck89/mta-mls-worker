import { eq, and, lt, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '../db/connection.js';
import { properties } from '../db/schema/properties.js';
import { media } from '../db/schema/media.js';
import { rooms } from '../db/schema/rooms.js';
import { unitTypes } from '../db/schema/unit-types.js';
import { rawResponses } from '../db/schema/raw-responses.js';
import { priceHistory, statusHistory, propertyChangeLog } from '../db/schema/history.js';
import { replicationRuns } from '../db/schema/monitoring.js';
import { runReplicationCycle } from '../pipeline/replication-cycle.js';
import { createMediaDownloader, getMediaDownloader } from '../pipeline/media-downloader.js';
import { createRateLimiter } from '../lib/rate-limiter.js';
import { createR2Client } from '../storage/r2-client.js';
import { getEnv } from '../config/env.js';
import { getLogger } from '../lib/logger.js';
import type { ResourceType } from '../api/mlsgrid-client.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ResourceSchedulerState {
  running: boolean;
  lastCycleEnd: Date | null;
}

export function createScheduler() {
  const logger = getLogger();
  const env = getEnv();

  const resourceStates: Record<ResourceType, ResourceSchedulerState> = {
    Property: { running: false, lastCycleEnd: null },
    Member: { running: false, lastCycleEnd: null },
    Office: { running: false, lastCycleEnd: null },
    OpenHouse: { running: false, lastCycleEnd: null },
    Lookup: { running: false, lastCycleEnd: null },
  };

  let isRunning = false;
  let initialImportComplete = false;

  const cadences: Record<ResourceType, number> = {
    Property: env.CADENCE_PROPERTY * 1000,
    Member: env.CADENCE_MEMBER * 1000,
    Office: env.CADENCE_OFFICE * 1000,
    OpenHouse: env.CADENCE_OPEN_HOUSE * 1000,
    Lookup: env.CADENCE_LOOKUP * 1000,
  };

  /**
   * Run a single resource's replication loop.
   * Non-overlapping: waits cadence AFTER completion before starting next cycle.
   */
  async function runResourceLoop(resource: ResourceType): Promise<void> {
    const state = resourceStates[resource];

    while (isRunning) {
      if (state.running) {
        await sleep(1000);
        continue;
      }

      state.running = true;
      try {
        const result = await runReplicationCycle(resource);
        state.lastCycleEnd = new Date();

        logger.info(
          {
            resource,
            status: result.status,
            records: result.totalRecords,
            hwmEnd: result.hwmEnd?.toISOString(),
          },
          `${resource} cycle completed`,
        );
      } catch (err) {
        logger.error({ err, resource }, `${resource} cycle failed`);
      } finally {
        state.running = false;
      }

      // Wait cadence after completion
      if (isRunning) {
        const cadence = cadences[resource];
        logger.debug({ resource, cadenceMs: cadence }, `Waiting before next ${resource} cycle`);
        await sleep(cadence);
      }
    }
  }

  /**
   * Run the initial import in dependency order:
   * Property → (Member + Office in parallel) → OpenHouse
   * Lookup can run at any time.
   */
  async function runInitialImport(): Promise<void> {
    logger.info('Starting initial import sequence');

    // Check if initial import is needed by looking for any completed runs
    const db = getDb();
    const existingRuns = await db
      .select({ id: replicationRuns.id })
      .from(replicationRuns)
      .where(eq(replicationRuns.status, 'completed'))
      .limit(1);

    if (existingRuns.length > 0) {
      logger.info('Previous completed runs found — skipping initial import sequence');
      initialImportComplete = true;
      return;
    }

    // Step 1: Property (must complete first — parent for FKs)
    logger.info('Initial import: Property');
    await runReplicationCycle('Property');

    // Step 2: Member + Office in parallel (independent of each other)
    logger.info('Initial import: Member + Office (parallel)');
    await Promise.all([
      runReplicationCycle('Member'),
      runReplicationCycle('Office'),
    ]);

    // Step 3: OpenHouse (depends on Property)
    logger.info('Initial import: OpenHouse');
    await runReplicationCycle('OpenHouse');

    // Step 4: Lookup (independent, can run anytime)
    logger.info('Initial import: Lookup');
    await runReplicationCycle('Lookup');

    initialImportComplete = true;
    logger.info('Initial import sequence complete');
  }

  /**
   * Daily cleanup job: hard-delete records where deleted_at > 30 days.
   */
  async function runCleanupJob(): Promise<void> {
    const db = getDb();
    const logger = getLogger();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    try {
      // Find properties to hard-delete
      const toDelete = await db
        .select({ listingKey: properties.listingKey })
        .from(properties)
        .where(
          and(
            isNotNull(properties.deletedAt),
            lt(properties.deletedAt, thirtyDaysAgo),
          ),
        );

      if (toDelete.length === 0) {
        logger.info('Cleanup job: no records to hard-delete');
        return;
      }

      const keys = toDelete.map((r) => r.listingKey);
      logger.info({ count: keys.length }, 'Cleanup job: hard-deleting old soft-deleted records');

      // Cascade delete across all related tables
      for (const key of keys) {
        await db.delete(propertyChangeLog).where(eq(propertyChangeLog.listingKey, key));
        await db.delete(statusHistory).where(eq(statusHistory.listingKey, key));
        await db.delete(priceHistory).where(eq(priceHistory.listingKey, key));
        await db.delete(media).where(eq(media.listingKey, key));
        await db.delete(rooms).where(eq(rooms.listingKey, key));
        await db.delete(unitTypes).where(eq(unitTypes.listingKey, key));
        await db.delete(rawResponses).where(eq(rawResponses.listingKey, key));
        await db.delete(properties).where(eq(properties.listingKey, key));
      }

      logger.info({ count: keys.length }, 'Cleanup job: hard-delete complete');
    } catch (err) {
      logger.error({ err }, 'Cleanup job failed');
    }
  }

  return {
    async start(): Promise<void> {
      isRunning = true;

      // Initialize shared services
      createRateLimiter();
      createR2Client();
      createMediaDownloader(); // Initialize singleton (kept for potential fallback use)

      // Initialize rate limiter from DB history (for restart recovery)
      // This is a best-effort initialization — empty counters are safe
      try {
        const db = getDb();
        const oneHourAgo = new Date(Date.now() - 3_600_000);
        const oneDayAgo = new Date(Date.now() - 86_400_000);

        // Load recent API request timestamps
        const recentRequests = await db
          .select({ requestedAt: sql<string>`requested_at` })
          .from(sql`replication_requests`)
          .where(sql`requested_at > ${oneDayAgo}`);

        // Load recent media download bytes
        const recentMedia = await db
          .select({
            downloadedAt: sql<string>`downloaded_at`,
            bytes: sql<number>`file_size_bytes`,
          })
          .from(sql`media_downloads`)
          .where(sql`downloaded_at > ${oneHourAgo} AND status = 'success'`);

        const rateLimiter = createRateLimiter();
        rateLimiter.initializeFromHistory(
          recentRequests.map((r) => new Date(r.requestedAt)),
          recentMedia
            .filter((r) => r.bytes != null)
            .map((r) => ({ timestamp: new Date(r.downloadedAt), bytes: r.bytes })),
        );
      } catch (err) {
        logger.warn({ err }, 'Failed to initialize rate limiter from history (starting fresh)');
      }

      // Media is primarily downloaded inline during record processing (URLs expire ~11h).
      // The decoupled media download loop runs as a fallback to process any
      // pending_download rows from previous runs or edge cases.
      const downloader = getMediaDownloader();
      await downloader.start();

      // Recover any failed/expired media from previous runs before starting replication.
      // This fetches fresh MediaURLs from the API for expired items and re-downloads them.
      // Rate limits are honoured automatically via the shared downloadMedia()/fetchPage() helpers.
      await downloader.recoverFailedMedia();

      // Run initial import if needed
      await runInitialImport();

      // Start independent scheduler loops for each resource
      logger.info('Starting independent resource scheduler loops');

      // Fire-and-forget — each loop runs independently
      runResourceLoop('Property');
      runResourceLoop('Member');
      runResourceLoop('Office');
      runResourceLoop('OpenHouse');
      runResourceLoop('Lookup');

      // Schedule daily cleanup (runs alongside Lookup cadence)
      (async () => {
        while (isRunning) {
          await sleep(cadences.Lookup); // Once daily
          if (isRunning) {
            await runCleanupJob();
          }
        }
      })();
    },

    async stop(): Promise<void> {
      isRunning = false;
      logger.info('Scheduler stopping — waiting for active cycles to complete');

      // Wait for all active cycles to finish
      const maxWait = 60_000; // 60 seconds max
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        const anyRunning = Object.values(resourceStates).some((s) => s.running);
        if (!anyRunning) break;
        await sleep(1000);
      }

      // Stop media downloader
      try {
        getMediaDownloader().stop();
      } catch {
        // Already stopped or never started
      }

      logger.info('Scheduler stopped');
    },

    getState() {
      return {
        isRunning,
        initialImportComplete,
        resources: { ...resourceStates },
      };
    },
  };
}
