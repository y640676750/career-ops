import { Worker } from 'bullmq';
import { env } from '../config/env.js';
import { getJob } from '../data/jobStore.js';
import { getRedisConnection, isRedisConfigured } from '../queue/redisConnection.js';
import { RESUME_QUEUE_NAME } from '../queue/resumeQueue.js';
import { runLowMemoryTask } from '../services/lowMemoryTaskQueue.js';
import { processResumeQueueJob } from '../services/resumeJobProcessor.js';
import {
  beginWorkerTask,
  describeResumeJob,
  describeResumeResult,
  failWorkerTask,
  finishWorkerTask
} from '../utils/workerLog.js';

export function createResumeQueueWorker() {
  if (!isRedisConfigured()) {
    return null;
  }

  const worker = new Worker(
    RESUME_QUEUE_NAME,
    async (job) => {
      const jobId = job.data?.jobId || String(job.id);
      const jobRecord = getJob(jobId);
      const run = beginWorkerTask('resume', describeResumeJob(jobRecord, job.id));

      try {
        const result = await runLowMemoryTask('resume-worker-job', () => processResumeQueueJob(jobId));
        finishWorkerTask(run, describeResumeResult(result));
        return result;
      } catch (error) {
        failWorkerTask(run, error);
        throw error;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 1,
      lockDuration: env.resumeJobTimeoutMs + 30000,
      stalledInterval: 30000,
      maxStalledCount: 1
    }
  );

  worker.on('ready', () => {
    console.log(`[worker] Resume worker is ready with concurrency=1 pid=${process.pid}`);
  });

  worker.on('error', (error) => {
    console.error('[worker] Resume worker error:', error);
  });

  return worker;
}
