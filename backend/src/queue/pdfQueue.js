import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { getRedisConnection, isRedisConfigured } from './redisConnection.js';

export const PDF_QUEUE_NAME = 'career-ops-resume-pdf-render';

let pdfQueue;

export function getPdfQueue() {
  if (!isRedisConfigured()) {
    return null;
  }

  if (!pdfQueue) {
    pdfQueue = new Queue(PDF_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: env.pdfKeepCompletedJobs },
        removeOnFail: { count: env.pdfKeepFailedJobs }
      }
    });
  }

  return pdfQueue;
}

export async function getPdfJob(jobId) {
  const queue = getPdfQueue();
  return queue ? queue.getJob(jobId) : null;
}

export async function closePdfQueueResources() {
  if (pdfQueue) {
    await pdfQueue.close();
    pdfQueue = null;
  }
}
