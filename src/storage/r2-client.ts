import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getEnv } from '../config/env.js';
import { getLogger } from '../lib/logger.js';

let _s3: S3Client | null = null;

export function createR2Client(): S3Client {
  if (_s3) return _s3;

  const env = getEnv();

  _s3 = new S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });

  getLogger().info('R2 client initialized');
  return _s3;
}

export function getR2Client(): S3Client {
  if (!_s3) {
    throw new Error('R2 client not initialized. Call createR2Client() first.');
  }
  return _s3;
}

/**
 * Upload a media file to R2.
 * Key structure: {resource_type}/{parent_key}/{media_key}.{extension}
 */
export async function uploadToR2(
  objectKey: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const env = getEnv();
  const s3 = getR2Client();

  await s3.send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: objectKey,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/**
 * Delete a single object from R2.
 */
export async function deleteFromR2(objectKey: string): Promise<void> {
  const env = getEnv();
  const s3 = getR2Client();

  await s3.send(
    new DeleteObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: objectKey,
    }),
  );
}

/**
 * Delete multiple objects from R2 in a single batch request.
 * S3 batch delete supports up to 1,000 keys per request.
 */
export async function batchDeleteFromR2(objectKeys: string[]): Promise<void> {
  if (objectKeys.length === 0) return;

  const env = getEnv();
  const s3 = getR2Client();
  const logger = getLogger();

  // Process in chunks of 1,000
  for (let i = 0; i < objectKeys.length; i += 1000) {
    const chunk = objectKeys.slice(i, i + 1000);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: env.R2_BUCKET_NAME,
        Delete: {
          Objects: chunk.map((key) => ({ Key: key })),
          Quiet: true,
        },
      }),
    );
    logger.debug({ count: chunk.length }, 'R2 batch delete completed');
  }
}

/**
 * Build the R2 object key for a media file.
 * Format: {resource_type}/{parent_key}/{media_key}.{extension}
 */
export function buildR2ObjectKey(
  resourceType: string,
  parentKey: string,
  mediaKey: string,
  contentType: string,
): string {
  const ext = getExtensionFromContentType(contentType);
  return `${resourceType}/${parentKey}/${mediaKey}.${ext}`;
}

/**
 * Build the publicly-accessible URL for a media file.
 * Uses the custom domain configured in R2_PUBLIC_DOMAIN.
 * Example: https://mls-media.movingtoaustin.com/Property/ACT107472571/ACTmedia123.jpg
 */
export function buildPublicUrl(r2ObjectKey: string): string {
  const env = getEnv();
  return `https://${env.R2_PUBLIC_DOMAIN}/${r2ObjectKey}`;
}

function getExtensionFromContentType(contentType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'application/pdf': 'pdf',
  };
  return map[contentType.toLowerCase()] ?? 'jpg';
}
