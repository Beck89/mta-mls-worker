# MLS IDX Platform — Phase 1: Replication Worker

## Overview

A standalone service that replicates listing data from MLS Grid, targeting **ACTRIS** (`OriginatingSystemName: actris`) as the single MLS source for Phase 1. Stores structured data in PostgreSQL and hosts media in Cloudflare R2. This is the data ingestion backbone of the platform — it runs independently of the API server and has no dependency on it.

**Stack:** TypeScript (Node.js), PostgreSQL 16+ (PostGIS, pg_trgm), Cloudflare R2, Docker on Coolify

**Repo Scope:** This service owns all MLS Grid communication, data transformation, media management, and replication monitoring. It writes to the shared PostgreSQL database but does not serve any external HTTP traffic. Adding additional MLS sources later is a configuration change — the pipeline is source-agnostic by design.

---

## Infrastructure

### Container Architecture (Coolify / Docker)

Single container, deployed independently:

| Container | Role | Scaling | Notes |
|---|---|---|---|
| **Replication Worker** | Syncs data from MLS Grid, diffs records, downloads media to R2, logs replication metrics | **Single instance only** — no concurrent replication | Long-running process with internal scheduler |

### PostgreSQL (Independent Instance)

The database is hosted separately from Coolify's managed services and is already provisioned. The replication worker connects to it as a client.

**Required Extensions:**
- `postgis` — spatial queries, geography types, GiST indexes
- `pg_trgm` — trigram indexes for fast fuzzy typeahead matching

**Tuning Priorities:**
- `work_mem` and `maintenance_work_mem` — sized for PostGIS spatial joins and index builds
- `shared_buffers` — tuned for upsert-heavy replication workload
- Connection pooling (PgBouncer or built-in) — the replication worker can be write-intensive during initial import

### Cloudflare R2

Object storage for all MLS media (listing photos, agent photos, office logos).

**Key Structure:** `{listing_key}/{media_key}.{extension}`

MediaKey is globally unique within the MLS, providing clean one-to-one mapping between the media table and R2 objects.

**Access Pattern:** The replication worker downloads media from MLS Grid's MediaURLs and uploads to R2. MLS Grid's MediaURLs must never be stored for runtime use — they are for download only and may expire.

### Technology Summary

| Layer | Technology | Notes |
|---|---|---|
| Language | TypeScript (Node.js) | Shared types with API server via shared package |
| ORM | Drizzle | Better raw SQL control for PostGIS, JSONB, upserts |
| Database | PostgreSQL 16+ | PostGIS, pg_trgm extensions |
| Object Storage | Cloudflare R2 | All MLS media |
| Deployment | Docker on Coolify | Single container |

---

## Database Schema

The replication worker is the primary writer to the following tables. The API server (Phase 2) reads from them.

### Core Data Tables

#### `properties`

The central table. Explicit columns for every RESO standard field used in queries, filters, sorting, and display. A JSONB column for MLS-local fields and remaining display-only attributes.

