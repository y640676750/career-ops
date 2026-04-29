import IORedis from 'ioredis';
import { env } from '../config/env.js';

let redisConnection;

export function isRedisConfigured() {
  return Boolean(env.redisUrl);
}

export function getRedisConnection() {
  if (!isRedisConfigured()) {
    return null;
  }

  if (!redisConnection) {
    redisConnection = new IORedis(env.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: false,
      connectTimeout: 10000,
      retryStrategy(times) {
        return Math.min(times * 200, 2000);
      }
    });

    redisConnection.on('error', (error) => {
      console.error('[redis] Connection error:', error.message);
    });
  }

  return redisConnection;
}

export async function closeRedisConnection() {
  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
  }
}
