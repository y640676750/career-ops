import { Router } from 'express';
import { env } from '../config/env.js';
import { completeJob, createJob, failJob, getJob, listJobs } from '../data/jobStore.js';
import { attachOptionalSession, requireActiveEntitlement, requireSession } from '../middleware/sessionAuth.js';
import { getResumeQueue } from '../queue/resumeQueue.js';
import { runLowMemoryTask } from '../services/lowMemoryTaskQueue.js';
import { getJdImageUploadLimitBytes, jdImageUpload } from '../services/jdVisionService.js';
import { getResumeUploadLimitBytes, resumeUpload } from '../services/parserService.js';
import { processResumeQueueJob } from '../services/resumeJobProcessor.js';
import { renderHtmlToPdfSerial } from '../services/pdfRenderer.js';
import { customizeResume } from '../services/resumeCustomizer.js';
import { getResumeTemplate, listResumeTemplates } from '../services/resumeTemplateCatalog.js';
import { buildPdfDownloadUrl, pdfFileExists, resolvePdfFilePath, sanitizeFileStem } from '../utils/fileStore.js';

function buildBaseUrl(req) {
  if (env.publicBaseUrl) {
    return env.publicBaseUrl;
  }

  return `${req.protocol}://${req.get('host')}`;
}

function isWorkerQueueRequired() {
  return env.nodeEnv === 'production';
}