```
properties
├── listing_key          VARCHAR PRIMARY KEY    -- prefixed key from MLS Grid (e.g., "ACT107472571")
├── listing_id           VARCHAR UNIQUE         -- prefixed MLS ID (e.g., "ACT1475089")
├── listing_id_display   VARCHAR                -- prefix stripped for display (e.g., "1475089")
├── originating_system   VARCHAR NOT NULL       -- e.g., "actris"
│
│   -- Pricing
├── list_price           NUMERIC
├── original_list_price  NUMERIC
├── previous_list_price  NUMERIC
│
│   -- Status
├── standard_status      VARCHAR                -- Active, Pending, Closed, etc.
├── mls_status           VARCHAR
│
│   -- Property Attributes
├── property_type        VARCHAR                -- Residential, Land, Commercial Sale, etc.
├── property_sub_type    VARCHAR
├── bedrooms_total       INTEGER
├── bathrooms_total      INTEGER
├── bathrooms_full       INTEGER
├── bathrooms_half       INTEGER
├── living_area          NUMERIC                -- square footage
├── living_area_source   VARCHAR
├── lot_size_acres       NUMERIC
├── lot_size_sqft        NUMERIC
├── year_built           INTEGER
├── year_built_source    VARCHAR
├── stories              INTEGER
├── garage_spaces        INTEGER
├── parking_total        INTEGER
├── fireplaces_total     INTEGER
├── new_construction_yn  BOOLEAN
├── pool_private_yn      BOOLEAN
├── waterfront_yn        BOOLEAN
├── horse_yn             BOOLEAN
├── association_yn       BOOLEAN
│
│   -- Location / Geo
├── geog                 GEOGRAPHY(POINT, 4326) -- derived from Latitude/Longitude
├── latitude             NUMERIC
├── longitude            NUMERIC
├── street_number        VARCHAR
├── street_name          VARCHAR
├── street_suffix        VARCHAR
├── unparsed_address     VARCHAR
├── city                 VARCHAR
├── state_or_province    VARCHAR
├── postal_code          VARCHAR
├── county_or_parish     VARCHAR
├── country              VARCHAR
├── directions           TEXT
├── subdivision_name     VARCHAR
├── mls_area_major       VARCHAR
│
│   -- Agent / Office References
├── list_agent_key       VARCHAR                -- FK to members
├── list_agent_mls_id    VARCHAR
├── list_agent_full_name VARCHAR
├── list_agent_email     VARCHAR
├── list_agent_phone     VARCHAR
├── list_office_key      VARCHAR                -- FK to offices
├── list_office_mls_id   VARCHAR
├── list_office_name     VARCHAR
├── list_office_phone    VARCHAR
├── buyer_office_key     VARCHAR
│
│   -- Listing Metadata
├── listing_contract_date DATE
├── public_remarks       TEXT
├── syndication_remarks  TEXT
├── virtual_tour_url     VARCHAR
├── internet_display_yn  BOOLEAN
├── internet_valuation_yn BOOLEAN
│
│   -- Schools
├── elementary_school    VARCHAR
├── middle_school        VARCHAR
├── high_school          VARCHAR
│
│   -- Tax
├── tax_assessed_value   NUMERIC
├── tax_year             INTEGER
├── tax_legal_desc       TEXT
├── parcel_number        VARCHAR
│
│   -- Compensation
├── buyer_agency_comp    VARCHAR
├── buyer_agency_comp_type VARCHAR
├── sub_agency_comp      VARCHAR
├── sub_agency_comp_type VARCHAR
│
│   -- MLS Grid System Fields
├── mlg_can_view         BOOLEAN NOT NULL DEFAULT true
├── mlg_can_use          TEXT[]                 -- array: ['IDX'], ['IDX','VOW'], etc.
├── modification_ts      TIMESTAMPTZ NOT NULL   -- MLS Grid's ModificationTimestamp
├── originating_mod_ts   TIMESTAMPTZ            -- OriginatingSystemModificationTimestamp
├── photos_change_ts     TIMESTAMPTZ            -- PhotosChangeTimestamp
├── photos_count         INTEGER
├── major_change_ts      TIMESTAMPTZ
├── major_change_type    VARCHAR
├── original_entry_ts    TIMESTAMPTZ
│
│   -- Array/Feature Fields (stored as TEXT[] for querying)
├── appliances           TEXT[]
├── architectural_style  TEXT[]
├── basement             TEXT[]
├── construction_materials TEXT[]
├── cooling              TEXT[]
├── heating              TEXT[]
├── exterior_features    TEXT[]
├── interior_features    TEXT[]
├── flooring             TEXT[]
├── roof                 TEXT[]
├── sewer                TEXT[]
├── water_source         TEXT[]
├── utilities            TEXT[]
├── lot_features         TEXT[]
├── parking_features     TEXT[]
├── pool_features        TEXT[]
├── fencing              TEXT[]
├── community_features   TEXT[]
├── security_features    TEXT[]
├── levels               TEXT[]
├── view                 TEXT[]
├── foundation_details   TEXT[]
├── patio_porch_features TEXT[]
├── waterfront_features  TEXT[]
├── window_features      TEXT[]
├── green_energy         TEXT[]
├── horse_amenities      TEXT[]
├── special_conditions   TEXT[]
├── disclosures          TEXT[]
├── property_condition   TEXT[]
├── syndicate_to         TEXT[]
│
│   -- Local (MLS-specific) Fields
├── local_fields         JSONB                  -- all prefixed fields (ACT_*, MRD_*, etc.)
│
│   -- Internal Tracking
├── created_at           TIMESTAMPTZ DEFAULT NOW()
├── updated_at           TIMESTAMPTZ DEFAULT NOW()
├── deleted_at           TIMESTAMPTZ            -- soft delete when MlgCanView flips to false
```

