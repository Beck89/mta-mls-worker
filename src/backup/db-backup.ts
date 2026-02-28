import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { PassThrough } from 'node:stream';
import { Upload } from '@aws-sdk/lib-storage';
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getEnv } from '../config/env.js';
import { getLogger } from '../lib/logger.js';

let _backupS3: S3Client | null = null;

/**
 * Get or create a dedicated S3 client for the backup bucket.
 * Uses the same R2 credentials but targets the backup bucket.
 */
function getBackupS3Client(): S3Client {
  if (_backupS3) return _backupS3;

  const env = getEnv();

  _backupS3 = new S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });

  return _backupS3;
}

/**
 * Run a full database backup using pg_dump and stream it to R2.
 *
 * Flow: pg_dump → gzip → S3 multipart upload
 *
 * Uses `--format=custom` for efficient, restorable backups.
 * The output is gzipped and streamed directly — no temp files on disk.
 */
export async function runDatabaseBackup(): Promise<{ key: string; durationMs: number }> {
  const logger = getLogger();
  const env = getEnv();
  const start = Date.now();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const objectKey = `mta-mls-${timestamp}.dump.gz`;

  logger.info({ objectKey }, 'Starting database backup');

  return new Promise<{ key: string; durationMs: number }>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    // Spawn pg_dump streaming to stdout
    const pgDump = spawn('pg_dump', [
      env.DATABASE_URL,
      '--format=custom',
      '--compress=0', // We gzip the stream ourselves for streaming upload
      '--no-owner',
      '--no-privileges',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderrChunks: Buffer[] = [];

    pgDump.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    // Create gzip transform and passthrough for the upload
    const gzip = createGzip({ level: 6 });
    const passthrough = new PassThrough();

    pgDump.stdout.pipe(gzip).pipe(passthrough);

    // Multipart upload to R2 (streams — no temp file needed)
    const upload = new Upload({
      client: getBackupS3Client(),
      params: {
        Bucket: env.BACKUP_R2_BUCKET_NAME,
        Key: objectKey,
        Body: passthrough,
        ContentType: 'application/gzip',
        ContentDisposition: `attachment; filename="${objectKey}"`,
      },
      queueSize: 4,
      partSize: 10 * 1024 * 1024, // 10 MB parts
    });

    // Start the upload IMMEDIATELY so it drains the passthrough stream.
    // Without this, pg_dump blocks on stdout once the pipe buffer fills
    // because nobody is consuming the other end — a deadlock.
    const uploadPromise = upload.done();

    // If the upload fails mid-stream, kill pg_dump and reject early
    uploadPromise.catch((uploadErr) => {
      logger.error({ err: uploadErr }, 'Backup upload to R2 failed');
      pgDump.kill();
      fail(uploadErr as Error);
    });

    // Handle pg_dump exit
    pgDump.on('close', async (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString();
        const err = new Error(`pg_dump exited with code ${code}: ${stderr}`);
        logger.error({ err, code, stderr }, 'pg_dump failed');
        fail(err);
        return;
      }

      try {
        // pg_dump finished — wait for the remaining upload parts to flush
        await uploadPromise;
        const durationMs = Date.now() - start;
        logger.info({ objectKey, durationMs }, 'Database backup completed');
        if (!settled) {
          settled = true;
          resolve({ key: objectKey, durationMs });
        }
      } catch (uploadErr) {
        // Already handled by the uploadPromise.catch above
      }
    });

    pgDump.on('error', (err) => {
      logger.error({ err }, 'Failed to spawn pg_dump');
      fail(err);
    });
  });
}

/**
 * Parse a backup timestamp from an object key.
 * Expected format: mta-mls-2026-02-26T23-00-00-000Z.dump.gz
 */
function parseBackupTimestamp(key: string): Date | null {
  // Extract the timestamp portion: 2026-02-26T23-00-00-000Z
  const match = key.match(/mta-mls-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
  if (!match) return null;

  // Convert back to ISO format: 2026-02-26T23:00:00.000Z
  const isoString = match[1]
    .replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/, '$1:$2:$3.$4');

  const date = new Date(isoString);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Tiered retention pruning for database backups.
 *
 * Retention tiers:
 * - 0–24 hours:  Keep every hourly backup
 * - 1–30 days:   Keep only the latest backup per calendar day (UTC)
 * - 30+ days:    Keep only the latest backup per calendar month (UTC)
 *
 * Returns the number of backups deleted.
 */
export async function pruneBackups(): Promise<number> {
  const logger = getLogger();
  const env = getEnv();
  const s3 = getBackupS3Client();
  const now = Date.now();

  // List all backup objects in the bucket
  const allObjects: { key: string; timestamp: Date }[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: env.BACKUP_R2_BUCKET_NAME,
      ContinuationToken: continuationToken,
    }));

    for (const obj of response.Contents ?? []) {
      if (!obj.Key) continue;
      const ts = parseBackupTimestamp(obj.Key);
      if (ts) {
        allObjects.push({ key: obj.Key, timestamp: ts });
      }
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  if (allObjects.length === 0) {
    logger.debug('No backups found to prune');
    return 0;
  }

  // Sort all backups by timestamp descending (newest first)
  allObjects.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  const toDelete: string[] = [];

  // Group backups by tier and determine which to keep
  const dailyKeepers = new Map<string, { key: string; timestamp: Date }>(); // "2026-02-25" → latest
  const monthlyKeepers = new Map<string, { key: string; timestamp: Date }>(); // "2026-01" → latest

  for (const backup of allObjects) {
    const ageMs = now - backup.timestamp.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    const ageDays = ageHours / 24;

    if (ageHours < 24) {
      // Tier 1: Keep all hourly backups < 24 hours old
      continue;
    }

    if (ageDays <= 30) {
      // Tier 2: Keep only the latest backup per calendar day
      const dayKey = backup.timestamp.toISOString().slice(0, 10); // "2026-02-25"

      if (!dailyKeepers.has(dayKey)) {
        // First (latest) backup for this day — keep it
        dailyKeepers.set(dayKey, backup);
      } else {
        // Not the latest for this day — mark for deletion
        toDelete.push(backup.key);
      }
      continue;
    }

    // Tier 3: 30+ days — keep only the latest backup per calendar month
    const monthKey = backup.timestamp.toISOString().slice(0, 7); // "2026-01"

    if (!monthlyKeepers.has(monthKey)) {
      // First (latest) backup for this month — keep it
      monthlyKeepers.set(monthKey, backup);
    } else {
      // Not the latest for this month — mark for deletion
      toDelete.push(backup.key);
    }
  }

  if (toDelete.length === 0) {
    logger.debug({ totalBackups: allObjects.length }, 'No backups to prune');
    return 0;
  }

  // Delete in batches of 1,000 (S3 limit)
  for (let i = 0; i < toDelete.length; i += 1000) {
    const chunk = toDelete.slice(i, i + 1000);
    await s3.send(new DeleteObjectsCommand({
      Bucket: env.BACKUP_R2_BUCKET_NAME,
      Delete: {
        Objects: chunk.map((key) => ({ Key: key })),
        Quiet: true,
      },
    }));
  }

  logger.info(
    {
      deleted: toDelete.length,
      remaining: allObjects.length - toDelete.length,
      hourlyCount: allObjects.filter((b) => (now - b.timestamp.getTime()) < 24 * 60 * 60 * 1000).length,
      dailyCount: dailyKeepers.size,
      monthlyCount: monthlyKeepers.size,
    },
    'Backup pruning complete',
  );

  return toDelete.length;
}
