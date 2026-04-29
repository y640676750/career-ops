function formatMemoryMb(bytes) {
  return `${(Number(bytes || 0) / (1024 * 1024)).toFixed(1)}MB`;
}

function normalizeValue(value) {
  return String(value)
    .replace(/\s+/g, '_')
    .slice(0, 160);
}

function formatContext(details = {}) {
  return Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${normalizeValue(value)}`)
    .join(' ');
}

export function getWorkerMemorySnapshot() {
  const usage = process.memoryUsage();
  return `rss=${formatMemoryMb(usage.rss)} heapUsed=${formatMemoryMb(usage.heapUsed)} heapTotal=${formatMemoryMb(usage.heapTotal)} ext=${formatMemoryMb(usage.external)}`;
}

export function beginWorkerTask(scope, details = {}) {
  const startedAt = Date.now();
  const context = formatContext(details);
  console.log(`[worker:${scope}] start ${context} ${getWorkerMemorySnapshot()}`.trim());
  return {
    scope,
    details,
    startedAt
  };
}

export function finishWorkerTask(run, extra = {}) {
  const durationMs = Date.now() - run.startedAt;
  const context = formatContext({
    ...run.details,
    ...extra,
    durationMs
  });
  console.log(`[worker:${run.scope}] done ${context} ${getWorkerMemorySnapshot()}`.trim());
}

export function failWorkerTask(run, error, extra = {}) {
  const durationMs = Date.now() - run.startedAt;
  const context = formatContext({
    ...run.details,
    ...extra,
    durationMs,
    error: error?.message || 'unknown-error'
  });
  console.error(`[worker:${run.scope}] fail ${context} ${getWorkerMemorySnapshot()}`.trim());
  if (error?.stack) {
    console.error(error.stack);
  }
}

export function describePdfJob(job) {
  return {
    bullJobId: job?.id || '',
    template: job?.data?.templateName || '',
    file: job?.data?.fileName || '',
    format: job?.data?.pdfOptions?.format || 'a4'
  };
}

export function describePdfResult(result) {
  return {
    file: result?.fileName || '',
    bytes: result?.bytes || 0
  };
}

export function describeResumeJob(jobRecord, bullJobId = '') {
  const request = jobRecord?.request || {};

  if (!jobRecord) {
    return {
      bullJobId,
      type: 'missing-job-record'
    };
  }

  if (jobRecord.type === 'resume_parse_upload') {
    return {
      bullJobId,
      jobId: jobRecord.id,
      type: jobRecord.type,
      file: request.uploadedFile?.fileName || '',
      sizeBytes: request.uploadedFile?.sizeBytes || 0
    };
  }

  if (jobRecord.type === 'resume_jd_image_parse') {
    return {
      bullJobId,
      jobId: jobRecord.id,
      type: jobRecord.type,
      file: request.uploadedFile?.fileName || '',
      sizeBytes: request.uploadedFile?.sizeBytes || 0
    };
  }

  if (jobRecord.type === 'resume_builder_guided') {
    return {
      bullJobId,
      jobId: jobRecord.id,
      type: jobRecord.type,
      name: request.builderData?.name || '',
      targetRole: request.builderData?.targetRole || ''
    };
  }

  if (jobRecord.type === 'resume_batch_async') {
    return {
      bullJobId,
      jobId: jobRecord.id,
      type: jobRecord.type,
      items: Array.isArray(request.jobs) ? request.jobs.length : 0,
      templateId: request.templateId || '',
      resume: request.resumeSource?.fileName || ''
    };
  }

  return {
    bullJobId,
    jobId: jobRecord.id,
    type: jobRecord.type,
    company: request.job?.companyName || '',
    role: request.job?.roleTitle || '',
    templateId: request.options?.templateId || ''
  };
}

export function describeResumeResult(jobRecord) {
  if (!jobRecord) {
    return {};
  }

  if (jobRecord.type === 'resume_parse_upload') {
    return {
      status: jobRecord.status,
      textLength: jobRecord.result?.source?.textLength || 0,
      truncated: jobRecord.result?.source?.truncated ? 'yes' : 'no'
    };
  }

  if (jobRecord.type === 'resume_jd_image_parse') {
    return {
      status: jobRecord.status,
      company: jobRecord.result?.jobDraft?.companyName || '',
      role: jobRecord.result?.jobDraft?.roleTitle || ''
    };
  }

  if (jobRecord.type === 'resume_builder_guided') {
    return {
      status: jobRecord.status,
      mode: jobRecord.result?.mode || '',
      resumeTextLength: jobRecord.result?.source?.textLength || 0
    };
  }

  if (jobRecord.type === 'resume_batch_async') {
    return {
      status: jobRecord.status,
      total: jobRecord.result?.summary?.total || 0,
      completed: jobRecord.result?.summary?.completed || 0,
      failed: jobRecord.result?.summary?.failed || 0
    };
  }

  return {
    status: jobRecord.status,
    pdf: jobRecord.pdfFileName ? 'yes' : 'no',
    mode: jobRecord.result?.mode || ''
  };
}