**Key Indexes:**
- GiST index on `geog` — map boundary queries
- B-tree on `standard_status` — status filtering
- B-tree on `property_type` — type filtering
- B-tree on `list_price` — price range queries
- B-tree on `modification_ts` — replication high-water mark
- B-tree on `postal_code` — zip code search
- B-tree on `city` — city filtering
- B-tree on `subdivision_name` — subdivision search
- Composite index on `(standard_status, property_type, list_price)` — common filter combo
- GIN index on `mlg_can_use` — use-case filtering (`WHERE 'IDX' = ANY(mlg_can_use)`)

#### `media`

One row per media asset. Composite index on `(listing_key, media_order)` for efficient property detail page queries.

```
media
├── media_key                VARCHAR PRIMARY KEY   -- from MLS Grid
├── listing_key              VARCHAR NOT NULL       -- FK to properties
├── resource_type            VARCHAR NOT NULL       -- 'Property', 'Member', 'Office'
├── media_url_source         VARCHAR                -- original MLS Grid URL (download reference only)
├── r2_object_key            VARCHAR NOT NULL       -- key in R2 bucket
├── media_mod_ts             TIMESTAMPTZ            -- MediaModificationTimestamp
├── media_order              INTEGER                -- display ordering
├── media_category           VARCHAR                -- photo type/category if available
├── file_size_bytes          BIGINT
├── content_type             VARCHAR                -- MIME type
├── status                   VARCHAR NOT NULL DEFAULT 'pending_download' -- 'pending_download', 'complete', 'failed'
├── retry_count              INTEGER NOT NULL DEFAULT 0
├── created_at               TIMESTAMPTZ DEFAULT NOW()
├── updated_at               TIMESTAMPTZ DEFAULT NOW()
```

**Indexes:** Composite on `(listing_key, media_order)`, B-tree on `resource_type`, B-tree on `status` (for download loop polling)

#### `raw_responses`

Stores the raw MLS Grid JSON response per property (without expanded Media/Rooms/UnitTypes sub-resources, as media URLs expire). Enables column backfilling during schema refactoring without re-fetching from the API.

```
raw_responses
├── listing_key          VARCHAR PRIMARY KEY    -- one-to-one with properties
├── raw_data             JSONB NOT NULL         -- property-level fields only, no expanded sub-resources
├── originating_system   VARCHAR NOT NULL       -- for targeted per-MLS backfills
├── received_at          TIMESTAMPTZ DEFAULT NOW()
```

#### `rooms`

```
rooms
├── room_key          VARCHAR PRIMARY KEY
├── listing_key       VARCHAR NOT NULL       -- FK to properties
├── room_type         VARCHAR
├── room_dimensions   VARCHAR
├── room_features     TEXT[]
```

#### `unit_types`

```
unit_types
├── unit_type_key       VARCHAR PRIMARY KEY
├── listing_key         VARCHAR NOT NULL     -- FK to properties
├── unit_type_type      VARCHAR
├── unit_type_beds      INTEGER
├── unit_type_baths     NUMERIC
├── unit_type_rent      NUMERIC
```

#### `members`

```
members
├── member_key           VARCHAR PRIMARY KEY
├── member_mls_id        VARCHAR UNIQUE
├── originating_system   VARCHAR NOT NULL
├── member_full_name     VARCHAR
├── member_email         VARCHAR
├── member_phone         VARCHAR
├── office_key           VARCHAR              -- FK to offices
├── member_designation   TEXT[]
├── photos_change_ts     TIMESTAMPTZ
├── mlg_can_view         BOOLEAN NOT NULL DEFAULT true
├── modification_ts      TIMESTAMPTZ NOT NULL
├── local_fields         JSONB
├── created_at           TIMESTAMPTZ DEFAULT NOW()
├── updated_at           TIMESTAMPTZ DEFAULT NOW()
├── deleted_at           TIMESTAMPTZ
```

#### `offices`

