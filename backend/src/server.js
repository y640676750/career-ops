import http from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePdfQueueResources } from './queue/pdfQueue.js';
import { closeRedisConnection } from './queue/redisConnection.js';
import { closeResumeQueueResources } from './queue/resumeQueue.js';

const app = createApp();
app.set('trust proxy', true);
const server = http.createServer(app);

server.keepAliveTimeout = 5000;
server.headersTimeout = 65000;
server.requestTimeout = env.serverRequestTimeoutMs;

async function shutdown(signal) {
  console.log(`[api] Received ${signal}, shutting down...`);

  server.close(async () => {
    try {
      await closeResumeQueueResources();
      await closePdfQueueResources();
      await closeRedisConnection();
      process.exit(0);
    } catch (error) {
      console.error('[api] Shutdown failed:', error);
      process.exit(1);
    }
  });

  setTimeout(() => {
    console.error('[api] Forced shutdown after timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGINT', () => {
  shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});

server.listen(env.port, env.host, () => {
  console.log(`[api] HTTP server listening on ${env.host}:${env.port}`);
});
