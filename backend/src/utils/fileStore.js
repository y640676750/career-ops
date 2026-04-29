import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';

const FILE_STEM_SANITIZER = /[^a-zA-Z0-9-_]+/g;

export async function ensurePdfOutputDir() {
  await fs.mkdir(env.pdfOutputDir, { recursive: true });
}

export function sanitizeFileStem(value) {
  const stem = String(value || 'resume')
    .replace(FILE_STEM_SANITIZER, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

  return stem || 'resume';
}

export function createPdfTarget(fileName) {
  const stem = sanitizeFileStem(fileName);
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const safeFileName = `${stem}-${suffix}.pdf`;

  return {
    fileName: safeFileName,
    absolutePath: path.join(env.pdfOutputDir, safeFileName)
  };
}

export function resolvePdfFilePath(fileName) {
  const safeFileName = path.basename(String(fileName || ''));
  if (!safeFileName.endsWith('.pdf')) {
    return null;
  }

  const absolutePath = path.join(env.pdfOutputDir, safeFileName);
  return path.dirname(absolutePath) === env.pdfOutputDir ? absolutePath : null;
}

export async function pdfFileExists(fileName) {
  const absolutePath = resolvePdfFilePath(fileName);
  if (!absolutePath) {
    return false;
  }

  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

export function buildPdfDownloadUrl(baseUrl, fileName) {
  return `${baseUrl}/api/v1/pdf/files/${encodeURIComponent(fileName)}`;
}