```
offices
├── office_key           VARCHAR PRIMARY KEY
├── office_mls_id        VARCHAR UNIQUE
├── originating_system   VARCHAR NOT NULL
├── office_name          VARCHAR
├── office_phone         VARCHAR
├── office_email         VARCHAR
├── office_address       VARCHAR
├── office_city          VARCHAR
├── office_state         VARCHAR
├── office_postal_code   VARCHAR
├── photos_change_ts     TIMESTAMPTZ
├── mlg_can_view         BOOLEAN NOT NULL DEFAULT true
├── modification_ts      TIMESTAMPTZ NOT NULL
├── local_fields         JSONB
├── created_at           TIMESTAMPTZ DEFAULT NOW()
├── updated_at           TIMESTAMPTZ DEFAULT NOW()
├── deleted_at           TIMESTAMPTZ
```

#### `open_houses`

FK references `properties.listing_id` (not `listing_key`), matching MLS Grid's API pattern. Ensure an index on `properties.listing_id` supports this join.

```
open_houses
├── open_house_key       VARCHAR PRIMARY KEY
├── listing_id           VARCHAR NOT NULL     -- FK reference to properties.listing_id
├── originating_system   VARCHAR NOT NULL
├── open_house_date      DATE
├── open_house_start     TIMESTAMPTZ
├── open_house_end       TIMESTAMPTZ
├── open_house_remarks   TEXT
├── showing_agent_key    VARCHAR
├── mlg_can_view         BOOLEAN NOT NULL DEFAULT true
├── modification_ts      TIMESTAMPTZ NOT NULL
├── local_fields         JSONB
├── created_at           TIMESTAMPTZ DEFAULT NOW()
├── updated_at           TIMESTAMPTZ DEFAULT NOW()
```

#### `lookups`

Replicated once daily. Reference data for all enumerated fields.

```
lookups
├── lookup_key             VARCHAR PRIMARY KEY
├── lookup_name            VARCHAR NOT NULL     -- e.g., "StandardStatus", "BodyType"
├── lookup_value           VARCHAR NOT NULL
├── standard_lookup_value  VARCHAR
├── originating_system     VARCHAR NOT NULL
├── mlg_can_view           BOOLEAN NOT NULL DEFAULT true
├── modification_ts        TIMESTAMPTZ NOT NULL
├── created_at             TIMESTAMPTZ DEFAULT NOW()
├── updated_at             TIMESTAMPTZ DEFAULT NOW()
```

**Indexes:** Composite on `(originating_system, lookup_name)` for fast lookup resolution

---

### Historical Tracking Tables

#### `price_history`

One row per price change event per listing. Critical foundation for Phase 3 retention features (price drop alerts on viewed properties).

```
price_history
├── id                 BIGSERIAL PRIMARY KEY
├── listing_key        VARCHAR NOT NULL        -- FK to properties
├── old_price          NUMERIC
├── new_price          NUMERIC NOT NULL
├── change_type        VARCHAR                 -- "Price Increase", "Price Decrease", from MajorChangeType if available
├── modification_ts    TIMESTAMPTZ NOT NULL    -- MLS Grid's timestamp for this change
├── recorded_at        TIMESTAMPTZ DEFAULT NOW()
```

**Indexes:** B-tree on `listing_key`, B-tree on `recorded_at`

#### `status_history`

One row per status change event per listing.

```
status_history
├── id                 BIGSERIAL PRIMARY KEY
├── listing_key        VARCHAR NOT NULL        -- FK to properties
├── old_status         VARCHAR
├── new_status         VARCHAR NOT NULL
├── modification_ts    TIMESTAMPTZ NOT NULL
├── recorded_at        TIMESTAMPTZ DEFAULT NOW()
```

**Indexes:** B-tree on `listing_key`, B-tree on `recorded_at`

#### `property_change_log`

General-purpose field-level audit log. Only log fields that drive user-facing features: price, status, photos_count, public_remarks, living_area. Expand the watch list as needed.

```
property_change_log
├── id                 BIGSERIAL PRIMARY KEY
├── listing_key        VARCHAR NOT NULL
├── field_name         VARCHAR NOT NULL        -- e.g., "PublicRemarks", "PhotosCount", "LivingArea"
├── old_value          TEXT
├── new_value          TEXT
├── modification_ts    TIMESTAMPTZ NOT NULL
├── recorded_at        TIMESTAMPTZ DEFAULT NOW()
```

**Indexes:** Composite on `(listing_key, field_name)`, B-tree on `recorded_at`

**Partitioning:** Partition `property_change_log` by month on `recorded_at`. This table grows fast. Retain 90 days of detailed data, archive or drop older partitions.

---

### Replication Monitoring Tables

#### `replication_runs`

One row per replication cycle per resource type. Primary observability table.