function getTimestampMs(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function failStaleJdVisionJob(job) {
  if (!job || job.type !== 'resume_jd_image_parse' || !['queued', 'processing'].includes(job.status)) {
    return job;
  }

  const referenceTime = getTimestampMs(job.updatedAt) || getTimestampMs(job.createdAt);
  const staleAfterMs = Number(env.visionTimeoutMs || 180000) + 30000;
  if (!referenceTime || Date.now() - referenceTime <= staleAfterMs) {
    return job;
  }

  return failJob(job.id, '截图识别超时，请重新上传更清晰的截图，或手动粘贴岗位 JD。');
}

async function enqueueResumeJob(jobRecord, queueName = 'resume-customization') {
  const queue = getResumeQueue();
  if (!queue) {
    if (isWorkerQueueRequired()) {
      const error = new Error('REDIS_URL is required to enqueue worker jobs in production.');
      error.statusCode = 503;
      throw error;
    }

    setImmediate(() => {
      runLowMemoryTask('resume-local-background-job', () => processResumeQueueJob(jobRecord.id)).catch((error) => {
        console.error(`[resume-job] Background processing failed for ${jobRecord.id}:`, error.message);
      });
    });

    return { mode: 'local-background' };
  }

  await queue.add(queueName, { jobId: jobRecord.id }, { jobId: jobRecord.id });
  return { mode: 'queue' };
}

function isVisibleResumeJob(job, session) {
  if (
    !job ||
    ![
      'resume_customization',
      'resume_customization_async',
      'resume_batch_async',
      'resume_parse_upload',
      'resume_builder_guided',
      'resume_jd_image_parse'
    ].includes(job.type)
  ) {
    return false;
  }

  if (session?.openId && job.ownerId && job.ownerId !== session.openId) {
    return false;
  }

  return true;
}

function normalizeString(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function buildBatchItemDownloadUrl(baseUrl, jobId, itemId) {
  return `${baseUrl}/api/v1/resume/jobs/${encodeURIComponent(jobId)}/items/${encodeURIComponent(itemId)}/pdf`;
}

function normalizeBatchItems(baseUrl, job) {
  if (job.type !== 'resume_batch_async') {
    return [];
  }

  const resultItems = Array.isArray(job.result?.items) ? job.result.items : [];
  const progressItems = Array.isArray(job.meta?.queueItems) ? job.meta.queueItems : [];
  const partialItems = Array.isArray(job.meta?.completedItems) ? job.meta.completedItems : [];
  const merged = new Map();

  for (const item of progressItems) {
    merged.set(item.itemId, { ...item });
  }

  for (const item of partialItems) {
    merged.set(item.itemId, { ...(merged.get(item.itemId) || {}), ...item });
  }

  for (const item of resultItems) {
    merged.set(item.itemId, { ...(merged.get(item.itemId) || {}), ...item });
  }

  return [...merged.values()]
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((item) => ({
      itemId: item.itemId,
      order: item.order || 0,
      companyName: item.companyName || '',
      roleTitle: item.roleTitle || '',
      descriptionPreview: item.descriptionPreview || '',
      status: item.status || 'queued',
      statusText: item.statusText || 'Queued',
      errorMessage: item.errorMessage || '',
      mode: item.mode || '',
      keywords: Array.isArray(item.keywords) ? item.keywords : [],
      notes: item.notes || '',
      template: item.template || null,
      pdf: item.pdf?.fileName
        ? {
            fileName: item.pdf.fileName,
            bytes: item.pdf.bytes,
            createdAt: item.pdf.createdAt,
            downloadUrl: buildBatchItemDownloadUrl(baseUrl, job.id, item.itemId),
            publicUrl: buildPdfDownloadUrl(baseUrl, item.pdf.fileName)
          }
        : null
    }));
}

function buildQueueSummary(job) {
  if (job.type !== 'resume_batch_async') {
    return null;
  }

  if (job.result?.summary) {
    return {
      total: job.result.summary.total || 0,
      completed: job.result.summary.completed || 0,
      failed: job.result.summary.failed || 0,
      pending: Math.max((job.result.summary.total || 0) - (job.result.summary.completed || 0) - (job.result.summary.failed || 0), 0),
      templateId: job.result.template?.id || '',
      templateName: job.result.template?.name || ''
    };
  }

  if (job.meta?.batch) {
    return {
      total: job.meta.batch.total || 0,
      completed: job.meta.batch.completed || 0,
      failed: job.meta.batch.failed || 0,
      pending: job.meta.batch.pending || 0,
      templateId: job.meta.batch.templateId || '',
      templateName: job.meta.batch.templateName || ''
    };
  }

  return null;
}

function buildResumeJobResponse(baseUrl, job) {
  if (!job) {
    return null;
  }

  const request = job.request || {};
  const requestJob = request.job || {};
  const requestOptions = request.options || {};
  const template = getResumeTemplate(requestOptions.templateId || request.templateId);

  return {
    jobId: job.id,
    type: job.type,
    jobStatus: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    errorMessage: job.errorMessage,
    statusUrl: `${baseUrl}/api/v1/resume/jobs/${encodeURIComponent(job.id)}`,
    requestMeta: {
      companyName: requestJob.companyName || '',
      roleTitle: requestJob.roleTitle || '',
      language: requestJob.language || '',
      renderPdf: requestOptions.renderPdf !== false,
      isAbstractMode: request.isAbstractMode === true || requestOptions.isAbstractMode === true,
      batchSize: Array.isArray(request.jobs) ? request.jobs.length : 0,
      templateId: template.id,
      templateName: template.name,
      resumeFileName: request.resumeSource?.fileName || ''
    },
    queueSummary: buildQueueSummary(job),
    items: normalizeBatchItems(baseUrl, job),
    result: job.result,
    pdf: job.pdfFileName
      ? {
          fileName: job.pdfFileName,
          downloadUrl: `${baseUrl}/api/v1/resume/jobs/${encodeURIComponent(job.id)}/pdf`,
          publicUrl: buildPdfDownloadUrl(baseUrl, job.pdfFileName)
        }
      : null
  };
}

function buildParseJobResponse(baseUrl, job) {
  const uploadedFile = job?.request?.uploadedFile || {};
  return {
    jobId: job.id,
    type: job.type,
    jobStatus: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    errorMessage: job.errorMessage,
    statusUrl: `${baseUrl}/api/v1/resume/files/parse/${encodeURIComponent(job.id)}`,
    file: {
      fileName: uploadedFile.fileName || '',
      sizeBytes: uploadedFile.sizeBytes || 0
    },
    source: job.result?.source || null
  };
}

function buildBuilderJobResponse(baseUrl, job) {
  return {
    jobId: job.id,
    type: job.type,
    jobStatus: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    errorMessage: job.errorMessage,
    statusUrl: `${baseUrl}/api/v1/resume/builder/jobs/${encodeURIComponent(job.id)}`,
    mode: job.result?.mode || '',
    notes: job.result?.notes || '',
    source: job.result?.source || null,
    candidate: job.result?.candidate || null
  };
}

function buildJdVisionJobResponse(baseUrl, job) {
  const uploadedFile = job?.request?.uploadedFile || {};
  return {
    jobId: job.id,
    type: job.type,
    jobStatus: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    errorMessage: job.errorMessage,
    statusUrl: `${baseUrl}/api/v1/resume/job-targets/vision/${encodeURIComponent(job.id)}`,
    file: {
      fileName: uploadedFile.fileName || '',
      sizeBytes: uploadedFile.sizeBytes || 0
    },
    mode: job.result?.mode || '',
    notes: job.result?.notes || '',
    targetJob: job.result?.jobDraft || null
  };
}

function validatePayload(body = {}) {
  const hasCandidate = Boolean(body.candidate && typeof body.candidate === 'object');
  const hasResumeMarkdown = typeof body.resumeMarkdown === 'string' && body.resumeMarkdown.trim().length > 0;
  const jobDescription = typeof body.job?.description === 'string' ? body.job.description.trim() : '';

  if (!hasCandidate && !hasResumeMarkdown) {
    const error = new Error('Either `candidate` or `resumeMarkdown` is required.');
    error.statusCode = 400;
    throw error;
  }

  if (!jobDescription) {
    const error = new Error('`job.description` is required.');
    error.statusCode = 400;
    throw error;
  }

  const options = body.options && typeof body.options === 'object' ? body.options : {};

  return {
    candidate: hasCandidate ? body.candidate : undefined,
    resumeMarkdown: hasResumeMarkdown ? body.resumeMarkdown.trim() : '',
    job: {
      companyName: typeof body.job.companyName === 'string' ? body.job.companyName.trim() : '',
      roleTitle: typeof body.job.roleTitle === 'string' ? body.job.roleTitle.trim() : '',
      description: jobDescription,
      language: typeof body.job.language === 'string' ? body.job.language.trim() : 'en'
    },
    options: {
      async: options.async === true,
      renderPdf: options.renderPdf !== false,
      isAbstractMode: options.isAbstractMode === true || body.isAbstractMode === true,
      fileName: sanitizeFileStem(options.fileName || `${body.job.companyName || 'resume'}-${body.job.roleTitle || 'customized'}`),
      pdfFormat: options.pdfFormat || 'a4',
      templateId: typeof options.templateId === 'string' ? options.templateId.trim() : ''
    }
  };
}

function validateBatchPayload(body = {}) {
  const resumeSource = body.resumeSource && typeof body.resumeSource === 'object' ? body.resumeSource : {};
  const resumeText = typeof resumeSource.resumeText === 'string' ? resumeSource.resumeText.trim() : '';
  const resumeCandidate = resumeSource.candidate && typeof resumeSource.candidate === 'object'
    ? resumeSource.candidate
    : null;
  const jobs = Array.isArray(body.jobs) ? body.jobs : [];
  const template = getResumeTemplate(typeof body.templateId === 'string' ? body.templateId.trim() : '');

  if (!resumeText && !resumeCandidate) {
    const error = new Error('`resumeSource.resumeText` or `resumeSource.candidate` is required.');
    error.statusCode = 400;
    throw error;
  }

  if (!jobs.length) {
    const error = new Error('At least one target job is required.');
    error.statusCode = 400;
    throw error;
  }

  if (jobs.length > env.maxBatchJobs) {
    const error = new Error(`You can submit up to ${env.maxBatchJobs} target jobs at once.`);
    error.statusCode = 400;
    throw error;
  }

  const normalizedJobs = jobs.map((job, index) => {
    const description = typeof job?.description === 'string' ? job.description.trim() : '';
    if (!description) {
      const error = new Error(`Job description is required for item ${index + 1}.`);
      error.statusCode = 400;
      throw error;
    }

    return {
      itemId: typeof job.itemId === 'string' && job.itemId.trim() ? job.itemId.trim() : `job-${index + 1}`,
      order: index + 1,
      companyName: typeof job.companyName === 'string' ? job.companyName.trim() : '',
      roleTitle: typeof job.roleTitle === 'string' ? job.roleTitle.trim() : '',
      description,
      language: typeof job.language === 'string' && job.language.trim() ? job.language.trim() : 'zh'
    };
  });

  return {
    resumeSource: {
      fileName: typeof resumeSource.fileName === 'string' ? resumeSource.fileName.trim() : 'resume',
      fileType: typeof resumeSource.fileType === 'string' ? resumeSource.fileType.trim() : '',
      textLength: Number(resumeSource.textLength || resumeText.length),
      truncated: resumeSource.truncated === true,
      candidate: resumeCandidate,
      resumeText
    },
    templateId: template.id,
    isAbstractMode: body.isAbstractMode === true || body.options?.isAbstractMode === true,
    jobs: normalizedJobs,
    options: {
      renderPdf: body.options?.renderPdf !== false,
      pdfFormat: body.options?.pdfFormat || 'a4'
    }
  };
}

function validateBuilderPayload(body = {}) {
  const payload = {
    name: normalizeString(body.name),
    targetRole: normalizeString(body.targetRole || body.roleTitle),
    contact: normalizeString(body.contact),
    educationSchool: normalizeString(body.educationSchool || body.school),
    educationMajor: normalizeString(body.educationMajor || body.major),
    educationYear: normalizeString(body.educationYear || body.graduationYear),
    storyTitle: normalizeString(body.storyTitle || body.organizationName),
    storyRole: normalizeString(body.storyRole || body.roleName),
    storyText: normalizeString(body.storyText || body.experienceSummary),
    language: normalizeString(body.language, 'zh')
  };

  if (!payload.name) {
    const error = new Error('`name` is required.');
    error.statusCode = 400;
    throw error;
  }

  if (!payload.targetRole) {
    const error = new Error('`targetRole` is required.');
    error.statusCode = 400;
    throw error;
  }

  return payload;
}

async function runSyncCustomizationJob(req, payload) {
  const template = getResumeTemplate(payload.options.templateId);
  const jobRecord = createJob('resume_customization', payload, {
    ownerId: req.session?.openId || null
  });

  try {
    const customization = await customizeResume(payload);
    const result = {
      mode: customization.mode,
      keywords: customization.keywords,
      notes: customization.notes,
      candidate: customization.candidate,
      templateData: customization.templateData,
      template: {
        id: template.id,
        name: template.name
      }
    };

    let pdfFileName = null;
    if (payload.options.renderPdf) {
      const pdfResult = await renderHtmlToPdfSerial({
        templateName: template.templateName,
        templateData: customization.templateData,
        fileName: payload.options.fileName,
        pdfOptions: { format: payload.options.pdfFormat }
      });

      result.pdf = {
        fileName: pdfResult.fileName,
        bytes: pdfResult.bytes,
        createdAt: pdfResult.createdAt
      };
      pdfFileName = pdfResult.fileName;
    }

    return completeJob(jobRecord.id, result, pdfFileName);
  } catch (error) {
    failJob(jobRecord.id, error.message || 'Resume customization failed.');
    throw error;
  }
}

async function runAsyncCustomizationJob(req, payload) {
  const jobRecord = createJob('resume_customization_async', payload, {
    status: 'queued',
    ownerId: req.session?.openId || null
  });
  const queueState = await enqueueResumeJob(jobRecord);

  return {
    queueMode: queueState.mode,
    job: getJob(jobRecord.id)
  };
}

async function runBatchCustomizationJob(req, payload) {
  const template = getResumeTemplate(payload.templateId);
  const meta = {
    batch: {
      total: payload.jobs.length,
      completed: 0,
      failed: 0,
      pending: payload.jobs.length,
      templateId: template.id,
      templateName: template.name,
      resumeFileName: payload.resumeSource.fileName
    },
    queueItems: payload.jobs.map((job) => ({
      itemId: job.itemId,
      order: job.order,
      companyName: job.companyName,
      roleTitle: job.roleTitle,
      descriptionPreview: job.description.replace(/\s+/g, ' ').trim().slice(0, 120),
      status: 'queued',
      statusText: 'Queued'
    })),
    completedItems: []
  };

  const jobRecord = createJob('resume_batch_async', payload, {
    status: 'queued',
    ownerId: req.session?.openId || null,
    meta
  });
  const queueState = await enqueueResumeJob(jobRecord, 'resume-batch');

  return {
    queueMode: queueState.mode,
    job: getJob(jobRecord.id)
  };
}

async function runGuidedBuilderJob(req, payload) {
  const jobRecord = createJob(
    'resume_builder_guided',
    {
      builderData: payload
    },
    {
      status: 'queued',
      ownerId: req.session?.openId || null
    }
  );

  const queueState = await enqueueResumeJob(jobRecord, 'resume-builder');
  return {
    queueMode: queueState.mode,
    job: getJob(jobRecord.id)
  };
}

async function runParseUploadJob(req, file) {
  const jobRecord = createJob(
    'resume_parse_upload',
    {
      uploadedFile: {
        tempPath: file.path,
        fileName: file.originalname,
        sizeBytes: Number(file.size || 0),
        mimeType: file.mimetype || ''
      }
    },
    {
      status: 'queued',
      ownerId: req.session?.openId || null
    }
  );

  const queueState = await enqueueResumeJob(jobRecord, 'resume-parse');
  return {
    queueMode: queueState.mode,
    job: getJob(jobRecord.id)
  };
}

async function runJdImageVisionJob(req, file) {
  const jobRecord = createJob(
    'resume_jd_image_parse',
    {
      uploadedFile: {
        tempPath: file.path,
        fileName: file.originalname,
        sizeBytes: Number(file.size || 0),
        mimeType: file.mimetype || ''
      }
    },
    {
      status: 'queued',
      ownerId: req.session?.openId || null
    }
  );

  const queueState = await enqueueResumeJob(jobRecord, 'resume-jd-vision');
  return {
    queueMode: queueState.mode,
    job: getJob(jobRecord.id)
  };
}

export function createResumeRouter() {
  const router = Router();
  router.use(attachOptionalSession);

  router.get('/templates', (req, res) => {
    res.json({
      status: 'ok',
      items: listResumeTemplates()
    });
  });

  router.post('/builder/generate', requireSession, requireActiveEntitlement, async (req, res, next) => {
    try {
      const payload = validateBuilderPayload(req.body);
      const queued = await runGuidedBuilderJob(req, payload);

      return res.status(202).json({
        status: 'ok',
        mode: queued.queueMode,
        ...buildBuilderJobResponse(buildBaseUrl(req), queued.job)
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/builder/jobs/:jobId', requireSession, (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job || job.type !== 'resume_builder_guided' || !isVisibleResumeJob(job, req.session)) {
      return res.status(404).json({
        status: 'error',
        message: 'Guided resume job not found.'
      });
    }

    return res.json({
      status: 'ok',
      ...buildBuilderJobResponse(buildBaseUrl(req), job)
    });
  });

  router.post('/files/parse', requireSession, requireActiveEntitlement, (req, res, next) => {
    resumeUpload.single('resumeFile')(req, res, async (error) => {
      try {
        if (error) {
          if (error?.name === 'MulterError' && error.code === 'LIMIT_FILE_SIZE') {
            error.statusCode = 413;
            error.message = `Resume file exceeds ${getResumeUploadLimitBytes()} bytes.`;
          } else if (!error.statusCode) {
            error.statusCode = 400;
          }

          throw error;
        }

        if (!req.file) {
          const uploadError = new Error('`resumeFile` upload is required.');
          uploadError.statusCode = 400;
          throw uploadError;
        }

        const queued = await runParseUploadJob(req, req.file);
        return res.status(202).json({
          status: 'ok',
          mode: queued.queueMode,
          ...buildParseJobResponse(buildBaseUrl(req), queued.job)
        });
      } catch (uploadError) {
        return next(uploadError);
      }
    });
  });

  router.get('/files/parse/:jobId', requireSession, (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job || job.type !== 'resume_parse_upload' || !isVisibleResumeJob(job, req.session)) {
      return res.status(404).json({
        status: 'error',
        message: 'Resume parse job not found.'
      });
    }

    return res.json({
      status: 'ok',
      ...buildParseJobResponse(buildBaseUrl(req), job)
    });
  });

  router.post('/job-targets/vision', requireSession, requireActiveEntitlement, (req, res, next) => {
    jdImageUpload.single('jdImage')(req, res, async (error) => {
      try {
        if (error) {
          if (error?.name === 'MulterError' && error.code === 'LIMIT_FILE_SIZE') {
            error.statusCode = 413;
            error.message = `JD screenshot exceeds ${getJdImageUploadLimitBytes()} bytes.`;
          } else if (!error.statusCode) {
            error.statusCode = 400;
          }

          throw error;
        }

        if (!req.file) {
          const uploadError = new Error('`jdImage` upload is required.');
          uploadError.statusCode = 400;
          throw uploadError;
        }

        const queued = await runJdImageVisionJob(req, req.file);
        return res.status(202).json({
          status: 'ok',
          mode: queued.queueMode,
          ...buildJdVisionJobResponse(buildBaseUrl(req), queued.job)
        });
      } catch (uploadError) {
        return next(uploadError);
      }
    });
  });

  router.get('/job-targets/vision/:jobId', requireSession, (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job || job.type !== 'resume_jd_image_parse' || !isVisibleResumeJob(job, req.session)) {
      return res.status(404).json({
        status: 'error',
        message: 'JD screenshot job not found.'
      });
    }

    const responseJob = failStaleJdVisionJob(job);
    return res.json({
      status: 'ok',
      ...buildJdVisionJobResponse(buildBaseUrl(req), responseJob)
    });
  });

  router.post('/customize', requireSession, requireActiveEntitlement, async (req, res, next) => {
    try {
      const payload = validatePayload(req.body);
      if (payload.options.async) {
        const queued = await runAsyncCustomizationJob(req, payload);
        return res.status(202).json({
          status: 'ok',
          mode: queued.queueMode,
          ...buildResumeJobResponse(buildBaseUrl(req), queued.job)
        });
      }

      const completedJob = await runSyncCustomizationJob(req, payload);
      return res.status(201).json({
        status: 'ok',
        ...buildResumeJobResponse(buildBaseUrl(req), completedJob)
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/customize/async', requireSession, requireActiveEntitlement, async (req, res, next) => {
    try {
      const payload = validatePayload({
        ...(req.body || {}),
        options: {
          ...((req.body && req.body.options) || {}),
          async: true
        }
      });
      const queued = await runAsyncCustomizationJob(req, payload);

      return res.status(202).json({
        status: 'ok',
        mode: queued.queueMode,
        ...buildResumeJobResponse(buildBaseUrl(req), queued.job)
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/customize/batch', requireSession, requireActiveEntitlement, async (req, res, next) => {
    try {
      const payload = validateBatchPayload(req.body);
      const queued = await runBatchCustomizationJob(req, payload);

      return res.status(202).json({
        status: 'ok',
        mode: queued.queueMode,
        ...buildResumeJobResponse(buildBaseUrl(req), queued.job)
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/jobs', (req, res) => {
    const limit = Number.parseInt(req.query.limit, 10);
    const type = req.query.type === 'async'
      ? 'resume_customization_async'
      : req.query.type === 'sync'
        ? 'resume_customization'
        : req.query.type === 'batch'
          ? 'resume_batch_async'
          : null;
    const jobs = listJobs(limit, type, req.session?.openId || null)
      .filter((job) => ['resume_customization', 'resume_customization_async', 'resume_batch_async'].includes(job.type));

    res.json({
      status: 'ok',
      items: jobs.map((job) => buildResumeJobResponse(buildBaseUrl(req), job))
    });
  });

  router.get('/jobs/:jobId', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!isVisibleResumeJob(job, req.session) || job.type === 'resume_parse_upload') {
      return res.status(404).json({
        status: 'error',
        message: 'Resume customization job not found.'
      });
    }

    return res.json({
      status: 'ok',
      ...buildResumeJobResponse(buildBaseUrl(req), job)
    });
  });

  router.get('/jobs/:jobId/items/:itemId/pdf', async (req, res, next) => {
    try {
      const job = getJob(req.params.jobId);
      if (!isVisibleResumeJob(job, req.session)) {
        return res.status(404).json({
          status: 'error',
          message: 'Resume customization job not found.'
        });
      }

      const targetItem = normalizeBatchItems(buildBaseUrl(req), job)
        .find((item) => item.itemId === req.params.itemId);
      if (!targetItem?.pdf?.fileName) {
        return res.status(404).json({
          status: 'error',
          message: 'Rendered PDF not found for this batch item.'
        });
      }

      const absolutePath = resolvePdfFilePath(targetItem.pdf.fileName);
      if (!absolutePath || !(await pdfFileExists(targetItem.pdf.fileName))) {
        return res.status(404).json({
          status: 'error',
          message: 'Rendered PDF file is missing on disk.'
        });
      }

      return res.download(absolutePath, targetItem.pdf.fileName);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/jobs/:jobId/pdf', async (req, res, next) => {
    try {
      const job = getJob(req.params.jobId);
      if (!isVisibleResumeJob(job, req.session) || !job.pdfFileName) {
        return res.status(404).json({
          status: 'error',
          message: 'Rendered PDF not found for this job.'
        });
      }

      const absolutePath = resolvePdfFilePath(job.pdfFileName);
      if (!absolutePath || !(await pdfFileExists(job.pdfFileName))) {
        return res.status(404).json({
          status: 'error',
          message: 'Rendered PDF file is missing on disk.'
        });
      }

      return res.download(absolutePath, job.pdfFileName);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
