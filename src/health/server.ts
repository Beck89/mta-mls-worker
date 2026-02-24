import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { eq, desc, and, inArray } from 'drizzle-orm';
import { getDb } from '../db/connection.js';
import { replicationRuns } from '../db/schema/monitoring.js';
import { getRateLimiter } from '../lib/rate-limiter.js';
import { getLogger } from '../lib/logger.js';
import { getDashboardData, renderDashboardHtml } from './dashboard.js';

let _server: ReturnType<typeof Fastify> | null = null;

const RESOURCE_TYPES = ['Property', 'Member', 'Office', 'OpenHouse', 'Lookup'] as const;

// Expected cadence multiplier — alert if no run in 2x expected cadence
const CADENCE_THRESHOLDS_MS: Record<string, number> = {
  Property: 2 * 60 * 1000,       // 2 minutes
  Member: 2 * 5 * 60 * 1000,     // 10 minutes
  Office: 2 * 5 * 60 * 1000,     // 10 minutes
  OpenHouse: 2 * 5 * 60 * 1000,  // 10 minutes
  Lookup: 2 * 24 * 60 * 60 * 1000, // 48 hours
};

export async function startHealthServer(port: number): Promise<void> {
  _server = Fastify({ logger: false });

  _server.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const db = getDb();
      const now = Date.now();

      // Get last successful run for each resource type
      const resourceStatuses: Record<string, {
        lastRun: string | null;
        status: string;
        healthy: boolean;
      }> = {};

      let allHealthy = true;

      for (const resource of RESOURCE_TYPES) {
        const lastRun = await db
          .select({
            completedAt: replicationRuns.completedAt,
            status: replicationRuns.status,
            hwmEnd: replicationRuns.hwmEnd,
          })
          .from(replicationRuns)
          .where(
            and(
              eq(replicationRuns.resourceType, resource),
              inArray(replicationRuns.status, ['completed', 'partial']),
            ),
          )
          .orderBy(desc(replicationRuns.startedAt))
          .limit(1);

        if (lastRun.length === 0) {
          // No runs yet — could be initial startup
          resourceStatuses[resource] = {
            lastRun: null,
            status: 'no_runs',
            healthy: true, // Don't fail health check on first startup
          };
          continue;
        }

        const completedAt = lastRun[0].completedAt;
        const threshold = CADENCE_THRESHOLDS_MS[resource] ?? 600_000;
        const isStale = completedAt
          ? now - completedAt.getTime() > threshold
          : false;

        const healthy = !isStale;
        if (!healthy) allHealthy = false;

        resourceStatuses[resource] = {
          lastRun: completedAt?.toISOString() ?? null,
          status: isStale ? 'stale' : 'ok',
          healthy,
        };
      }

      // Get rate limiter stats
      let rateLimiterStats = null;
      try {
        rateLimiterStats = getRateLimiter().getUsageStats();
      } catch {
        // Rate limiter may not be initialized yet
      }

      const response = {
        status: allHealthy ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        resources: resourceStatuses,
        rateLimiter: rateLimiterStats,
      };

      return reply
        .code(allHealthy ? 200 : 503)
        .send(response);
    } catch (err) {
      getLogger().error({ err }, 'Health check error');
      return reply.code(503).send({
        status: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // Simple liveness probe
  _server.get('/live', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send({ status: 'alive' });
  });

  // Dashboard — HTML page with charts (auto-refreshes every 15s)
  _server.get('/dashboard', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const data = await getDashboardData();
      const html = renderDashboardHtml(data);
      return reply.code(200).type('text/html').send(html);
    } catch (err) {
      getLogger().error({ err }, 'Dashboard error');
      return reply.code(500).type('text/html').send(
        '<html><body style="background:#0f172a;color:#f87171;padding:40px;font-family:sans-serif">' +
        '<h1>Dashboard Error</h1><pre>' + (err instanceof Error ? err.message : String(err)) + '</pre></body></html>',
      );
    }
  });

  // Dashboard JSON API (for programmatic access)
  _server.get('/dashboard/data', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const data = await getDashboardData();
      return reply.code(200).send(data);
    } catch (err) {
      getLogger().error({ err }, 'Dashboard data error');
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  await _server.listen({ port, host: '0.0.0.0' });
}

export async function stopHealthServer(): Promise<void> {
  if (_server) {
    await _server.close();
    _server = null;
  }
}
