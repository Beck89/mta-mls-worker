import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/connection.js';
import { properties } from '../db/schema/properties.js';
import { members } from '../db/schema/members.js';
import { offices } from '../db/schema/offices.js';
import { replicationRuns } from '../db/schema/monitoring.js';
import {
  buildInitialImportUrl,
  buildReplicationUrl,
  fetchAllPages,
  type ResourceType,
} from '../api/mlsgrid-client.js';
import { processPropertyRecord } from './property-processor.js';
import {
  processMemberRecord,
  processOfficeRecord,
  processOpenHouseRecord,
  processLookupRecord,
} from './resource-processors.js';
import { getMediaDownloader } from './media-downloader.js';
import { getEnv } from '../config/env.js';
import { getLogger } from '../lib/logger.js';

export interface CycleResult {
  runId: number;
  status: 'completed' | 'failed' | 'partial';
  totalRecords: number;
  inserted: number;
  updated: number;
  deleted: number;
  mediaQueued: number;
  hwmEnd: Date | null;
  error?: string;
}

/**
 * Run a single replication cycle for a given resource type.
 * Handles initial import vs replication mode, HWM management, and error recovery.
 */
export async function runReplicationCycle(resource: ResourceType): Promise<CycleResult> {
  const db = getDb();
  const logger = getLogger();
  const env = getEnv();
  const originatingSystem = env.MLSGRID_ORIGINATING_SYSTEM;

  // Determine run mode and HWM
  const { isInitialImport, hwm } = await determineRunMode(resource);
  const runMode = isInitialImport ? 'initial_import' : 'replication';

  logger.info(
    { resource, runMode, hwm: hwm?.toISOString() ?? 'none' },
    `Starting ${resource} replication cycle`,
  );

  // Create replication run record
  const [run] = await db
    .insert(replicationRuns)
    .values({
      resourceType: resource,
      runMode,
      startedAt: new Date(),
      status: 'running',
      hwmStart: hwm,
    })
    .returning({ id: replicationRuns.id });

  const runId = run.id;

  // Set run ID on media downloader for tracking
  try {
    const downloader = getMediaDownloader();
    downloader.setRunId(runId);
  } catch {
    // Media downloader may not be initialized yet during startup
  }

  let totalRecords = 0;
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  let mediaQueued = 0;
  let hwmEnd: Date | null = hwm;
  let status: 'completed' | 'failed' | 'partial' = 'completed';
  let errorMsg: string | undefined;

  // Build dedup set for `ge` resume strategy
  let dedupSet: Set<string> | null = null;
  if (hwm && !isInitialImport) {
    dedupSet = await buildDedupSet(resource, hwm);
    if (dedupSet.size > 0) {
      logger.info(
        { resource, dedupCount: dedupSet.size },
        'Loaded dedup set for ge resume',
      );
    }
  }

  try {
    // Build URL
    const url = isInitialImport
      ? buildInitialImportUrl(resource, originatingSystem)
      : buildReplicationUrl(resource, originatingSystem, hwm!, true); // useGe=true for resume safety

    // Iterate through all pages
    for await (const page of fetchAllPages(url, runId)) {
      for (const record of page.value) {
        const recordKey = getRecordKey(resource, record);

        // Dedup check: skip records already processed in a previous partial run
        if (dedupSet && recordKey && dedupSet.has(recordKey)) {
          dedupSet.delete(recordKey); // Remove from set — only skip once
          continue;
        }
        // Clear dedup set after first page (we've moved past the HWM timestamp)
        if (dedupSet && dedupSet.size === 0) {
          dedupSet = null;
        }

        try {
          const stats = await processRecord(resource, record, isInitialImport, runId);
          inserted += stats.inserted;
          updated += stats.updated;
          deleted += stats.deleted;
          mediaQueued += stats.mediaQueued;
          totalRecords++;

          // Track HWM
          const modTs = record.ModificationTimestamp as string | undefined;
          if (modTs) {
            const ts = new Date(modTs);
            if (!hwmEnd || ts > hwmEnd) {
              hwmEnd = ts;
            }
          }
        } catch (recordErr) {
          logger.error(
            { err: recordErr, recordKey, resource },
            'Error processing individual record — continuing',
          );
          // Per-record errors don't fail the whole cycle
        }
      }

      logger.info(
        {
          resource,
          pageRecords: page.value.length,
          totalRecords,
          inserted,
          updated,
          deleted,
        },
        'Page processed',
      );
    }
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
    status = totalRecords > 0 ? 'partial' : 'failed';
    logger.error({ err, resource, totalRecords }, `Replication cycle ${status}`);
  }

  // Update replication run record
  await db
    .update(replicationRuns)
    .set({
      completedAt: new Date(),
      status,
      errorMessage: errorMsg ?? null,
      hwmEnd,
      totalRecordsReceived: totalRecords,
      recordsInserted: inserted,
      recordsUpdated: updated,
      recordsDeleted: deleted,
      mediaDownloaded: mediaQueued,
    })
    .where(eq(replicationRuns.id, runId));

  // Post-replication tasks
  if (resource === 'Property' && status !== 'failed') {
    await refreshMaterializedViews();
  }

  logger.info(
    {
      resource,
      runId,
      status,
      totalRecords,
      inserted,
      updated,
      deleted,
      mediaQueued,
      hwmEnd: hwmEnd?.toISOString(),
    },
    `Replication cycle complete`,
  );

  return { runId, status, totalRecords, inserted, updated, deleted, mediaQueued, hwmEnd, error: errorMsg };
}

