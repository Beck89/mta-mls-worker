import { z } from 'zod';

const envSchema = z.object({
  // MLS Grid API
  MLSGRID_API_BASE_URL: z.string().url().default('https://api.mlsgrid.com/v2'),
  MLSGRID_API_TOKEN: z.string().min(1, 'MLS Grid API token is required'),
  MLSGRID_ORIGINATING_SYSTEM: z.string().default('actris'),

  // PostgreSQL
  DATABASE_URL: z.string().min(1, 'Database URL is required'),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),

  // Cloudflare R2
  R2_ACCOUNT_ID: z.string().min(1, 'R2 account ID is required'),
  R2_ACCESS_KEY_ID: z.string().min(1, 'R2 access key is required'),
  R2_SECRET_ACCESS_KEY: z.string().min(1, 'R2 secret key is required'),
  R2_BUCKET_NAME: z.string().default('mls-media'),
  R2_ENDPOINT: z.string().url(),
  R2_PUBLIC_DOMAIN: z.string().default('mls-media.movingtoaustin.com'),

  // Worker Configuration
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(3001),
  WORKER_MEDIA_CONCURRENCY: z.coerce.number().int().positive().default(15),
  WORKER_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  // Media bandwidth limits (GB per hour). Soft cap triggers a 10s pause; hard cap waits until next hour.
  WORKER_MEDIA_BANDWIDTH_SOFT_CAP_GB: z.coerce.number().positive().default(3.5),
  WORKER_MEDIA_BANDWIDTH_HARD_CAP_GB: z.coerce.number().positive().default(4),

  // Replication Cadences (seconds after completion)
  CADENCE_PROPERTY: z.coerce.number().int().positive().default(60),
  CADENCE_MEMBER: z.coerce.number().int().positive().default(300),
  CADENCE_OFFICE: z.coerce.number().int().positive().default(300),
  CADENCE_OPEN_HOUSE: z.coerce.number().int().positive().default(300),
  CADENCE_LOOKUP: z.coerce.number().int().positive().default(86400),

  // Node
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function loadEnv(): Env {
  if (_env) return _env;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.flatten().fieldErrors;
    const messages = Object.entries(formatted)
      .map(([key, errors]) => `  ${key}: ${errors?.join(', ')}`)
      .join('\n');
    throw new Error(`Environment validation failed:\n${messages}`);
  }

  _env = result.data;
  return _env;
}

export function getEnv(): Env {
  if (!_env) {
    throw new Error('Environment not loaded. Call loadEnv() first.');
  }
  return _env;
}
