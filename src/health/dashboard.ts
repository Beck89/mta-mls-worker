import { sql } from 'drizzle-orm';
import { getDb } from '../db/connection.js';
import { getRateLimiter } from '../lib/rate-limiter.js';
import { getLogger } from '../lib/logger.js';

/**
 * Fetch all dashboard data from the database and rate limiter.
 */
export async function getDashboardData() {
  const db = getDb();
  const logger = getLogger();

  try {
    // 1. Media status counts
    const mediaStatusRows = await db.execute(sql`
      SELECT status, count(*)::int as count
      FROM media
      GROUP BY status
      ORDER BY count DESC
    `);

    // 2. Properties count
    const propCountRows = await db.execute(sql`
      SELECT count(*)::int as total,
             count(CASE WHEN deleted_at IS NULL THEN 1 END)::int as active
      FROM properties
    `);

    // 3. Properties added per hour (last 24h) from replication_runs
    const propsPerHourRows = await db.execute(sql`
      SELECT
        date_trunc('hour', completed_at) as hour,
        sum(records_inserted)::int as inserted,
        sum(records_updated)::int as updated,
        sum(total_records_received)::int as total_received
      FROM replication_runs
      WHERE resource_type = 'Property'
        AND completed_at >= NOW() - INTERVAL '24 hours'
        AND status IN ('completed', 'partial')
      GROUP BY 1
      ORDER BY 1
    `);

    // 4. Images downloaded per hour (last 24h) from media_downloads
    const imagesPerHourRows = await db.execute(sql`
      SELECT
        date_trunc('hour', downloaded_at) as hour,
        count(*)::int as count,
        count(CASE WHEN status = 'success' THEN 1 END)::int as success,
        count(CASE WHEN status = 'failed' THEN 1 END)::int as failed,
        coalesce(sum(CASE WHEN status = 'success' THEN file_size_bytes ELSE 0 END), 0)::bigint as bytes
      FROM media_downloads
      WHERE downloaded_at >= NOW() - INTERVAL '24 hours'
      GROUP BY 1
      ORDER BY 1
    `);

    // 5. API requests per minute (last 2 hours) for RPS chart
    const apiRpsRows = await db.execute(sql`
      SELECT
        date_trunc('minute', requested_at) as minute,
        count(*)::int as requests,
        count(CASE WHEN http_status = 429 THEN 1 END)::int as rate_limited
      FROM replication_requests
      WHERE requested_at >= NOW() - INTERVAL '2 hours'
      GROUP BY 1
      ORDER BY 1
    `);

    // 6. Recent replication runs (last 20)
    const recentRunsRows = await db.execute(sql`
      SELECT
        id, resource_type, run_mode, status,
        started_at, completed_at,
        total_records_received, records_inserted, records_updated, records_deleted,
        media_downloaded, error_message
      FROM replication_runs
      ORDER BY started_at DESC
      LIMIT 20
    `);

    // 7. Recent 429 errors (last 24h)
    const recent429Rows = await db.execute(sql`
      SELECT count(*)::int as count
      FROM replication_requests
      WHERE http_status = 429
        AND requested_at >= NOW() - INTERVAL '24 hours'
    `);

    // 8. Total media bytes (all time)
    const totalMediaBytesRows = await db.execute(sql`
      SELECT coalesce(sum(file_size_bytes), 0)::bigint as total_bytes
      FROM media
      WHERE status = 'complete'
    `);

    // 9. Rate limiter stats
    let rateLimiterStats = null;
    try {
      rateLimiterStats = getRateLimiter().getUsageStats();
    } catch { /* not initialized */ }

    // db.execute() returns QueryResult with .rows property (node-postgres)
    const rows = (result: unknown): any[] => {
      if (Array.isArray(result)) return result;
      if (result && typeof result === 'object' && 'rows' in result) return (result as any).rows;
      return [];
    };

    return {
      mediaStatus: rows(mediaStatusRows) as Array<{ status: string; count: number }>,
      properties: (rows(propCountRows) as Array<{ total: number; active: number }>)[0] ?? { total: 0, active: 0 },
      propsPerHour: rows(propsPerHourRows) as Array<{ hour: string; inserted: number; updated: number; total_received: number }>,
      imagesPerHour: rows(imagesPerHourRows) as Array<{ hour: string; count: number; success: number; failed: number; bytes: string }>,
      apiRps: rows(apiRpsRows) as Array<{ minute: string; requests: number; rate_limited: number }>,
      recentRuns: rows(recentRunsRows) as Array<Record<string, unknown>>,
      recent429Count: ((rows(recent429Rows) as Array<{ count: number }>)[0]?.count) ?? 0,
      totalMediaBytes: Number(((rows(totalMediaBytesRows) as Array<{ total_bytes: string }>)[0]?.total_bytes) ?? 0),
      rateLimiter: rateLimiterStats,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    logger.error({ err }, 'Dashboard data fetch error');
    throw err;
  }
}

/**
 * Render the dashboard HTML page.
 */
export function renderDashboardHtml(data: Awaited<ReturnType<typeof getDashboardData>>): string {
  const mediaMap: Record<string, number> = {};
  for (const row of data.mediaStatus) {
    mediaMap[row.status] = row.count;
  }
  const totalMedia = Object.values(mediaMap).reduce((a, b) => a + b, 0);
  const completeMedia = mediaMap['complete'] ?? 0;
  const expiredMedia = mediaMap['expired'] ?? 0;
  const failedMedia = mediaMap['failed'] ?? 0;
  const pendingMedia = mediaMap['pending_download'] ?? 0;
  const completePct = totalMedia > 0 ? ((completeMedia / totalMedia) * 100).toFixed(1) : '0';

  const totalMediaGB = (data.totalMediaBytes / (1024 * 1024 * 1024)).toFixed(2);

  const rl = data.rateLimiter;
  const apiLastSec = rl?.api?.lastSecond?.current ?? 0;
  const apiLastHour = rl?.api?.lastHour?.current ?? 0;
  const apiLastDay = rl?.api?.lastDay?.current ?? 0;
  const mediaHourPct = rl?.media?.currentHourBytes?.percentUsed ?? 0;
  const mediaHourGB = rl ? (rl.media.currentHourBytes.current / (1024 * 1024 * 1024)).toFixed(2) : '0';
  const mediaHourLimitGB = rl ? (rl.media.currentHourBytes.limit / (1024 * 1024 * 1024)).toFixed(1) : '0';

  // Pass raw ISO timestamps — browser JS will convert to local time
  const propsHourTimestamps = data.propsPerHour.map(r => r.hour);
  const propsInserted = data.propsPerHour.map(r => r.inserted);
  const propsUpdated = data.propsPerHour.map(r => r.updated);

  const imgHourTimestamps = data.imagesPerHour.map(r => r.hour);
  const imgSuccess = data.imagesPerHour.map(r => r.success);
  const imgFailed = data.imagesPerHour.map(r => r.failed);
  const imgGB = data.imagesPerHour.map(r => (Number(r.bytes) / (1024 * 1024 * 1024)).toFixed(3));

  const rpsTimestamps = data.apiRps.map(r => r.minute);
  const rpsValues = data.apiRps.map(r => r.requests);
  const rps429 = data.apiRps.map(r => r.rate_limited);

  // Recent runs table
  const runsHtml = (data.recentRuns as Array<Record<string, unknown>>).map(r => {
    const started = r.started_at ? new Date(r.started_at as string) : null;
    const completed = r.completed_at ? new Date(r.completed_at as string) : null;
    const durationSec = started && completed ? Math.round((completed.getTime() - started.getTime()) / 1000) : '-';
    const statusClass = r.status === 'completed' ? 'status-ok' : r.status === 'failed' ? 'status-fail' : r.status === 'running' ? 'status-running' : 'status-warn';
    return `<tr>
      <td>${r.resource_type}</td>
      <td>${r.run_mode}</td>
      <td class="${statusClass}">${r.status}</td>
      <td>${r.total_records_received ?? 0}</td>
      <td>${r.records_inserted ?? 0}</td>
      <td>${r.records_updated ?? 0}</td>
      <td>${r.media_downloaded ?? 0}</td>
      <td>${durationSec}s</td>
      <td class="utc-time" data-utc="${started ? started.toISOString() : ''}">${started ? started.toISOString().replace('T', ' ').substring(0, 19) : '-'}</td>
      <td class="error-cell">${r.error_message ? String(r.error_message).substring(0, 60) : ''}</td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="15">
  <title>MLS Worker Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 16px; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; color: #38bdf8; }
    .timestamp { font-size: 0.75rem; color: #64748b; margin-bottom: 16px; }
    .grid { display: grid; gap: 12px; margin-bottom: 16px; }
    .grid-4 { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
    .grid-2 { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
    .card { background: #1e293b; border-radius: 8px; padding: 16px; border: 1px solid #334155; }
    .card h3 { font-size: 0.85rem; color: #94a3b8; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
    .card .value { font-size: 2rem; font-weight: 700; color: #f1f5f9; }
    .card .sub { font-size: 0.8rem; color: #64748b; margin-top: 4px; }
    .status-ok { color: #4ade80; font-weight: 600; }
    .status-fail { color: #f87171; font-weight: 600; }
    .status-warn { color: #fbbf24; font-weight: 600; }
    .status-running { color: #38bdf8; font-weight: 600; }
    .chart-container { position: relative; height: 250px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
    th { text-align: left; padding: 8px 6px; border-bottom: 2px solid #334155; color: #94a3b8; font-weight: 600; }
    td { padding: 6px; border-bottom: 1px solid #1e293b; }
    tr:hover { background: #1e293b; }
    .error-cell { color: #f87171; font-size: 0.7rem; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .progress-bar { background: #334155; border-radius: 4px; height: 8px; margin-top: 8px; overflow: hidden; }
    .progress-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
    .progress-green { background: #4ade80; }
    .progress-yellow { background: #fbbf24; }
    .progress-red { background: #f87171; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: 600; }
    .badge-green { background: #166534; color: #4ade80; }
    .badge-red { background: #7f1d1d; color: #f87171; }
    .badge-yellow { background: #713f12; color: #fbbf24; }
    .badge-blue { background: #1e3a5f; color: #38bdf8; }
    @media (max-width: 600px) {
      body { padding: 8px; }
      h1 { font-size: 1.2rem; }
      .card { padding: 12px; }
      .card .value { font-size: 1.5rem; }
      .grid-4 { grid-template-columns: repeat(2, 1fr); }
      .grid-2 { grid-template-columns: 1fr; }
      .chart-container { height: 200px; }
      table { font-size: 0.7rem; }
      th, td { padding: 4px 3px; }
    }
  </style>
</head>
<body>
  <h1>🏗️ MLS Replication Worker Dashboard</h1>
  <div class="timestamp">Last updated: ${data.timestamp} (auto-refreshes every 15s)</div>

  <!-- Stats Cards -->
  <div class="grid grid-4">
    <div class="card">
      <h3>Properties</h3>
      <div class="value">${(data.properties.active ?? 0).toLocaleString()}</div>
      <div class="sub">${(data.properties.total ?? 0).toLocaleString()} total (incl. deleted)</div>
    </div>
    <div class="card">
      <h3>Media Complete</h3>
      <div class="value">${completeMedia.toLocaleString()}</div>
      <div class="sub">${completePct}% of ${totalMedia.toLocaleString()} total</div>
      <div class="progress-bar">
        <div class="progress-fill progress-green" style="width: ${completePct}%"></div>
      </div>
    </div>
    <div class="card">
      <h3>Media Expired</h3>
      <div class="value" style="color: #fbbf24">${expiredMedia.toLocaleString()}</div>
      <div class="sub">Pending: ${pendingMedia.toLocaleString()} | Failed: ${failedMedia.toLocaleString()}</div>
    </div>
    <div class="card">
      <h3>Total Media Size</h3>
      <div class="value">${totalMediaGB} GB</div>
      <div class="sub">Stored in R2</div>
    </div>
  </div>

  <div class="grid grid-4">
    <div class="card">
      <h3>API RPS (now)</h3>
      <div class="value">${apiLastSec}</div>
      <div class="sub">Limit: 2/sec | Hour: ${apiLastHour}/7,200 | Day: ${apiLastDay}/40,000</div>
    </div>
    <div class="card">
      <h3>Media Bandwidth (this hour)</h3>
      <div class="value">${mediaHourGB} GB</div>
      <div class="sub">${mediaHourPct}% of ${mediaHourLimitGB} GB cap</div>
      <div class="progress-bar">
        <div class="progress-fill ${mediaHourPct > 80 ? 'progress-red' : mediaHourPct > 50 ? 'progress-yellow' : 'progress-green'}" style="width: ${Math.min(mediaHourPct, 100)}%"></div>
      </div>
    </div>
    <div class="card">
      <h3>429 Errors (24h)</h3>
      <div class="value" style="color: ${data.recent429Count > 0 ? '#f87171' : '#4ade80'}">${data.recent429Count}</div>
      <div class="sub">Rate limit hits</div>
    </div>
    <div class="card">
      <h3>Media Status</h3>
      <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px;">
        <span class="badge badge-green">✓ ${completeMedia.toLocaleString()}</span>
        <span class="badge badge-yellow">⏳ ${expiredMedia.toLocaleString()}</span>
        <span class="badge badge-red">✗ ${failedMedia.toLocaleString()}</span>
        <span class="badge badge-blue">⬇ ${pendingMedia.toLocaleString()}</span>
      </div>
    </div>
  </div>

  <!-- Charts -->
  <div class="grid grid-2">
    <div class="card">
      <h3>Properties Added / Updated (24h)</h3>
      <div class="chart-container">
        <canvas id="propsChart"></canvas>
      </div>
    </div>
    <div class="card">
      <h3>Images Downloaded (24h)</h3>
      <div class="chart-container">
        <canvas id="imagesChart"></canvas>
      </div>
    </div>
  </div>

  <div class="grid grid-2">
    <div class="card">
      <h3>Image Download Size in GB (24h)</h3>
      <div class="chart-container">
        <canvas id="imageSizeChart"></canvas>
      </div>
    </div>
    <div class="card">
      <h3>API Requests per Minute (2h)</h3>
      <div class="chart-container">
        <canvas id="rpsChart"></canvas>
      </div>
    </div>
  </div>

  <!-- Recent Runs Table -->
  <div class="card" style="margin-top: 16px;">
    <h3>Recent Replication Runs</h3>
    <div style="overflow-x: auto; margin-top: 8px;">
      <table>
        <thead>
          <tr>
            <th>Resource</th>
            <th>Mode</th>
            <th>Status</th>
            <th>Records</th>
            <th>Inserted</th>
            <th>Updated</th>
            <th>Media</th>
            <th>Duration</th>
            <th>Started</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          ${runsHtml}
        </tbody>
      </table>
    </div>
  </div>

  <script>
    // Helper: convert ISO timestamp to local time string
    function toLocalHour(iso) {
      const d = new Date(iso);
      return d.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: 'numeric', hour12: true });
    }
    function toLocalMinute(iso) {
      const d = new Date(iso);
      return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
    }
    function toLocalDateTime(iso) {
      const d = new Date(iso);
      return d.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
    }

    // Convert all UTC timestamps in the table to local time
    document.querySelectorAll('.utc-time').forEach(el => {
      const utc = el.getAttribute('data-utc');
      if (utc) el.textContent = toLocalDateTime(utc);
    });

    // Convert the "Last updated" timestamp
    const tsEl = document.querySelector('.timestamp');
    if (tsEl) {
      tsEl.textContent = 'Last updated: ' + toLocalDateTime('${data.timestamp}') + ' (auto-refreshes every 15s)';
    }

    // Convert chart labels to local time
    const propsHourLabels = ${JSON.stringify(propsHourTimestamps)}.map(toLocalHour);
    const imgHourLabels = ${JSON.stringify(imgHourTimestamps)}.map(toLocalHour);
    const rpsLabels = ${JSON.stringify(rpsTimestamps)}.map(toLocalMinute);

    const chartDefaults = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#94a3b8', font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: '#64748b', font: { size: 10 }, maxRotation: 45 }, grid: { color: '#1e293b' } },
        y: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: '#1e293b' }, beginAtZero: true },
      },
    };

    // Properties chart
    new Chart(document.getElementById('propsChart'), {
      type: 'bar',
      data: {
        labels: propsHourLabels,
        datasets: [
          { label: 'Inserted', data: ${JSON.stringify(propsInserted)}, backgroundColor: '#4ade80', borderRadius: 3 },
          { label: 'Updated', data: ${JSON.stringify(propsUpdated)}, backgroundColor: '#38bdf8', borderRadius: 3 },
        ],
      },
      options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, tooltip: { mode: 'index', intersect: false } } },
    });

    // Images downloaded chart
    new Chart(document.getElementById('imagesChart'), {
      type: 'bar',
      data: {
        labels: imgHourLabels,
        datasets: [
          { label: 'Success', data: ${JSON.stringify(imgSuccess)}, backgroundColor: '#4ade80', borderRadius: 3 },
          { label: 'Failed', data: ${JSON.stringify(imgFailed)}, backgroundColor: '#f87171', borderRadius: 3 },
        ],
      },
      options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, tooltip: { mode: 'index', intersect: false } } },
    });

    // Image size chart (GB)
    new Chart(document.getElementById('imageSizeChart'), {
      type: 'bar',
      data: {
        labels: imgHourLabels,
        datasets: [
          { label: 'GB Downloaded', data: ${JSON.stringify(imgGB)}, backgroundColor: '#a78bfa', borderRadius: 3 },
        ],
      },
      options: {
        ...chartDefaults,
        scales: {
          ...chartDefaults.scales,
          y: { ...chartDefaults.scales.y, title: { display: true, text: 'GB', color: '#64748b' } },
        },
      },
    });

    // API RPS chart
    new Chart(document.getElementById('rpsChart'), {
      type: 'line',
      data: {
        labels: rpsLabels,
        datasets: [
          { label: 'Requests/min', data: ${JSON.stringify(rpsValues)}, borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.1)', fill: true, tension: 0.3, pointRadius: 0 },
          { label: '429 Errors', data: ${JSON.stringify(rps429)}, borderColor: '#f87171', backgroundColor: 'rgba(248,113,113,0.1)', fill: true, tension: 0.3, pointRadius: 0 },
        ],
      },
      options: chartDefaults,
    });
  </script>
</body>
</html>`;
}
