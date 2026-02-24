import { getEnv } from '../config/env.js';
import { getLogger } from './logger.js';

/**
 * Two-dimension rate limiter.
 *
 * Dimension 1: API request counts (api.mlsgrid.com only) — sliding window
 *   - 2 requests per second (soft cap 1.5)
 *   - 7,200 requests per hour (soft cap 6,000)
 *   - 40,000 requests per 24 hours (soft cap 35,000)
 *
 * Dimension 2: Media download bytes (CDN, not API endpoint) — rolling 60-minute window
 *   Caps are configurable via WORKER_MEDIA_BANDWIDTH_HARD_CAP_GB / WORKER_MEDIA_BANDWIDTH_SOFT_CAP_GB.
 */

const ONE_SECOND = 1_000;
const ONE_HOUR = 3_600_000;
const ONE_DAY = 86_400_000;

const GB = 1024 * 1024 * 1024;

const API_LIMITS = {
  perSecond: { hard: 2, soft: 1.5 },
  perHour: { hard: 7_200, soft: 6_000 },
  perDay: { hard: 40_000, soft: 35_000 },
} as const;

function getMediaLimits() {
  const env = getEnv();
  return {
    hard: env.WORKER_MEDIA_BANDWIDTH_HARD_CAP_GB * GB,
    soft: env.WORKER_MEDIA_BANDWIDTH_SOFT_CAP_GB * GB,
  };
}

interface TimestampedEntry {
  timestamp: number;
  bytes?: number;
}

export class RateLimiter {
  private apiRequests: TimestampedEntry[] = [];
  private mediaDownloads: TimestampedEntry[] = [];
  private apiSlotLock: Promise<void> = Promise.resolve();