```
replication_runs
├── id                    BIGSERIAL PRIMARY KEY
├── resource_type         VARCHAR NOT NULL       -- 'Property', 'Member', 'Office', 'OpenHouse', 'Lookup'
├── run_mode              VARCHAR NOT NULL       -- 'initial_import', 'replication'
├── started_at            TIMESTAMPTZ NOT NULL
├── completed_at          TIMESTAMPTZ
├── status                VARCHAR NOT NULL       -- 'running', 'completed', 'failed', 'partial'
├── error_message         TEXT
│
│   -- High-Water Marks
├── hwm_start             TIMESTAMPTZ            -- ModificationTimestamp at start of run
├── hwm_end               TIMESTAMPTZ            -- greatest ModificationTimestamp received
│
│   -- Record Counts
├── total_records_received INTEGER DEFAULT 0
├── records_inserted       INTEGER DEFAULT 0
├── records_updated        INTEGER DEFAULT 0
├── records_deleted        INTEGER DEFAULT 0     -- MlgCanView flipped to false
│
│   -- Media Counts (Property runs only)
├── media_downloaded       INTEGER DEFAULT 0
├── media_deleted          INTEGER DEFAULT 0
├── media_bytes_downloaded BIGINT DEFAULT 0
│
│   -- API Usage
├── api_requests_made      INTEGER DEFAULT 0
├── api_bytes_downloaded   BIGINT DEFAULT 0      -- total response payload size
├── avg_response_time_ms   INTEGER
│
│   -- HTTP Errors
├── http_errors            JSONB                 -- { "429": 2, "500": 1 } etc.
```

#### `replication_requests`

Per-request log for debugging and rate limit verification.

```
replication_requests
├── id                 BIGSERIAL PRIMARY KEY
├── run_id             BIGINT NOT NULL          -- FK to replication_runs
├── request_url        TEXT NOT NULL
├── http_status        INTEGER
├── response_time_ms   INTEGER
├── response_bytes     BIGINT
├── records_returned   INTEGER
├── requested_at       TIMESTAMPTZ NOT NULL
├── error_message      TEXT
```

**Partitioning:** Range partition by `requested_at`, monthly. Retain 30–90 days, drop older partitions.

**Indexes:** B-tree on `run_id`, B-tree on `requested_at`

#### `media_downloads`

Per-image download tracking, separate from API request logging since media downloads are the primary bandwidth consumer.

```
media_downloads
├── id                 BIGSERIAL PRIMARY KEY
├── run_id             BIGINT                   -- FK to replication_runs
├── media_key          VARCHAR NOT NULL
├── listing_key        VARCHAR NOT NULL
├── file_size_bytes    BIGINT
├── download_time_ms   INTEGER
├── r2_upload_time_ms  INTEGER
├── status             VARCHAR NOT NULL         -- 'success', 'failed', 'skipped'
├── error_message      TEXT
├── downloaded_at      TIMESTAMPTZ NOT NULL
```

**Partitioning:** Range partition by `downloaded_at`, monthly. Same retention as replication_requests.

#### `rate_limit_tracking` (View or Materialized View)

Derived from `replication_requests` and `media_downloads`. Provides real-time consumption against MLS Grid limits.

```
MLS Grid Rate Limits:
├── 2 requests per second (RPS)          — soft cap at 1.5       (API calls only)
├── 7,200 requests per hour              — soft cap at 6,000     (API calls only)
├── 40,000 requests per 24-hour period   — soft cap at 35,000    (API calls only)
├── 4 GB downloaded per hour             — soft cap at 3.5 GB    (media bytes — API payloads are negligible)
```

Build SQL views that calculate current consumption for each window: API requests in the last 1 second, last hour, last 24 hours (from `replication_requests`), and media bytes downloaded in the last hour (from `media_downloads`) — each expressed as a percentage of the limit.

---

## Replication Worker — Processing Pipeline

### Scheduler Implementation

**Mechanism:** In-process scheduler using `croner` (lightweight, no Redis dependency). Each resource type runs its own independent scheduler loop. No external job queue needed given the single-instance constraint.

**Initial Import Startup Order:** During initial import, resources must start in dependency order to avoid FK violations. Property must complete first (it's the parent for OpenHouse FKs and the source for Member/Office cross-references). After that, Member and Office can run in parallel (they're independent). OpenHouse goes last since it depends on Property. Lookup can run at any time — it's fully independent. Order: Property → (Member + Office in parallel) → OpenHouse. Lookup at any point. Once all resources have completed their first full import, the independent scheduler loops take over and ordering no longer matters.

