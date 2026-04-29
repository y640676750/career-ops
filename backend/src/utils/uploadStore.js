import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';

const SAFE_FILE_NAME = /[^a-zA-Z0-9._-]+/g;

function sanitizeUploadSegment(value, fallback) {
  const segment = String(value || fallback)
    .replace(SAFE_FILE_NAME, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return segment || fallback;
}

export function ensureUploadTempDirSync() {
  fs.mkdirSync(env.uploadTempDir, { recursive: true });
}

export async function ensureUploadTempDir() {
  await fsPromises.mkdir(env.uploadTempDir, { recursive: true });
}

export function getUploadExtension(fileName) {
  return path.extname(String(fileName || '')).toLowerCase();
}

export function sanitizeUploadFileName(fileName) {
  const safeBase = path.basename(String(fileName || 'resume'));
  const extension = getUploadExtension(safeBase).slice(0, 10);
  const stem = sanitizeUploadSegment(safeBase.slice(0, safeBase.length - extension.length) || 'resume', 'resume');
  return `${stem}${extension}`;
}

export function createUploadTempFileName(originalName) {
  const safeName = sanitizeUploadFileName(originalName);
  const extension = getUploadExtension(safeName);
  const stem = safeName.slice(0, safeName.length - extension.length) || 'resume';
  return `${stem}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${extension}`;
}

export async function removeFileIfExists(absolutePath) {
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
