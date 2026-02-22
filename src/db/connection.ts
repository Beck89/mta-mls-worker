import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getEnv } from '../config/env.js';
import { getLogger } from '../lib/logger.js';
import * as schema from './schema/index.js';

const { Pool } = pg;

let _pool: pg.Pool | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function createDb() {
  if (_db) return _db;

  const env = getEnv();
  const logger = getLogger();

  _pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_SIZE,
    // For replication worker: synchronous_commit = off reduces WAL flush overhead
    // per-record. Data is recoverable from MLS Grid if lost in a crash window.
    options: '-c synchronous_commit=off',
  });

  _pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected database pool error');
  });

  _db = drizzle(_pool, { schema, logger: false });

  logger.info('Database connection pool created');
  return _db;
}

export function getDb() {
  if (!_db) {
    throw new Error('Database not initialized. Call createDb() first.');
  }
  return _db;
}

export async function closeDb() {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
    getLogger().info('Database connection pool closed');
  }
}

export type Database = ReturnType<typeof createDb>;