  /**
   * Initialize counters from database records (for restart recovery).
   */
  initializeFromHistory(
    apiRequestTimestamps: Date[],
    mediaDownloadEntries: Array<{ timestamp: Date; bytes: number }>,
  ): void {
    const now = Date.now();
    const dayAgo = now - ONE_DAY;
    const oneHourAgo = now - ONE_HOUR;

    this.apiRequests = apiRequestTimestamps
      .map((ts) => ({ timestamp: ts.getTime() }))
      .filter((e) => e.timestamp > dayAgo);

    // Load entries from the rolling 60-minute window
    this.mediaDownloads = mediaDownloadEntries
      .map((e) => ({ timestamp: e.timestamp.getTime(), bytes: Number(e.bytes) }))
      .filter((e) => e.timestamp >= oneHourAgo);

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
    if (lastSecond.length >= API_LIMITS.perSecond.hard) {
      const oldestInWindow = Math.min(...lastSecond.map((e) => e.timestamp));
      return oldestInWindow + ONE_SECOND - now + 50; // +50ms buffer
    }

    // Check hourly window
    const lastHour = this.apiRequests.filter((e) => e.timestamp > now - ONE_HOUR);
    if (lastHour.length >= API_LIMITS.perHour.hard) {
      return ONE_HOUR; // Wait a full hour (will be rechecked)
    }

    // Check daily window
    const lastDay = this.apiRequests.filter((e) => e.timestamp > now - ONE_DAY);
    if (lastDay.length >= API_LIMITS.perDay.hard) {
      return ONE_HOUR; // Wait and recheck
    }

    // Soft cap warnings
    if (lastSecond.length >= API_LIMITS.perSecond.soft) {
      return 200; // Brief pause at soft cap
    }
    if (lastHour.length >= API_LIMITS.perHour.soft) {
      return 2_000; // 2s pause approaching hourly limit
    }
    if (lastDay.length >= API_LIMITS.perDay.soft) {
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
   * Uses a fixed clock-hour window (resets at :00 each hour) to match MLS Grid's billing window.
   */
  checkMediaDownload(): number {
    this.pruneMediaDownloads();
    const now = Date.now();
    const oneHourAgo = now - ONE_HOUR;
    const mediaLimits = getMediaLimits();

    const rollingHourBytes = this.mediaDownloads
      .filter((e) => e.timestamp >= oneHourAgo)
      .reduce((sum, e) => sum + Number(e.bytes ?? 0), 0);

    if (rollingHourBytes >= mediaLimits.hard) {
      // Find the oldest entry in the window — wait until it falls out
      const oldest = Math.min(...this.mediaDownloads.filter((e) => e.timestamp >= oneHourAgo).map((e) => e.timestamp));
      const waitMs = oldest + ONE_HOUR - now + 100; // +100ms buffer
      return Math.max(waitMs, 1_000); // At least 1s
    }

    if (rollingHourBytes >= mediaLimits.soft) {
      return 10_000; // 10s pause approaching bandwidth limit
    }

    return 0;
  }

  /**
   * Record a media download.
   */
  recordMediaDownload(bytes: number): void {
    this.mediaDownloads.push({ timestamp: Date.now(), bytes: Number(bytes) });
  }

  /**
   * Wait until an API request is allowed, then record it.
   * Uses a promise-chain mutex to serialize concurrent callers and prevent
   * TOCTOU race conditions where multiple callers check simultaneously,
   * all see < 2 requests, and all proceed — causing bursts above the limit.
   */
  async waitForApiSlot(): Promise<void> {
    // Chain onto the previous caller's promise so only one caller
    // can check + record at a time.
    const previous = this.apiSlotLock;
    let resolve!: () => void;
    this.apiSlotLock = new Promise<void>((r) => { resolve = r; });

    await previous; // Wait for the previous caller to finish

    try {
      let waitMs = this.checkApiRequest();
      while (waitMs > 0) {
        const logger = getLogger();
        logger.warn({ waitMs }, 'Rate limiter: waiting for API slot');
        await sleep(waitMs);
        waitMs = this.checkApiRequest();
      }
      this.recordApiRequest();
    } finally {
      resolve(); // Release the lock for the next caller
    }
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
   * Media bytes use a rolling 60-minute window.
   */
  getUsageStats() {
    this.pruneApiRequests();
    this.pruneMediaDownloads();
    const now = Date.now();
    const oneHourAgo = now - ONE_HOUR;
    const mediaLimits = getMediaLimits();

    const apiLastSecond = this.apiRequests.filter((e) => e.timestamp > now - ONE_SECOND).length;
    const apiLastHour = this.apiRequests.filter((e) => e.timestamp > now - ONE_HOUR).length;
    const apiLastDay = this.apiRequests.filter((e) => e.timestamp > now - ONE_DAY).length;
    const mediaRollingHourBytes = this.mediaDownloads
      .filter((e) => e.timestamp >= oneHourAgo)
      .reduce((sum, e) => sum + Number(e.bytes ?? 0), 0);

    return {
      api: {
        lastSecond: { current: apiLastSecond, limit: API_LIMITS.perSecond.hard },
        lastHour: { current: apiLastHour, limit: API_LIMITS.perHour.hard },
        lastDay: { current: apiLastDay, limit: API_LIMITS.perDay.hard },
      },
      media: {
        currentHourBytes: {
          current: mediaRollingHourBytes,
          limit: mediaLimits.hard,
          softLimit: mediaLimits.soft,
          percentUsed: Math.round((mediaRollingHourBytes / mediaLimits.hard) * 100),
        },
      },
    };
  }

  private pruneApiRequests(): void {
    const cutoff = Date.now() - ONE_DAY;
    this.apiRequests = this.apiRequests.filter((e) => e.timestamp > cutoff);
  }

  private pruneMediaDownloads(): void {
    // Keep only entries from the rolling 60-minute window
    const cutoff = Date.now() - ONE_HOUR;
    this.mediaDownloads = this.mediaDownloads.filter((e) => e.timestamp >= cutoff);
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
