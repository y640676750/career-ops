import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { getRedisConnection, isRedisConfigured } from './redisConnection.js';

export const RESUME_QUEUE_NAME = 'career-ops-resume-customization';

let resumeQueue;

export function getResumeQueue() {
  if (!isRedisConfigured()) {
    return null;
  }

  if (!resumeQueue) {
    resumeQueue = new Queue(RESUME_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: env.resumeKeepCompletedJobs },
        removeOnFail: { count: env.resumeKeepFailedJobs }
      }
    });
  }

  return resumeQueue;
}

export async function getResumeQueueJob(jobId) {
  const queue = getResumeQueue();
  return queue ? queue.getJob(jobId) : null;
}

export async function closeResumeQueueResources() {
  if (resumeQueue) {
    await resumeQueue.close();
    resumeQueue = null;
  }
}
