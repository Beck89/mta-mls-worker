import { getLogger } from './logger.js';

/**
 * Two-dimension sliding window rate limiter.
 *
 * Dimension 1: API request counts (api.mlsgrid.com only)
 *   - 2 requests per second (soft cap 1.5)
 *   - 7,200 requests per hour (soft cap 6,000)
 *   - 40,000 requests per 24 hours (soft cap 35,000)
 *
 * Dimension 2: Media download bytes (CDN, not API endpoint)
 *   - 4 GB per hour (soft cap 3.5 GB)
 */

const ONE_SECOND = 1_000;
const ONE_HOUR = 3_600_000;
const ONE_DAY = 86_400_000;

const LIMITS = {
  api: {
    perSecond: { hard: 2, soft: 1.5 },
    perHour: { hard: 7_200, soft: 6_000 },
    perDay: { hard: 40_000, soft: 35_000 },
  },
  media: {
    bytesPerHour: { hard: 4 * 1024 * 1024 * 1024, soft: 3.5 * 1024 * 1024 * 1024 }, // 4 GB / 3.5 GB
  },
} as const;

interface TimestampedEntry {
  timestamp: number;
  bytes?: number;
}

export class RateLimiter {
  private apiRequests: TimestampedEntry[] = [];
  private mediaDownloads: TimestampedEntry[] = [];

  /**
   * Initialize counters from database records (for restart recovery).
   */
  initializeFromHistory(
    apiRequestTimestamps: Date[],
    mediaDownloadEntries: Array<{ timestamp: Date; bytes: number }>,
  ): void {
    const now = Date.now();
    const dayAgo = now - ONE_DAY;

    this.apiRequests = apiRequestTimestamps
      .map((ts) => ({ timestamp: ts.getTime() }))
      .filter((e) => e.timestamp > dayAgo);

    this.mediaDownloads = mediaDownloadEntries
      .map((e) => ({ timestamp: e.timestamp.getTime(), bytes: e.bytes }))
      .filter((e) => e.timestamp > now - ONE_HOUR);

    const logger = getLogger();
    logger.info(
      {
        apiRequestsInWindow: this.apiRequests.length,
        mediaDownloadsInWindow: this.mediaDownloads.length,
      },
      'Rate limiter initialized from history',
    );
  }

  /**
   * Check if an API request can proceed. Returns wait time in ms (0 = proceed).
   */
  checkApiRequest(): number {
    this.pruneApiRequests();
    const now = Date.now();

    // Check 1-second window
    const lastSecond = this.apiRequests.filter((e) => e.timestamp > now - ONE_SECOND);
    if (lastSecond.length >= LIMITS.api.perSecond.hard) {
      const oldestInWindow = Math.min(...lastSecond.map((e) => e.timestamp));
      return oldestInWindow + ONE_SECOND - now + 50; // +50ms buffer
    }

    // Check hourly window
    const lastHour = this.apiRequests.filter((e) => e.timestamp > now - ONE_HOUR);
    if (lastHour.length >= LIMITS.api.perHour.hard) {
      return ONE_HOUR; // Wait a full hour (will be rechecked)
    }

    // Check daily window
    const lastDay = this.apiRequests.filter((e) => e.timestamp > now - ONE_DAY);
    if (lastDay.length >= LIMITS.api.perDay.hard) {
      return ONE_HOUR; // Wait and recheck
    }

    // Soft cap warnings
    if (lastSecond.length >= LIMITS.api.perSecond.soft) {
      return 200; // Brief pause at soft cap
    }
    if (lastHour.length >= LIMITS.api.perHour.soft) {
      return 2_000; // 2s pause approaching hourly limit
    }
    if (lastDay.length >= LIMITS.api.perDay.soft) {
      return 5_000; // 5s pause approaching daily limit
    }

    return 0;
  }

  /**
   * Record an API request.
   */
  recordApiRequest(): void {
    this.apiRequests.push({ timestamp: Date.now() });
  }

