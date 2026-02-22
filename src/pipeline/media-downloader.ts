import { eq } from 'drizzle-orm';
import { getDb } from '../db/connection.js';
import { media } from '../db/schema/media.js';
import { mediaDownloads } from '../db/schema/monitoring.js';
import { downloadMedia, MlsGridApiError } from '../api/mlsgrid-client.js';
import { uploadToR2, buildR2ObjectKey, buildPublicUrl } from '../storage/r2-client.js';
import { getLogger } from '../lib/logger.js';
import { getEnv } from '../config/env.js';

const MAX_RETRIES = 5; // Increased from 3 for 429 resilience
const BACKOFF_BASE_MS = 2_000;
const STAGGER_DELAY_MS = 200; // Delay between starting concurrent downloads
const INITIAL_RATE_LIMIT_PAUSE_MS = 5 * 60_000; // 5 minute pause when 429 detected
const MAX_RATE_LIMIT_PAUSE_MS = 15 * 60_000; // Max 15 minute pause

/**
 * Media download loop — runs continuously alongside record processing.
 * Polls for media rows with status = 'pending_download' and processes them
 * with controlled concurrency and staggered starts.
 */
export class MediaDownloader {
  private running = false;
  private activeDownloads = 0;
  private currentRunId: number | null = null;
  private rateLimitPauseUntil = 0; // Timestamp when 429 pause expires
  private currentPauseMs = INITIAL_RATE_LIMIT_PAUSE_MS; // Progressive backoff

  async start(): Promise<void> {
    this.running = true;
    const logger = getLogger();
    logger.info('Media download loop started');
    this.loop();
  }

  stop(): void {
    this.running = false;
    getLogger().info('Media download loop stopping');
  }

  setRunId(runId: number): void {
    this.currentRunId = runId;
  }

  private async loop(): Promise<void> {
    const logger = getLogger();
    const env = getEnv();
    const concurrency = env.WORKER_MEDIA_CONCURRENCY;

    while (this.running) {
      try {
        // Check if we're in a 429 pause
        if (Date.now() < this.rateLimitPauseUntil) {
          const remaining = Math.ceil((this.rateLimitPauseUntil - Date.now()) / 1000);
          logger.info({ remainingSeconds: remaining }, 'Media downloads paused (429 backoff)');
          await sleep(10_000); // Check every 10s
          continue;
        }

        // Poll for pending downloads
        const db = getDb();
        const availableSlots = Math.max(1, concurrency - this.activeDownloads);
        const pending = await db
          .select({
            mediaKey: media.mediaKey,
            listingKey: media.listingKey,
            resourceType: media.resourceType,
            mediaUrlSource: media.mediaUrlSource,
            retryCount: media.retryCount,
          })
          .from(media)
          .where(eq(media.status, 'pending_download'))
          .limit(availableSlots);

        if (pending.length === 0) {
          // No work — sleep briefly and check again
          await sleep(5_000);
          continue;
        }

        // Process downloads with staggered starts to avoid burst
        for (const row of pending) {
          if (!this.running || Date.now() < this.rateLimitPauseUntil) break;

          // Don't exceed concurrency
          while (this.activeDownloads >= concurrency && this.running) {
            await sleep(500);
          }

          // Fire off download (don't await — runs concurrently)
          this.downloadOne(row);

          // Stagger: brief delay before starting next download
          await sleep(STAGGER_DELAY_MS);
        }

        // Wait for current batch to finish before polling again
        while (this.activeDownloads > 0 && this.running) {
          await sleep(1_000);
        }
      } catch (err) {
        logger.error({ err }, 'Media download loop error');
        await sleep(5_000);
      }
    }
  }