**Non-Overlapping Rule:** Cadences represent the delay *after the previous cycle completes*, not fixed intervals. If a Property cycle takes 3 minutes, the next one starts when it finishes — no overlap, no skipping. This is enforced per resource type; a long Property cycle does not block Member or Office cycles.

**Shared Rate Limiter:** All resource type schedulers share a single in-memory rate limiter instance, since MLS Grid rate limits are per API token, not per resource.

| Resource | Delay After Completion | Notes |
|---|---|---|
| Property | 1–2 minutes | Core data, tightest loop |
| Member | 5–10 minutes | Changes less frequently |
| Office | 5–10 minutes | Changes less frequently |
| OpenHouse | 5 minutes | Time-sensitive data |
| Lookup | Once daily | MLS Grid docs: do not pull more than once/day |

### Per-Record Processing Flow (Property, Member, Office)

**Transaction Granularity:** One transaction per record. Each property's constellation of changes (property row + rooms + unit_types + raw_response + history inserts) is atomic. Per-page transactions covering 1,000 records across five tables would cause long lock times and painful rollbacks. The I/O cost of API calls and media downloads dwarfs individual transaction overhead.

**Member and Office Media:** Member and Office resources support `$expand=Media` and have `PhotosChangeTimestamp`. Their replication cycles check `PhotosChangeTimestamp` the same way Property does and queue media rows with `resource_type = 'Member'` or `'Office'`. The decoupled media download loop handles this naturally since it polls by `status` regardless of resource type.

For each record received during a replication cycle:

```
1. CHECK MlgCanView
   ├── IF false:
   │   ├── Soft-delete property (set deleted_at)
   │   ├── Log to status_history (old_status → "Deleted/Removed")
   │   ├── Delete associated media from R2 immediately
   │   ├── Delete media rows from database
   │   ├── Call notifyIfNeeded() for users who saved this property
   │   └── Continue to next record
   │
   └── IF true: continue ↓

2. LOAD existing record from Postgres by ListingKey
   ├── IF not found: this is a new listing (insert path)
   └── IF found: this is an update (diff path)

3. DIFF against existing record (update path only)
   ├── Compare ListPrice → if changed, INSERT into price_history
   ├── Compare StandardStatus → if changed, INSERT into status_history
   ├── Compare all watched fields → INSERT into property_change_log
   └── Compare PhotosChangeTimestamp → if changed, flag for media queue

4. QUEUE MEDIA (if PhotosChangeTimestamp changed or new listing)
   ├── For each Media sub-document:
   │   ├── Compare MediaModificationTimestamp against stored value
   │   ├── If new or changed: upsert media row with status 'pending_download'
   │   └── If MediaKey no longer present: queue R2 deletion + delete media row
   └── Update photos_change_ts on property record
   NOTE: Media downloads are decoupled — see "Media Download Pipeline" below.
         This step only identifies what needs downloading and updates metadata.

5. PROCESS ROOMS AND UNIT_TYPES
   ├── Replace all existing rooms for this listing with incoming Rooms data
   └── Replace all existing unit_types for this listing with incoming UnitTypes data

6. UPSERT property record + raw_response (SINGLE TRANSACTION)
   ├── Strip expanded sub-resources (Media, Rooms, UnitTypes) from raw JSON
   ├── Upsert into raw_responses table (property-level fields only, no expired media URLs)
   └── All changes in steps 3–6 happen in a single transaction per record

7. EVALUATE ALERTS (Phase 3 interface)
   ├── Call notifyIfNeeded(event) — strictly no-op in Phase 1
   ├── The function signature and call site exist, but the body is empty
   ├── Does NOT query saved_searches or any Phase 2 tables
   ├── Event shape (interface contract): { type, listing_key, old_value, new_value }
   └── Phase 3 implements the body; user lookup is handled internally at that point

8. UPDATE high-water mark
   └── Store this record's ModificationTimestamp if it's the greatest seen in this run
```

### Media Download Pipeline

Media downloads are decoupled from the per-record processing pipeline. This is critical for performance — blocking on 24 photo downloads per listing during a 1,000-record page would make replication unacceptably slow.