  /**
   * Check if a media download can proceed. Returns wait time in ms (0 = proceed).
   */
  checkMediaDownload(): number {
    this.pruneMediaDownloads();
    const now = Date.now();

    const lastHourBytes = this.mediaDownloads
      .filter((e) => e.timestamp > now - ONE_HOUR)
      .reduce((sum, e) => sum + (e.bytes ?? 0), 0);

    if (lastHourBytes >= LIMITS.media.bytesPerHour.hard) {
      return ONE_HOUR; // Wait and recheck
    }

    if (lastHourBytes >= LIMITS.media.bytesPerHour.soft) {
      return 10_000; // 10s pause approaching bandwidth limit
    }

    return 0;
  }

  /**
   * Record a media download.
   */
  recordMediaDownload(bytes: number): void {
    this.mediaDownloads.push({ timestamp: Date.now(), bytes });
  }

  /**
   * Wait until an API request is allowed, then record it.
   */
  async waitForApiSlot(): Promise<void> {
    let waitMs = this.checkApiRequest();
    while (waitMs > 0) {
      const logger = getLogger();
      logger.warn({ waitMs }, 'Rate limiter: waiting for API slot');
      await sleep(waitMs);
      waitMs = this.checkApiRequest();
    }
    this.recordApiRequest();
  }

  /**
   * Wait until a media download is allowed.
   */
  async waitForMediaSlot(): Promise<void> {
    let waitMs = this.checkMediaDownload();
    while (waitMs > 0) {
      const logger = getLogger();
      logger.warn({ waitMs }, 'Rate limiter: waiting for media bandwidth slot');
      await sleep(waitMs);
      waitMs = this.checkMediaDownload();
    }
  }

  /**
   * Get current usage stats for health check reporting.
   */
  getUsageStats() {
    this.pruneApiRequests();
    this.pruneMediaDownloads();
    const now = Date.now();

    const apiLastSecond = this.apiRequests.filter((e) => e.timestamp > now - ONE_SECOND).length;
    const apiLastHour = this.apiRequests.filter((e) => e.timestamp > now - ONE_HOUR).length;
    const apiLastDay = this.apiRequests.filter((e) => e.timestamp > now - ONE_DAY).length;
    const mediaLastHourBytes = this.mediaDownloads
      .filter((e) => e.timestamp > now - ONE_HOUR)
      .reduce((sum, e) => sum + (e.bytes ?? 0), 0);

    return {
      api: {
        lastSecond: { current: apiLastSecond, limit: LIMITS.api.perSecond.hard },
        lastHour: { current: apiLastHour, limit: LIMITS.api.perHour.hard },
        lastDay: { current: apiLastDay, limit: LIMITS.api.perDay.hard },
      },
      media: {
        lastHourBytes: {
          current: mediaLastHourBytes,
          limit: LIMITS.media.bytesPerHour.hard,
          percentUsed: Math.round((mediaLastHourBytes / LIMITS.media.bytesPerHour.hard) * 100),
        },
      },
    };
  }

  private pruneApiRequests(): void {
    const cutoff = Date.now() - ONE_DAY;
    this.apiRequests = this.apiRequests.filter((e) => e.timestamp > cutoff);
  }

  private pruneMediaDownloads(): void {
    const cutoff = Date.now() - ONE_HOUR;
    this.mediaDownloads = this.mediaDownloads.filter((e) => e.timestamp > cutoff);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Singleton instance shared across all resource schedulers
let _rateLimiter: RateLimiter | null = null;

export function createRateLimiter(): RateLimiter {
  if (_rateLimiter) return _rateLimiter;
  _rateLimiter = new RateLimiter();
  return _rateLimiter;
}

export function getRateLimiter(): RateLimiter {
  if (!_rateLimiter) {
    throw new Error('Rate limiter not initialized. Call createRateLimiter() first.');
  }
  return _rateLimiter;
}
