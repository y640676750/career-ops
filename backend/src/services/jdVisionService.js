import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { env } from '../config/env.js';
import { extractTargetJobFromVisionImage } from './deepseekClient.js';
import { runGarbageCollectionIfAvailable } from '../utils/memory.js';

const MAX_JD_IMAGE_BYTES = env.maxJdImageBytes;
const SUPPORTED_IMAGE_EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp']
]);

fs.mkdirSync(env.uploadTempDir, { recursive: true });

function getUploadExtension(fileName) {
  return path.extname(String(fileName || '')).toLowerCase();
}

function sanitizeSegment(value, fallback) {
  const segment = String(value || fallback)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return segment || fallback;
}

function createTempFileName(originalName) {
  const extension = getUploadExtension(originalName);
  const fallbackExtension = SUPPORTED_IMAGE_EXTENSIONS.has(extension) ? extension : '.png';
  const stem = sanitizeSegment(path.basename(String(originalName || 'jd-screenshot'), extension), 'jd-screenshot');
  return `${stem}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${fallbackExtension}`;
}

function assertSupportedImage(file) {
  const extension = getUploadExtension(file?.originalname || file?.filename);
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
    const error = new Error('仅支持 PNG、JPG、JPEG、WEBP 格式的 JD 截图。');
    error.statusCode = 400;
    throw error;
  }

  return extension;
}

function detectImageMimeType(buffer, fallbackMimeType) {
  if (buffer?.length >= 12) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return 'image/png';
    }

    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'image/jpeg';
    }

    if (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return 'image/webp';
    }
  }

  return fallbackMimeType || 'image/png';
}

async function removeTempFile(absolutePath) {
  if (!absolutePath) {
    return;
  }

  try {
    await fsPromises.unlink(absolutePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

function normalizeVisionJobDraft(payload) {
  const companyName = String(payload?.companyName || '').trim();
  const roleTitle = String(payload?.roleTitle || '').trim();
  const description = String(payload?.description || '').trim();

  if (!description) {
    const error = new Error('截图识别没有提取到可用的岗位详情。');
    error.statusCode = 422;
    throw error;
  }

  return {
    companyName,
    roleTitle,
    description,
    descriptionPreview: description.replace(/\s+/g, ' ').trim().slice(0, 120),
    confidence: String(payload?.confidence || '').trim(),
    rawText: String(payload?.rawText || '').trim()
  };
}

export const jdImageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      callback(null, env.uploadTempDir);
    },
    filename: (_req, file, callback) => {
      callback(null, createTempFileName(file.originalname));
    }
  }),
  limits: {
    fileSize: MAX_JD_IMAGE_BYTES
  },
  fileFilter: (_req, file, callback) => {
    const extension = getUploadExtension(file.originalname);
    if (SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
      callback(null, true);
      return;
    }

    const error = new Error('仅支持 PNG、JPG、JPEG、WEBP 格式的 JD 截图。');
    error.statusCode = 400;
    callback(error);
  }
});

export function getJdImageUploadLimitBytes() {
  return MAX_JD_IMAGE_BYTES;
}

export async function parseJdScreenshotImage(file) {
  const extension = assertSupportedImage(file);
  let mimeType = file?.mimetype || SUPPORTED_IMAGE_EXTENSIONS.get(extension) || 'image/png';

  let buffer = null;
  let base64Data = '';

  try {
    buffer = await fsPromises.readFile(file.path);
    mimeType = detectImageMimeType(buffer, mimeType);
    base64Data = buffer.toString('base64');

    const extracted = await extractTargetJobFromVisionImage({
      mimeType,
      base64Data,
      fileName: file.originalname || file.filename || 'jd-screenshot'
    });

    return normalizeVisionJobDraft(extracted);
  } catch (error) {
    if (error?.code === 'MODEL_JSON_INVALID' || error?.code === 'VISION_RESULT_INVALID' || /json/i.test(String(error?.message || ''))) {
      const friendlyError = new Error('岗位截图识别结果不完整，请换一张更清晰的截图，或直接粘贴岗位 JD。');
      friendlyError.statusCode = 422;
      throw friendlyError;
    }

    throw error;
  } finally {
    if (buffer) {
      buffer.fill(0);
      buffer = null;
    }

    base64Data = '';
    await removeTempFile(file?.path);
    runGarbageCollectionIfAvailable();
  }
}
