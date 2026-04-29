import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { getDatabase } from './database.js';

function mapSessionRow(row) {
  if (!row) {
    return null;
  }

  return {
    token: row.token,
    openId: row.open_id,
    unionId: row.union_id || null,
    sessionKey: row.session_key || null,
    user: row.user_json ? JSON.parse(row.user_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at
  };
}

function computeExpiryDate() {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + env.sessionTtlHours);
  return expiresAt;
}

export function createSession({ openId, unionId = '', sessionKey = '', user = {} }) {
  const db = getDatabase();
  const token = crypto.randomBytes(24).toString('hex');
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAtIso = computeExpiryDate().toISOString();
  const userPayload = {
    ...user,
    openId,
    unionId: unionId || ''
  };

  db.prepare(`
    INSERT INTO sessions (token, open_id, union_id, session_key, user_json, created_at, updated_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    token,
    openId,
    unionId || null,
    sessionKey || null,
    JSON.stringify(userPayload),
    nowIso,
    nowIso,
    expiresAtIso,
    nowIso
  );

  return getSession(token);
}

export function getSession(token) {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT token, open_id, union_id, session_key, user_json, created_at, updated_at, expires_at, last_seen_at
    FROM sessions
    WHERE token = ?
  `).get(token);

  const session = mapSessionRow(row);
  if (!session) {
    return null;
  }

  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    deleteSession(token);
    return null;
  }

  return session;
}

export function touchSession(token) {
  const db = getDatabase();
  const nowIso = new Date().toISOString();
  const expiresAtIso = computeExpiryDate().toISOString();

  db.prepare(`
    UPDATE sessions
    SET updated_at = ?,
        last_seen_at = ?,
        expires_at = ?
    WHERE token = ?
  `).run(nowIso, nowIso, expiresAtIso, token);

  return getSession(token);
}

export function deleteSession(token) {
  const db = getDatabase();
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

export function deleteExpiredSessions() {
  const db = getDatabase();
  db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(new Date().toISOString());
}
