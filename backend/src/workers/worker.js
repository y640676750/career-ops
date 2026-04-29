import { Worker } from 'bullmq';
import { env } from '../config/env.js';
import { closePdfQueueResources, PDF_QUEUE_NAME } from '../queue/pdfQueue.js';
import { closeRedisConnection, getRedisConnection, isRedisConfigured } from '../queue/redisConnection.js';
import { closeResumeQueueResources } from '../queue/resumeQueue.js';
import { runLowMemoryTask } from '../services/lowMemoryTaskQueue.js';
import { renderHtmlToPdfSerial } from '../services/pdfRenderer.js';
import { beginWorkerTask, describePdfJob, describePdfResult, failWorkerTask, finishWorkerTask } from '../utils/workerLog.js';
import { createResumeQueueWorker } from './resumeQueueWorker.js';

if (!isRedisConfigured()) {
  throw new Error('REDIS_URL is required to start the worker.');
}

const pdfWorker = new Worker(
  PDF_QUEUE_NAME,
  async (job) => {
    const run = beginWorkerTask('pdf', describePdfJob(job));

    try {
      const result = await runLowMemoryTask('pdf-worker-job', () => renderHtmlToPdfSerial(job.data || {}));
      finishWorkerTask(run, describePdfResult(result));
      return result;
    } catch (error) {
      failWorkerTask(run, error);
      throw error;
    }
  },
  {
    connection: getRedisConnection(),
    concurrency: 1,
    lockDuration: env.pdfRenderTimeoutMs + 30000,
    stalledInterval: 30000,
    maxStalledCount: 1
  }
);

pdfWorker.on('ready', () => {
  console.log(`[worker] PDF worker is ready with concurrency=1 pid=${process.pid}`);
});

pdfWorker.on('error', (error) => {
  console.error('[worker] PDF worker error:', error);
});

const resumeWorker = createResumeQueueWorker();

async function shutdown(signal) {
  console.log(`[worker] Received ${signal}, shutting down...`);

  try {
    if (resumeWorker) {
      await resumeWorker.close();
    }
    await pdfWorker.close();
    await closeResumeQueueResources();
    await closePdfQueueResources();
    await closeRedisConnection();
    process.exit(0);
  } catch (error) {
    console.error('[worker] Shutdown failed:', error);
    process.exit(1);
  }
}

console.log(`[worker] Career Ops worker process online pid=${process.pid}`);

process.on('SIGINT', () => {
  shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