  private async downloadOne(row: {
    mediaKey: string;
    listingKey: string;
    resourceType: string;
    mediaUrlSource: string | null;
    retryCount: number;
  }): Promise<void> {
    const db = getDb();
    const logger = getLogger();
    this.activeDownloads++;

    const downloadStart = Date.now();
    let downloadTimeMs = 0;
    let r2UploadTimeMs = 0;
    let fileSizeBytes = 0;
    let status: 'success' | 'failed' | 'skipped' = 'failed';
    let errorMessage: string | null = null;

    try {
      if (!row.mediaUrlSource) {
        status = 'skipped';
        await db
          .update(media)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(eq(media.mediaKey, row.mediaKey));
        return;
      }

      // Download from MLS Grid MediaURL
      const downloadResult = await downloadMedia(row.mediaUrlSource);
      downloadTimeMs = Date.now() - downloadStart;
      fileSizeBytes = downloadResult.bytes;

      // Build proper R2 key with actual content type
      const r2ObjectKey = buildR2ObjectKey(
        row.resourceType,
        row.listingKey,
        row.mediaKey,
        downloadResult.contentType,
      );

      // Upload to R2
      const uploadStart = Date.now();
      await uploadToR2(r2ObjectKey, downloadResult.buffer, downloadResult.contentType);
      r2UploadTimeMs = Date.now() - uploadStart;

      // Update media row to complete with public URL
      const publicUrl = buildPublicUrl(r2ObjectKey);
      await db
        .update(media)
        .set({
          status: 'complete',
          r2ObjectKey,
          publicUrl,
          fileSizeBytes,
          contentType: downloadResult.contentType,
          updatedAt: new Date(),
        })
        .where(eq(media.mediaKey, row.mediaKey));

      status = 'success';
      // Reset progressive backoff on success
      this.currentPauseMs = INITIAL_RATE_LIMIT_PAUSE_MS;

      logger.debug(
        {
          mediaKey: row.mediaKey,
          bytes: fileSizeBytes,
          downloadMs: downloadTimeMs,
          uploadMs: r2UploadTimeMs,
        },
        'Media downloaded and uploaded to R2',
      );
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      const is429 = err instanceof MlsGridApiError && err.statusCode === 429;
      const newRetryCount = row.retryCount + 1;

      if (is429) {
        // 429 from CDN — pause ALL media downloads with progressive backoff
        this.rateLimitPauseUntil = Date.now() + this.currentPauseMs;
        logger.warn(
          { mediaKey: row.mediaKey, pauseMs: this.currentPauseMs },
          'Media CDN rate limit (429) — pausing all media downloads',
        );
        // Double the pause for next 429, up to max
        this.currentPauseMs = Math.min(this.currentPauseMs * 2, MAX_RATE_LIMIT_PAUSE_MS);

        // Don't increment retry count for 429 — it's not a permanent failure
        // Just leave it as pending_download for retry after pause
        await db
          .update(media)
          .set({ updatedAt: new Date() })
          .where(eq(media.mediaKey, row.mediaKey));
      } else if (newRetryCount >= MAX_RETRIES) {
        // Max retries exceeded — mark as failed
        await db
          .update(media)
          .set({
            status: 'failed',
            retryCount: newRetryCount,
            updatedAt: new Date(),
          })
          .where(eq(media.mediaKey, row.mediaKey));

        logger.error(
          { mediaKey: row.mediaKey, retries: newRetryCount, err: errorMessage },
          'Media download failed after max retries',
        );
      } else {
        // Retry with exponential backoff
        const backoffMs = BACKOFF_BASE_MS * Math.pow(2, newRetryCount);
        await db
          .update(media)
          .set({
            retryCount: newRetryCount,
            updatedAt: new Date(),
          })
          .where(eq(media.mediaKey, row.mediaKey));

        logger.warn(
          { mediaKey: row.mediaKey, retry: newRetryCount, backoffMs, err: errorMessage },
          'Media download failed — will retry',
        );

        await sleep(backoffMs);
      }
    } finally {
      this.activeDownloads--;

      // Log to media_downloads table
      try {
        await db.insert(mediaDownloads).values({
          runId: this.currentRunId,
          mediaKey: row.mediaKey,
          listingKey: row.listingKey,
          fileSizeBytes: fileSizeBytes || null,
          downloadTimeMs: downloadTimeMs || null,
          r2UploadTimeMs: r2UploadTimeMs || null,
          status,
          errorMessage,
          downloadedAt: new Date(),
        });
      } catch (logErr) {
        logger.warn({ err: logErr }, 'Failed to log media download');
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Singleton
let _downloader: MediaDownloader | null = null;

export function createMediaDownloader(): MediaDownloader {
  if (_downloader) return _downloader;
  _downloader = new MediaDownloader();
  return _downloader;
}

export function getMediaDownloader(): MediaDownloader {
  if (!_downloader) {
    throw new Error('Media downloader not initialized.');
  }
  return _downloader;
}