/**
 * Determine whether this is an initial import or a replication run.
 * Returns the HWM (high-water mark) timestamp if in replication mode.
 */
async function determineRunMode(
  resource: ResourceType,
): Promise<{ isInitialImport: boolean; hwm: Date | null }> {
  const db = getDb();

  // Look for the most recent completed/partial run for this resource
  const lastRun = await db
    .select({ hwmEnd: replicationRuns.hwmEnd, status: replicationRuns.status })
    .from(replicationRuns)
    .where(
      and(
        eq(replicationRuns.resourceType, resource),
        inArray(replicationRuns.status, ['completed', 'partial']),
      ),
    )
    .orderBy(desc(replicationRuns.startedAt))
    .limit(1);

  if (lastRun.length === 0 || !lastRun[0].hwmEnd) {
    return { isInitialImport: true, hwm: null };
  }

  return { isInitialImport: false, hwm: lastRun[0].hwmEnd };
}

/**
 * Build the dedup set for `ge` resume strategy.
 * Returns a Set of record keys that have modification_ts equal to the HWM.
 */
async function buildDedupSet(resource: ResourceType, hwm: Date): Promise<Set<string>> {
  const db = getDb();

  switch (resource) {
    case 'Property': {
      const rows = await db
        .select({ key: properties.listingKey })
        .from(properties)
        .where(eq(properties.modificationTs, hwm));
      return new Set(rows.map((r) => r.key));
    }
    case 'Member': {
      const rows = await db
        .select({ key: members.memberKey })
        .from(members)
        .where(eq(members.modificationTs, hwm));
      return new Set(rows.map((r) => r.key));
    }
    case 'Office': {
      const rows = await db
        .select({ key: offices.officeKey })
        .from(offices)
        .where(eq(offices.modificationTs, hwm));
      return new Set(rows.map((r) => r.key));
    }
    default:
      return new Set();
  }
}

/**
 * Route a record to the appropriate processor based on resource type.
 */
async function processRecord(
  resource: ResourceType,
  record: Record<string, unknown>,
  isInitialImport: boolean,
  runId: number,
) {
  switch (resource) {
    case 'Property':
      return processPropertyRecord(record as any, { isInitialImport, runId });
    case 'Member':
      return processMemberRecord(record, isInitialImport);
    case 'Office':
      return processOfficeRecord(record, isInitialImport);
    case 'OpenHouse':
      return processOpenHouseRecord(record, isInitialImport);
    case 'Lookup':
      return processLookupRecord(record, isInitialImport);
  }
}

/**
 * Get the primary key from a record based on resource type.
 */
function getRecordKey(resource: ResourceType, record: Record<string, unknown>): string | null {
  switch (resource) {
    case 'Property':
      return (record.ListingKey as string) ?? null;
    case 'Member':
      return (record.MemberKey as string) ?? null;
    case 'Office':
      return (record.OfficeKey as string) ?? null;
    case 'OpenHouse':
      return (record.OpenHouseKey as string) ?? null;
    case 'Lookup':
      return (record.LookupKey as string) ?? null;
  }
}

/**
 * Refresh materialized views after Property replication.
 * Skips if the view doesn't exist (Phase 2 creates it).
 */
async function refreshMaterializedViews(): Promise<void> {
  const db = getDb();
  const logger = getLogger();

  try {
    // Check if search_suggestions view exists before refreshing
    const result = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_matviews WHERE matviewname = 'search_suggestions'
      ) as exists
    `);

    const exists = (result as any)?.[0]?.exists ?? false;
    if (exists) {
      await db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY search_suggestions`);
      logger.info('Refreshed search_suggestions materialized view');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to refresh materialized views (non-fatal)');
  }
}
