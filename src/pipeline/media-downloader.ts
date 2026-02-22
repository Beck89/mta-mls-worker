import { eq } from 'drizzle-orm';
import { getDb } from '../db/connection.js';
import { media } from '../db/schema/media.js';
import { mediaDownloads } from '../db/schema/monitoring.js';
import { downloadMedia } from '../api/mlsgrid-client.js';
import { uploadToR2, buildR2ObjectKey, buildPublicUrl } from '../storage/r2-client.js';
import { getLogger } from '../lib/logger.js';
import { getEnv } from '../config/env.js';

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 2_000;

/**
 * Media download loop — runs continuously alongside record processing.
 * Polls for media rows with status = 'pending_download' and processes them
 * with controlled concurrency.
 */
export class MediaDownloader {
  private running = false;
  private activeDownloads = 0;
  private currentRunId: number | null = null;

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
        // Poll for pending downloads
        const db = getDb();
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
          .limit(concurrency - this.activeDownloads);

        if (pending.length === 0) {
          // No work — sleep briefly and check again
          await sleep(2_000);
          continue;
        }

        // Process downloads concurrently
        const promises = pending.map((row) => this.downloadOne(row));
        await Promise.allSettled(promises);
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
      const newRetryCount = row.retryCount + 1;

      if (newRetryCount >= MAX_RETRIES) {
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
