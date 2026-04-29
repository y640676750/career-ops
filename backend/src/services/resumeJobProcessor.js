import path from 'node:path';
import { env } from '../config/env.js';
import { completeJob, failJob, getJob, updateJobStatus } from '../data/jobStore.js';
import { sanitizeFileStem } from '../utils/fileStore.js';
import { createResumeSourceFromGuidedInput } from './guidedResumeBuilder.js';
import { parseJdScreenshotImage } from './jdVisionService.js';
import { renderHtmlToPdfSerial } from './pdfRenderer.js';
import { parseUploadedResumeFile } from './parserService.js';
import { customizeResume } from './resumeCustomizer.js';
import { getResumeTemplate } from './resumeTemplateCatalog.js';

function createSingleResult(customization, template) {
  return {
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
}

function buildBatchQueueItem(target, index) {
  return {
    itemId: target.itemId,
    order: index + 1,
    companyName: target.companyName,
    roleTitle: target.roleTitle,
    descriptionPreview: String(target.description || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    status: 'queued',
    statusText: 'Queued'
  };
}

function createBatchMeta(jobRecord, template, queueItems, completedItems = []) {
  const completedCount = queueItems.filter((item) => item.status === 'completed').length;
  const failedCount = queueItems.filter((item) => item.status === 'failed').length;
  const pendingCount = queueItems.filter((item) => ['queued', 'processing'].includes(item.status)).length;

  return {
    batch: {
      templateId: template.id,
      templateName: template.name,
      total: queueItems.length,
      completed: completedCount,
      failed: failedCount,
      pending: pendingCount,
      resumeFileName: jobRecord.request?.resumeSource?.fileName || ''
    },
    queueItems,
    completedItems
  };
}

function createBatchCompletedItem(template, target, customization, pdfResult, errorMessage = '') {
  return {
    itemId: target.itemId,
    order: target.order,
    companyName: target.companyName,
    roleTitle: target.roleTitle,
    descriptionPreview: String(target.description || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    status: errorMessage ? 'failed' : 'completed',
    statusText: errorMessage ? 'Failed' : 'Completed',
    errorMessage,
    mode: customization?.mode || '',
    keywords: customization?.keywords || [],
    notes: customization?.notes || '',
    template: {
      id: template.id,
      name: template.name
    },
    pdf: pdfResult
      ? {
          fileName: pdfResult.fileName,
          bytes: pdfResult.bytes,
          createdAt: pdfResult.createdAt
        }
      : null
  };
}

function buildUploadedFilePayload(jobRecord) {
  const uploadedFile = jobRecord.request?.uploadedFile || {};
  const tempPath = uploadedFile.tempPath || '';
  return {
    path: tempPath,
    originalname: uploadedFile.fileName || path.basename(tempPath || 'resume'),
    filename: path.basename(tempPath || uploadedFile.fileName || 'resume'),
    size: uploadedFile.sizeBytes || 0,
    mimetype: uploadedFile.mimeType || ''
  };
}

function withTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(message);
      error.statusCode = 504;
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

async function processParseUploadJob(jobRecord) {
  updateJobStatus(jobRecord.id, 'processing', {
    parse: {
      fileName: jobRecord.request?.uploadedFile?.fileName || '',
      sizeBytes: jobRecord.request?.uploadedFile?.sizeBytes || 0
    }
  });

  try {
    const source = await parseUploadedResumeFile(buildUploadedFilePayload(jobRecord));
    return completeJob(jobRecord.id, { source });
  } catch (error) {
    failJob(jobRecord.id, error.message || 'Resume file parsing failed.');
    throw error;
  }
}

async function processGuidedBuilderJob(jobRecord) {
  updateJobStatus(jobRecord.id, 'processing', {
    builder: {
      name: jobRecord.request?.builderData?.name || '',
      targetRole: jobRecord.request?.builderData?.targetRole || ''
    }
  });

  try {
    const result = await createResumeSourceFromGuidedInput(jobRecord.request?.builderData || {});
    return completeJob(jobRecord.id, result);
  } catch (error) {
    failJob(jobRecord.id, error.message || 'Guided resume builder failed.');
    throw error;
  }
}

async function processJdImageParseJob(jobRecord) {
  updateJobStatus(jobRecord.id, 'processing', {
    vision: {
      fileName: jobRecord.request?.uploadedFile?.fileName || '',
      sizeBytes: jobRecord.request?.uploadedFile?.sizeBytes || 0
    }
  });

  try {
    const jobDraft = await withTimeout(
      parseJdScreenshotImage(buildUploadedFilePayload(jobRecord)),
      Number(env.visionTimeoutMs || 180000) + 10000,
      '截图识别超时，请重新上传更清晰的截图，或手动粘贴岗位 JD。'
    );
    return completeJob(jobRecord.id, { jobDraft });
  } catch (error) {
    failJob(jobRecord.id, error.message || 'JD screenshot parsing failed.');
    throw error;
  }
}

async function processSingleResumeJob(jobRecord) {
  const template = getResumeTemplate(jobRecord.request?.options?.templateId);
  updateJobStatus(jobRecord.id, 'processing');

  try {
    const customization = await customizeResume(jobRecord.request || {});
    const result = createSingleResult(customization, template);

    let pdfFileName = null;
    if (jobRecord.request?.options?.renderPdf) {
      const pdfResult = await renderHtmlToPdfSerial({
        templateName: template.templateName,
        templateData: customization.templateData,
        fileName: jobRecord.request.options.fileName,
        pdfOptions: { format: jobRecord.request.options.pdfFormat }
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

async function processResumeBatchJob(jobRecord) {
  const template = getResumeTemplate(jobRecord.request?.templateId);
  const resumeSource = jobRecord.request?.resumeSource || {};
  const baseCandidate = resumeSource.candidate && typeof resumeSource.candidate === 'object'
    ? resumeSource.candidate
    : null;
  const targets = Array.isArray(jobRecord.request?.jobs) ? jobRecord.request.jobs : [];
  const queueItems = targets.map((target, index) => buildBatchQueueItem(target, index));
  const completedItems = [];

  updateJobStatus(jobRecord.id, 'processing', createBatchMeta(jobRecord, template, queueItems, completedItems));

  try {
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      queueItems[index] = {
        ...queueItems[index],
        status: 'processing',
        statusText: 'Processing'
      };
      updateJobStatus(jobRecord.id, 'processing', createBatchMeta(jobRecord, template, queueItems, completedItems));

      try {
        const customization = await customizeResume({
          candidate: baseCandidate || undefined,
          resumeMarkdown: baseCandidate ? '' : resumeSource.resumeText,
          isAbstractMode: jobRecord.request?.isAbstractMode === true,
          job: target,
          options: {
            renderPdf: jobRecord.request?.options?.renderPdf !== false,
            templateId: template.id
          }
        });

        let pdfResult = null;
        if (jobRecord.request?.options?.renderPdf !== false) {
          const baseName = sanitizeFileStem(
            `${resumeSource.fileName || 'resume'}-${target.companyName || 'company'}-${target.roleTitle || 'role'}-${template.name}`
          );
          pdfResult = await renderHtmlToPdfSerial({
            templateName: template.templateName,
            templateData: customization.templateData,
            fileName: baseName,
            pdfOptions: { format: jobRecord.request?.options?.pdfFormat }
          });
        }

        queueItems[index] = {
          ...queueItems[index],
          status: 'completed',
          statusText: 'Completed'
        };
        completedItems.push(createBatchCompletedItem(template, target, customization, pdfResult));
      } catch (error) {
        queueItems[index] = {
          ...queueItems[index],
          status: 'failed',
          statusText: 'Failed'
        };
        completedItems.push(
          createBatchCompletedItem(template, target, null, null, error.message || 'Resume customization failed.')
        );
      }

      updateJobStatus(jobRecord.id, 'processing', createBatchMeta(jobRecord, template, queueItems, completedItems));
    }

    return completeJob(jobRecord.id, {
      template: {
        id: template.id,
        name: template.name
      },
      summary: {
        total: queueItems.length,
        completed: completedItems.filter((item) => item.status === 'completed').length,
        failed: completedItems.filter((item) => item.status === 'failed').length
      },
      source: {
        fileName: resumeSource.fileName || '',
        fileType: resumeSource.fileType || '',
        textLength: resumeSource.textLength || String(resumeSource.resumeText || '').length
      },
      items: completedItems
    });
  } catch (error) {
    failJob(jobRecord.id, error.message || 'Batch resume customization failed.');
    throw error;
  }
}

export async function processResumeQueueJob(jobId) {
  const jobRecord = getJob(jobId);
  if (
    !jobRecord ||
    ![
      'resume_parse_upload',
      'resume_builder_guided',
      'resume_jd_image_parse',
      'resume_customization_async',
      'resume_batch_async'
    ].includes(jobRecord.type)
  ) {
    throw new Error(`Resume job ${jobId} was not found.`);
  }

  if (jobRecord.type === 'resume_parse_upload') {
    return processParseUploadJob(jobRecord);
  }

  if (jobRecord.type === 'resume_builder_guided') {
    return processGuidedBuilderJob(jobRecord);
  }

  if (jobRecord.type === 'resume_jd_image_parse') {
    return processJdImageParseJob(jobRecord);
  }

  if (jobRecord.type === 'resume_batch_async') {
    return processResumeBatchJob(jobRecord);
  }

  return processSingleResumeJob(jobRecord);
}

export const processResumeCustomizationJob = processResumeQueueJob;
