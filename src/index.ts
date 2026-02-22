import { loadEnv } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { createDb, closeDb } from './db/connection.js';
import { startHealthServer, stopHealthServer } from './health/server.js';
import { createScheduler } from './scheduler/index.js';

async function main() {
  // 1. Load and validate environment
  const env = loadEnv();

  // 2. Initialize logger
  const logger = createLogger();
  logger.info({ originatingSystem: env.MLSGRID_ORIGINATING_SYSTEM }, 'MLS Replication Worker starting');

  // 3. Initialize database connection
  createDb();
  logger.info('Database connection initialized');

  // 4. Start health check server
  await startHealthServer(env.WORKER_HEALTH_PORT);
  logger.info({ port: env.WORKER_HEALTH_PORT }, 'Health check server started');

  // 5. Start replication scheduler
  const scheduler = createScheduler();
  await scheduler.start();
  logger.info('Replication scheduler started');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

    try {
      await scheduler.stop();
      logger.info('Scheduler stopped');

      await stopHealthServer();
      logger.info('Health server stopped');

      await closeDb();
      logger.info('Database connections closed');

      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled rejection');
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — shutting down');
    shutdown('uncaughtException');
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
