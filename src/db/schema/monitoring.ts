import {
  pgTable,
  varchar,
  integer,
  bigint,
  bigserial,
  text,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

// ─── Replication Runs ────────────────────────────────────────────────────────

export const replicationRuns = pgTable('replication_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  resourceType: varchar('resource_type').notNull(), // 'Property', 'Member', 'Office', 'OpenHouse', 'Lookup'
  runMode: varchar('run_mode').notNull(), // 'initial_import', 'replication'
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  status: varchar('status').notNull(), // 'running', 'completed', 'failed', 'partial'

  errorMessage: text('error_message'),

  // High-Water Marks
  hwmStart: timestamp('hwm_start', { withTimezone: true }),
  hwmEnd: timestamp('hwm_end', { withTimezone: true }),

  // Record Counts
  totalRecordsReceived: integer('total_records_received').default(0),
  recordsInserted: integer('records_inserted').default(0),
  recordsUpdated: integer('records_updated').default(0),
  recordsDeleted: integer('records_deleted').default(0),

  // Media Counts (Property runs only)
  mediaDownloaded: integer('media_downloaded').default(0),
  mediaDeleted: integer('media_deleted').default(0),
  mediaBytesDownloaded: bigint('media_bytes_downloaded', { mode: 'number' }).default(0),

  // API Usage
  apiRequestsMade: integer('api_requests_made').default(0),
  apiBytesDownloaded: bigint('api_bytes_downloaded', { mode: 'number' }).default(0),
  avgResponseTimeMs: integer('avg_response_time_ms'),

  // HTTP Errors
  httpErrors: jsonb('http_errors'), // { "429": 2, "500": 1 } etc.
});

export type ReplicationRun = typeof replicationRuns.$inferSelect;
export type NewReplicationRun = typeof replicationRuns.$inferInsert;

// ─── Replication Requests ────────────────────────────────────────────────────

export const replicationRequests = pgTable(
  'replication_requests',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: bigint('run_id', { mode: 'number' }).notNull(),
    requestUrl: text('request_url').notNull(),
    httpStatus: integer('http_status'),
    responseTimeMs: integer('response_time_ms'),
    responseBytes: bigint('response_bytes', { mode: 'number' }),
    recordsReturned: integer('records_returned'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    errorMessage: text('error_message'),
  },
  (table) => [
    index('idx_repl_requests_run').on(table.runId),
    index('idx_repl_requests_at').on(table.requestedAt),
  ],
);

export type ReplicationRequest = typeof replicationRequests.$inferSelect;
export type NewReplicationRequest = typeof replicationRequests.$inferInsert;

// ─── Media Downloads ─────────────────────────────────────────────────────────

export const mediaDownloads = pgTable(
  'media_downloads',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: bigint('run_id', { mode: 'number' }),
    mediaKey: varchar('media_key').notNull(),
    listingKey: varchar('listing_key').notNull(),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }),
    downloadTimeMs: integer('download_time_ms'),
    r2UploadTimeMs: integer('r2_upload_time_ms'),
    status: varchar('status').notNull(), // 'success', 'failed', 'skipped'
    errorMessage: text('error_message'),
    downloadedAt: timestamp('downloaded_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('idx_media_downloads_run').on(table.runId),
    index('idx_media_downloads_at').on(table.downloadedAt),
  ],
);

export type MediaDownload = typeof mediaDownloads.$inferSelect;
export type NewMediaDownload = typeof mediaDownloads.$inferInsert;
