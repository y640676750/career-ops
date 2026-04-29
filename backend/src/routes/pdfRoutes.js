import { Router } from 'express';
import { env } from '../config/env.js';
import { getPdfJob, getPdfQueue } from '../queue/pdfQueue.js';
import { isRedisConfigured } from '../queue/redisConnection.js';
import { buildPdfDownloadUrl, pdfFileExists, resolvePdfFilePath, sanitizeFileStem } from '../utils/fileStore.js';

function buildBaseUrl(req) {
  if (env.publicBaseUrl) {
    return env.publicBaseUrl;
  }

  return `${req.protocol}://${req.get('host')}`;
}

function validatePayload(body = {}) {
  const hasHtml = typeof body.html === 'string' && body.html.trim().length > 0;
  const hasTemplateData = Boolean(body.templateData && typeof body.templateData === 'object');

  if (!hasHtml && !hasTemplateData) {
    const error = new Error('Either `html` or `templateData` is required.');
    error.statusCode = 400;
    throw error;
  }

  if (hasHtml && body.html.length > env.maxHtmlChars) {
    const error = new Error(`HTML payload exceeds ${env.maxHtmlChars} characters.`);
    error.statusCode = 413;
    throw error;
  }

  return {
    html: hasHtml ? body.html : undefined,
    templateName: typeof body.templateName === 'string' && body.templateName ? body.templateName : 'cv-template-minimal',
    templateData: hasTemplateData ? body.templateData : undefined,
    fileName: sanitizeFileStem(body.fileName || 'resume'),
    pdfOptions: typeof body.pdfOptions === 'object' && body.pdfOptions ? body.pdfOptions : {}
  };
}

function buildResult(baseUrl, result) {
  return {
    fileName: result.fileName,
    bytes: result.bytes,
    createdAt: result.createdAt,
    downloadUrl: buildPdfDownloadUrl(baseUrl, result.fileName)
  };
}

async function readJobStatus(req, res, next) {
  try {
    if (!isRedisConfigured()) {
      return res.status(503).json({
        status: 'error',
        message: 'REDIS_URL is not configured.'
      });
    }

    const job = await getPdfJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({
        status: 'error',
        message: 'Job not found.'
      });
    }

    const state = await job.getState();
    const baseUrl = buildBaseUrl(req);
    const response = {
      status: 'ok',
      jobId: String(job.id),
      state
    };

    if (job.returnvalue?.fileName) {
      response.result = buildResult(baseUrl, job.returnvalue);
    }

    if (state === 'failed') {
      response.failedReason = job.failedReason || 'PDF job failed.';
    }

    return res.json(response);
  } catch (error) {
    return next(error);
  }
}

async function enqueuePdfRender(req, res, next) {
  try {
    if (!isRedisConfigured()) {
      return res.status(503).json({
        status: 'error',
        message: 'REDIS_URL is required because PDF rendering is handled by the worker process.'
      });
    }

    const payload = validatePayload(req.body);
    const queue = getPdfQueue();
    const job = await queue.add('render-resume-pdf', payload);

    return res.status(202).json({
      status: 'ok',
      mode: 'queue',
      jobId: String(job.id),
      state: 'waiting',
      statusUrl: `${buildBaseUrl(req)}/api/v1/pdf/jobs/${encodeURIComponent(String(job.id))}`
    });
  } catch (error) {
    return next(error);
  }
}

export function createPdfRouter() {
  const router = Router();

  router.post('/render', enqueuePdfRender);
  router.post('/jobs', enqueuePdfRender);

  router.get('/jobs/:jobId', readJobStatus);

  router.get('/jobs/:jobId/file', async (req, res, next) => {
    try {
      if (!isRedisConfigured()) {
        return res.status(503).json({
          status: 'error',
          message: 'REDIS_URL is not configured.'
        });
      }

      const job = await getPdfJob(req.params.jobId);
      if (!job) {
        return res.status(404).json({
          status: 'error',
          message: 'Job not found.'
        });
      }

      const state = await job.getState();
      if (state !== 'completed' || !job.returnvalue?.fileName) {
        return res.status(409).json({
          status: 'error',
          message: `Job is currently ${state}.`
        });
      }

      const absolutePath = resolvePdfFilePath(job.returnvalue.fileName);
      if (!absolutePath || !(await pdfFileExists(job.returnvalue.fileName))) {
        return res.status(404).json({
          status: 'error',
          message: 'Rendered PDF file was not found on disk.'
        });
      }

      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.download(absolutePath, job.returnvalue.fileName);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/files/:fileName', async (req, res, next) => {
    try {
      const absolutePath = resolvePdfFilePath(req.params.fileName);
      if (!absolutePath || !(await pdfFileExists(req.params.fileName))) {
        return res.status(404).json({
          status: 'error',
          message: 'File not found.'
        });
      }

      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.download(absolutePath, req.params.fileName);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
