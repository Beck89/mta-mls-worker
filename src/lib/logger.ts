import pino from 'pino';
import { getEnv } from '../config/env.js';

let _logger: pino.Logger | null = null;

export function createLogger(): pino.Logger {
  if (_logger) return _logger;

  const env = getEnv();

  _logger = pino({
    level: env.WORKER_LOG_LEVEL,
    ...(env.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          },
        }
      : {}),
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      service: 'mta-mls-worker',
      env: env.NODE_ENV,
    },
  });

  return _logger;
}

export function getLogger(): pino.Logger {
  if (!_logger) {
    throw new Error('Logger not initialized. Call createLogger() first.');
  }
  return _logger;
}