**Architecture:** A separate async loop runs alongside record processing. It polls for media rows with `pending_download` status and processes them with controlled concurrency.

```
Media Download Loop (runs continuously during replication):
├── Poll media table for rows with status = 'pending_download'
├── Download from MediaURL → upload to R2 (10–20 concurrent downloads)
├── On success: update media row status to 'complete', record in media_downloads
├── On failure: increment retry count, backoff
│   ├── Retry up to 3 times with exponential backoff
│   └── After 3 failures: mark as 'failed', log for manual investigation
└── Media bytes tracked in rate limiter against 4 GB/hour cap (request counts are NOT tracked — different domain)
```

**Rate Limiter Integration:** Media downloads from MediaURLs are **not** counted against MLS Grid's API request limits (2 RPS, 7,200/hour, 40,000/day). MediaURLs point to MLS Grid's own CDN/S3 infrastructure, not the `api.mlsgrid.com` endpoint. However, the **4 GB/hour bandwidth cap** is almost certainly about media downloads — API JSON payloads are tiny by comparison. The rate limiter should track media download bytes against this cap. Media download concurrency can be more aggressive than API calls — cap at 10–20 concurrent downloads to remain a good citizen and avoid CDN-level throttling.

### Post-Replication Tasks

After each Property replication cycle completes:

1. **Refresh `search_suggestions` materialized view** — ensures new listings appear in typeahead within minutes. The view definition is created by Phase 2's schema migrations. The worker should skip the refresh if the view doesn't exist (simple `IF EXISTS` check before `REFRESH MATERIALIZED VIEW`). Once Phase 2 creates the view, the worker's post-replication refresh picks it up automatically. No cross-phase dependency needed.

> **Note:** `days_on_market` is not stored. The API server (Phase 2) computes it on-the-fly as `CURRENT_DATE - listing_contract_date` in queries — always accurate, zero maintenance.

### Initial Import Mode vs Replication Mode

| Behavior | Initial Import | Replication |
|---|---|---|
| MlgCanView filter | `MlgCanView eq true` (skip deletes) | No filter (receive all changes including deletes) |
| Price/status history | **Skip** — no baseline to diff against | Active |
| Alert evaluation | **Skip** — no users yet, avoid backfill noise | Active (via notifyIfNeeded) |
| Change log | **Skip** | Active |
| Media downloads | Download all | Download only new/changed |
| Paging | Follow `@odata.nextLink` until exhausted | Follow `@odata.nextLink` until exhausted |
| Resumability | `ge` (greater than or equal) with dedup — see Error Recovery below | Same |
| $expand | `Media,Rooms,UnitTypes` | Same |
| `$top` | `1000` (max with $expand) | Same |

**Without `$expand`** (Member, Office, OpenHouse, Lookup): use `$top=5000` (the maximum). Fewer API requests = better rate limit utilization.

### High-Water Mark Storage

The high-water mark (HWM) for each resource type is derived from `replication_runs.hwm_end` where `status IN ('completed', 'partial')`, ordered by `started_at DESC`. This is safer than `MAX(modification_ts)` on the resource table because a partial run might have committed records but the run itself failed — the `hwm_end` on that run still reflects the last successfully received timestamp.

On first run (no `replication_runs` entries for a given resource type), there is no HWM. The worker starts in initial import mode with no `ModificationTimestamp` filter.

### Error Recovery

**Partial Page Failures:** If the worker crashes mid-page (e.g., after processing record 500 of 1,000), those 500 records are already committed (per-record transactions). On restart, the high-water mark points to record 500's `ModificationTimestamp`. Multiple records can share the same timestamp, so using `gt` (greater than) would skip records with identical timestamps.

**Solution:** Always resume with `ge` (greater than or equal) on `ModificationTimestamp` and deduplicate. On restart, query the database for all `ListingKey` values with `modification_ts = [last_hwm]`. Skip any records already processed. This guarantees no records are missed, at the cost of re-checking a small number of already-committed records.

**Media Failures:** Handled independently via the media download pipeline. If 1 of 24 photos fails, only that image is retried (up to 3 attempts with exponential backoff). The listing itself is fully committed. Failed media entries remain in the `media_downloads` table with `status = 'failed'` for manual investigation.

### Rate Limiter (In-Memory, Shared)

Single in-memory rate limiter instance shared by all resource type schedulers. Sliding window counter checked before every API request.

