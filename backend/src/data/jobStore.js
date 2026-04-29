import crypto from 'node:crypto';
import { getDatabase } from './database.js';

function mapJobRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    type: row.type,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    request: row.request_json ? JSON.parse(row.request_json) : null,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    errorMessage: row.error_message || null,
    pdfFileName: row.pdf_file_name || null,
    ownerId: row.owner_id || null,
    meta: row.meta_json ? JSON.parse(row.meta_json) : null
  };
}

function countCompletedUnitsFromJob(job) {
  if (!job || job.status !== 'completed') {
    return 0;
  }

  if (job.type === 'resume_batch_async') {
    const items = Array.isArray(job.result?.items) ? job.result.items : [];
    return items.filter((item) => item.status === 'completed').length;
  }

  if (['resume_customization', 'resume_customization_async'].includes(job.type)) {
    return 1;
  }

  return 0;
}

function countPdfUnitsFromJob(job) {
  if (!job) {
    return 0;
  }

  let total = job.pdfFileName ? 1 : 0;
  if (job.type === 'resume_batch_async') {
    const items = Array.isArray(job.result?.items) ? job.result.items : [];
    total += items.filter((item) => item.pdf?.fileName).length;
  }

  return total;
}

export function createJob(type, requestPayload, options = {}) {
  const db = getDatabase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const status = typeof options.status === 'string' && options.status ? options.status : 'processing';
  const ownerId = typeof options.ownerId === 'string' && options.ownerId ? options.ownerId : null;
  const metaJson = options.meta ? JSON.stringify(options.meta) : null;

  db.prepare(`
    INSERT INTO jobs (id, type, status, created_at, updated_at, request_json, result_json, error_message, pdf_file_name, owner_id, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
  `).run(id, type, status, now, now, JSON.stringify(requestPayload || {}), ownerId, metaJson);

  return getJob(id);
}

export function completeJob(id, resultPayload, pdfFileName = null) {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE jobs
    SET status = 'completed',
        updated_at = ?,
        result_json = ?,
        error_message = NULL,
        pdf_file_name = ?
    WHERE id = ?
  `).run(now, JSON.stringify(resultPayload || {}), pdfFileName, id);

  return getJob(id);
}

export function failJob(id, errorMessage) {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE jobs
    SET status = 'failed',
        updated_at = ?,
        error_message = ?,
        result_json = NULL
    WHERE id = ?
  `).run(now, errorMessage, id);

  return getJob(id);
}

export function updateJobStatus(id, status, meta = null) {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE jobs
    SET status = ?,
        updated_at = ?,
        meta_json = COALESCE(?, meta_json)
    WHERE id = ?
  `).run(status, now, meta ? JSON.stringify(meta) : null, id);

  return getJob(id);
}

export function getJob(id) {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT id, type, status, created_at, updated_at, request_json, result_json, error_message, pdf_file_name, owner_id, meta_json
    FROM jobs
    WHERE id = ?
  `).get(id);

  return mapJobRow(row);
}

export function listJobs(limit = 20, type = null, ownerId = null) {
  const db = getDatabase();
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 20;

  const rows = type && ownerId
    ? db.prepare(`
        SELECT id, type, status, created_at, updated_at, request_json, result_json, error_message, pdf_file_name, owner_id, meta_json
        FROM jobs
        WHERE type = ? AND owner_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(type, ownerId, safeLimit)
    : type
      ? db.prepare(`
        SELECT id, type, status, created_at, updated_at, request_json, result_json, error_message, pdf_file_name, owner_id, meta_json
        FROM jobs
        WHERE type = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(type, safeLimit)
      : ownerId
        ? db.prepare(`
        SELECT id, type, status, created_at, updated_at, request_json, result_json, error_message, pdf_file_name, owner_id, meta_json
        FROM jobs
        WHERE owner_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(ownerId, safeLimit)
    : db.prepare(`
        SELECT id, type, status, created_at, updated_at, request_json, result_json, error_message, pdf_file_name, owner_id, meta_json
        FROM jobs
        ORDER BY created_at DESC
        LIMIT ?
      `).all(safeLimit);

  return rows.map(mapJobRow);
}

export function countCompletedResumeJobsByOwner(ownerId) {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT id, type, status, created_at, updated_at, request_json, result_json, error_message, pdf_file_name, owner_id, meta_json
    FROM jobs
    WHERE owner_id = ?
      AND status = 'completed'
      AND type IN ('resume_customization', 'resume_customization_async', 'resume_batch_async')
  `).all(ownerId);

  return rows.map(mapJobRow).reduce((total, job) => total + countCompletedUnitsFromJob(job), 0);
}

export function countPdfJobsByOwner(ownerId) {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT id, type, status, created_at, updated_at, request_json, result_json, error_message, pdf_file_name, owner_id, meta_json
    FROM jobs
    WHERE owner_id = ?
  `).all(ownerId);

  return rows.map(mapJobRow).reduce((total, job) => total + countPdfUnitsFromJob(job), 0);
}
