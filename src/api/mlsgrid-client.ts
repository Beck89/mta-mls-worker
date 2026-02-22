import { getEnv } from '../config/env.js';
import { getLogger } from '../lib/logger.js';
import { getRateLimiter } from '../lib/rate-limiter.js';
import { getDb } from '../db/connection.js';
import { replicationRequests } from '../db/schema/monitoring.js';

export type ResourceType = 'Property' | 'Member' | 'Office' | 'OpenHouse' | 'Lookup';

export interface MlsGridPageResult<T = Record<string, unknown>> {
  value: T[];
  nextLink: string | null;
  responseBytes: number;
  responseTimeMs: number;
}

interface MlsGridResponse {
  '@odata.context'?: string;
  '@odata.nextLink'?: string;
  value: Record<string, unknown>[];
}

/**
 * Build the initial import URL for a resource type.
 * Initial import uses MlgCanView eq true to skip deleted records.
 */
export function buildInitialImportUrl(
  resource: ResourceType,
  originatingSystem: string,
): string {
  const env = getEnv();
  const base = env.MLSGRID_API_BASE_URL;

  const filter = `OriginatingSystemName eq '${originatingSystem}' and MlgCanView eq true`;
  const expand = getExpandParam(resource);
  const top = expand ? 1000 : 5000;

  let url = `${base}/${resource}?$filter=${encodeURIComponent(filter)}&$top=${top}`;
  if (expand) {
    url += `&$expand=${expand}`;
  }
  return url;
}

/**
 * Build the replication URL for a resource type.
 * Replication does NOT filter by MlgCanView — we need to see deletes.
 */
export function buildReplicationUrl(
  resource: ResourceType,
  originatingSystem: string,
  hwm: Date,
  useGe: boolean = false,
): string {
  const env = getEnv();
  const base = env.MLSGRID_API_BASE_URL;

  const operator = useGe ? 'ge' : 'gt';
  const timestamp = hwm.toISOString();
  const filter = `OriginatingSystemName eq '${originatingSystem}' and ModificationTimestamp ${operator} ${timestamp}`;
  const expand = getExpandParam(resource);
  const top = expand ? 1000 : 5000;

  let url = `${base}/${resource}?$filter=${encodeURIComponent(filter)}&$top=${top}`;
  if (expand) {
    url += `&$expand=${expand}`;
  }
  return url;
}

/**
 * Fetch a single page of data from MLS Grid.
 * Handles rate limiting, logging, and request tracking.
 */
export async function fetchPage<T = Record<string, unknown>>(
  url: string,
  runId: number,
): Promise<MlsGridPageResult<T>> {
  const env = getEnv();
  const logger = getLogger();
  const rateLimiter = getRateLimiter();

  // Wait for rate limiter approval
  await rateLimiter.waitForApiSlot();

  const startTime = Date.now();
  let httpStatus = 0;
  let responseBytes = 0;
  let recordsReturned = 0;
  let errorMessage: string | null = null;

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.MLSGRID_API_TOKEN}`,
        'Accept-Encoding': 'gzip',
      },
    });

    httpStatus = response.status;

    if (response.status === 429) {
      // Rate limited by MLS Grid
      logger.error({ url, status: 429 }, 'MLS Grid rate limit hit (HTTP 429)');
      throw new MlsGridRateLimitError('MLS Grid returned 429 — rate limited');
    }

    if (!response.ok) {
      const body = await response.text();
      throw new MlsGridApiError(
        `MLS Grid API error: ${response.status} ${response.statusText}`,
        response.status,
        body,
      );
    }

    const rawBody = await response.text();
    responseBytes = new TextEncoder().encode(rawBody).length;
    const data = JSON.parse(rawBody) as MlsGridResponse;

    recordsReturned = data.value?.length ?? 0;
    const nextLink = data['@odata.nextLink'] ?? null;

    const responseTimeMs = Date.now() - startTime;

    logger.debug(
      {
        url: url.substring(0, 120),
        records: recordsReturned,
        bytes: responseBytes,
        timeMs: responseTimeMs,
        hasNextLink: !!nextLink,
      },
      'MLS Grid page fetched',
    );

    return {
      value: data.value as T[],
      nextLink,
      responseBytes,
      responseTimeMs,
    };
  } catch (err) {
    if (err instanceof MlsGridRateLimitError || err instanceof MlsGridApiError) {
      errorMessage = (err as Error).message;
      throw err;
    }
    errorMessage = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    // Log the request to the monitoring table
    const responseTimeMs = Date.now() - startTime;
    try {
      const db = getDb();
      await db.insert(replicationRequests).values({
        runId,
        requestUrl: url,
        httpStatus: httpStatus || null,
        responseTimeMs,
        responseBytes: responseBytes || null,
        recordsReturned: recordsReturned || null,
        requestedAt: new Date(),
        errorMessage,
      });
    } catch (logErr) {
      logger.warn({ err: logErr }, 'Failed to log replication request');
    }
  }
}

/**
 * Iterate through all pages for a given URL, yielding each page's records.
 */
export async function* fetchAllPages<T = Record<string, unknown>>(
  initialUrl: string,
  runId: number,
): AsyncGenerator<MlsGridPageResult<T>> {
  let url: string | null = initialUrl;

  while (url) {
    const result: MlsGridPageResult<T> = await fetchPage<T>(url, runId);
    yield result;
    url = result.nextLink;
  }
}

/**
 * Download a media file from a MediaURL. Returns the response body as a buffer.
 * Media downloads do NOT count against API request limits but DO count against bandwidth.
 */
export async function downloadMedia(
  mediaUrl: string,
): Promise<{ buffer: Buffer; contentType: string; bytes: number }> {
  const rateLimiter = getRateLimiter();
  const logger = getLogger();

  // Check media bandwidth (not API request count)
  await rateLimiter.waitForMediaSlot();

  const response = await fetch(mediaUrl);

  if (!response.ok) {
    throw new MlsGridApiError(
      `Media download failed: ${response.status} ${response.statusText}`,
      response.status,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = response.headers.get('content-type') ?? 'image/jpeg';
  const bytes = buffer.length;

  // Record bytes for bandwidth tracking
  rateLimiter.recordMediaDownload(bytes);

  logger.debug(
    { url: mediaUrl.substring(0, 80), bytes, contentType },
    'Media file downloaded',
  );

  return { buffer, contentType, bytes };
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function getExpandParam(resource: ResourceType): string | null {
  switch (resource) {
    case 'Property':
      return 'Media,Rooms,UnitTypes';
    case 'Member':
    case 'Office':
      return 'Media';
    default:
      return null;
  }
}

// ─── Error Classes ───────────────────────────────────────────────────────────

export class MlsGridApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = 'MlsGridApiError';
  }
}

export class MlsGridRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MlsGridRateLimitError';
  }
}