**Important:** MLS Grid's request count limits (2 RPS, 7,200/hour, 40,000/day) apply to the API endpoint (`api.mlsgrid.com`) only — MediaURLs are on a different domain (CDN/S3) and don't count against these. However, the **4 GB/hour bandwidth cap is about media downloads** — API JSON payloads are negligible by comparison. The rate limiter therefore tracks two dimensions separately.

**Two tracking dimensions:**
- **Request count** — API calls only (media downloads don't hit the API endpoint)
- **Bytes downloaded** — media file downloads (this is what the 4 GB/hour cap is about; API response payloads are negligible)

```
Before each API request:
├── Check: requests in last 1 second < 2
├── Check: requests in last hour < 7,200 (soft cap at 6,000)
├── Check: requests in last 24 hours < 40,000 (soft cap at 35,000)
│
├── IF any limit approaching: sleep/backoff
└── IF any limit exceeded: pause all replication cycles, log warning, retry later

Before each media download:
├── Check: media bytes downloaded in last hour < 4 GB (soft cap at 3.5 GB)
├── IF approaching: throttle media download concurrency
└── IF exceeded: pause media downloads, allow API replication to continue

On worker restart: initialize API counters from replication_requests table,
                    initialize media byte counters from media_downloads table
```

**Media download concurrency** is capped at 10–20 concurrent downloads. This is a self-imposed good-citizen limit — you're constrained by your own bandwidth and R2 upload throughput, plus the 4 GB/hour media bandwidth cap.

---

## Soft Delete Cleanup

When `MlgCanView` flips to false, the property is soft-deleted (`deleted_at` set) and its R2 media is deleted immediately (no reason to retain images for a delisted property, and compliance requires removing them from display).

**Hard Delete Schedule:** A daily cleanup job hard-deletes database records where `deleted_at` is older than 30 days. MLS Grid removes these records entirely after 7 days, so by 30 days there is zero chance of them reappearing. This job runs within the replication worker process on the Lookup scheduler cadence (once daily).

**`raw_responses` During Soft-Delete Window:** Leave `raw_responses` intact during the soft-delete window. The whole point of `raw_responses` is enabling backfills, and a soft-deleted property might get un-deleted if `MlgCanView` flips back to true within 7 days (rare but possible). No separate soft-delete handling is needed for `raw_responses`.

**Scope:** Hard-deletes (at 30 days) cascade across `properties`, `media`, `rooms`, `unit_types`, `raw_responses`, `price_history`, `status_history`, and `property_change_log` for the affected `listing_key`.

---

## Observability & Alerting

The replication monitoring tables (`replication_runs`, `replication_requests`, `media_downloads`) provide the data layer for observability. On top of that, the worker emits structured JSON logs for all significant events.

**Alert Conditions** (delivered via structured log patterns that a log aggregator can trigger on):
- Replication cycle failure (`replication_runs.status = 'failed'`)
- Rate limit suspension (HTTP 429 received)
- Initial import stalled for more than N minutes (no new records committed)
- Media download failure rate exceeding threshold (e.g., >5% of downloads in a cycle)
- High-water mark not advancing across multiple cycles (possible data stall)

**Health Check:** Not needed from the worker itself — Coolify handles container health monitoring directly.

---

## MLS Grid Compliance Notes

- **MlgCanView:** When false, soft-delete in database (set `deleted_at`). Records disappear from MLS Grid entirely after 7 days.
- **MlgCanUse:** Store the array as-is. The API server (Phase 2) is responsible for filtering IDX-facing queries.
- **MediaURL:** Download and upload to R2. Never persist MediaURLs for runtime use — they are for download only.
- **Key Prefixes:** Store prefixed versions internally for API queries. The API server (Phase 2) handles stripping prefixes for display.
- **Date Handling:** All RESO date fields from MLS Grid are in UTC. Store as-is in TIMESTAMPTZ columns.
- **Local Fields:** Prefixed with MLS code + underscore (e.g., `ACT_EstimatedTaxes`). Store in `local_fields` JSONB. Do not rely on these being present — they vary by MLS source.

---

## ORM / Query Layer

**Recommendation:** Drizzle ORM over Prisma.

**Reasoning:** This project requires extensive PostGIS spatial queries, JSONB operations, array column filtering, and upsert-heavy replication workloads. Drizzle provides much better control over raw SQL while still offering type safety. Prisma's abstraction layer becomes an obstacle for these use cases.
