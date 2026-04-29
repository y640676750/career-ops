import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import { env } from '../config/env.js';
import { runGarbageCollectionIfAvailable } from '../utils/memory.js';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), 'career-ops-uploads');
const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.doc', '.docx']);
const SAFE_FILE_NAME = /[^a-zA-Z0-9._-]+/g;
const legacyWordExtractor = new WordExtractor();

fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });

function sanitizeUploadSegment(value, fallback) {
  const segment = String(value || fallback)
    .replace(SAFE_FILE_NAME, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return segment || fallback;
}

function getUploadExtension(fileName) {
  return path.extname(String(fileName || '')).toLowerCase();
}

function sanitizeUploadFileName(fileName) {
  const safeBase = path.basename(String(fileName || 'resume'));
  const extension = getUploadExtension(safeBase).slice(0, 10);
  const stem = sanitizeUploadSegment(safeBase.slice(0, safeBase.length - extension.length) || 'resume', 'resume');
  return `${stem}${extension}`;
}

function createUploadTempFileName(originalName) {
  const safeName = sanitizeUploadFileName(originalName);
  const extension = getUploadExtension(safeName);
  const stem = safeName.slice(0, safeName.length - extension.length) || 'resume';
  return `${stem}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${extension}`;
}

function normalizeExtractedText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/\t/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \u00a0]{2,}/g, ' ')
    .trim();
}

function truncateResumeText(text) {
  if (text.length <= env.maxResumeTextChars) {
    return {
      resumeText: text,
      truncated: false
    };
  }

  return {
    resumeText: text.slice(0, env.maxResumeTextChars),
    truncated: true
  };
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

async function extractPdfText(absolutePath) {
  let buffer = null;
  let parser = null;

  try {
    buffer = await fsPromises.readFile(absolutePath);
    parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    return normalizeExtractedText(result?.text);
  } finally {
    if (buffer) {
      buffer.fill(0);
      buffer = null;
    }

    if (parser && typeof parser.destroy === 'function') {
      await parser.destroy();
    }
  }
}

async function extractWordText(absolutePath, extension) {
  if (extension === '.docx') {
    const result = await mammoth.extractRawText({ path: absolutePath });
    return normalizeExtractedText(result?.value);
  }

  const document = await legacyWordExtractor.extract(absolutePath);
  return normalizeExtractedText(document?.getBody());
}

function assertSupportedExtension(extension) {
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    const error = new Error('Only PDF, DOC, and DOCX files are supported.');
    error.statusCode = 400;
    throw error;
  }
}

export const resumeUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      callback(null, TEMP_UPLOAD_DIR);
    },
    filename: (_req, file, callback) => {
      callback(null, createUploadTempFileName(file.originalname));
    }
  }),
  limits: {
    fileSize: MAX_UPLOAD_BYTES
  },
  fileFilter: (_req, file, callback) => {
    const extension = getUploadExtension(file.originalname);
    if (SUPPORTED_EXTENSIONS.has(extension)) {
      callback(null, true);
      return;
    }

    const error = new Error('Only PDF, DOC, and DOCX files are supported.');
    error.statusCode = 400;
    callback(error);
  }
});

export function getResumeUploadLimitBytes() {
  return MAX_UPLOAD_BYTES;
}

export async function parseUploadedResumeFile(file) {
  const extension = getUploadExtension(file?.originalname || file?.filename);
  assertSupportedExtension(extension);

  let extractedText = '';

  try {
    if (extension === '.pdf') {
      extractedText = await extractPdfText(file.path);
    } else {
      extractedText = await extractWordText(file.path, extension);
    }

    if (!extractedText) {
      const error = new Error('The uploaded file did not produce any readable text.');
      error.statusCode = 422;
      throw error;
    }

    const { resumeText, truncated } = truncateResumeText(extractedText);

    return {
      fileName: sanitizeUploadFileName(file.originalname || file.filename || 'resume'),
      fileType: extension.slice(1),
      sizeBytes: Number(file.size || 0),
      textLength: resumeText.length,
      truncated,
      preview: resumeText.slice(0, 280),
      resumeText
    };
  } finally {
    await removeTempFile(file?.path);
    extractedText = '';
    runGarbageCollectionIfAvailable();
  }
}
