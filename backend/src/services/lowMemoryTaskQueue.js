import pLimit from 'p-limit';

const lowMemoryLimit = pLimit(1);

export function runLowMemoryTask(taskName, task) {
  return lowMemoryLimit(async () => {
    return task();
  });
}

export function getLowMemoryQueueSettings() {
  return Object.freeze({
    concurrency: 1
  });
}
