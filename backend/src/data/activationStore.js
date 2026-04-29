import crypto from 'node:crypto';
import { getDatabase } from './database.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function nowIso() {
  return new Date().toISOString();
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '');
}

function mapActivationCode(row) {
  if (!row) return null;
  return {
    code: row.code,
    validDays: row.valid_days,
    isUsed: Boolean(row.is_used),
    usedBy: row.used_by || '',
    createdAt: row.created_at,
    usedAt: row.used_at || '',
    expiresAt: row.expires_at || ''
  };
}

function mapEntitlement(row) {
  if (!row) return null;
  return {
    ownerId: row.owner_id,
    sourceCode: row.source_code || '',
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isActive: new Date(row.expires_at).getTime() > Date.now()
  };
}

function createRandomCode(length = 8) {
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

function addDaysFromNow(days) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + Math.max(1, Number(days || 1)));
  return expiresAt.toISOString();
}

export function generateActivationCodes({ count = 50, validDays = 1 } = {}) {
  const db = getDatabase();
  const targetCount = Math.max(1, Math.min(500, Number(count || 50)));
  const safeValidDays = Math.max(1, Math.min(365, Number(validDays || 1)));
  const createdAt = nowIso();
  const codes = [];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO activation_codes (code, valid_days, is_used, created_at)
    VALUES (?, ?, 0, ?)
  `);

  while (codes.length < targetCount) {
    const code = createRandomCode(8);
    const result = insert.run(code, safeValidDays, createdAt);
    if (result.changes > 0) {
      codes.push(code);
    }
  }

  return codes;
}

export function getEntitlementByOwner(ownerId) {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT owner_id, source_code, expires_at, created_at, updated_at
    FROM user_entitlements
    WHERE owner_id = ?
  `).get(ownerId);

  return mapEntitlement(row);
}

export function redeemActivationCode(ownerId, rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) {
    const error = new Error('请输入激活码。');
    error.statusCode = 400;
    throw error;
  }

  const db = getDatabase();
  const existingCode = mapActivationCode(db.prepare(`
    SELECT code, valid_days, is_used, used_by, created_at, used_at, expires_at
    FROM activation_codes
    WHERE code = ?
  `).get(code));

  if (!existingCode) {
    const error = new Error('激活码不存在，请检查后重试。');
    error.statusCode = 404;
    throw error;
  }

  if (existingCode.isUsed) {
    const error = new Error('该激活码已被使用。');
    error.statusCode = 409;
    throw error;
  }

  const redeemedAt = nowIso();
  let entitlement = null;

  db.exec('BEGIN IMMEDIATE;');
  try {
    const current = getEntitlementByOwner(ownerId);
    const baseExpiry = current?.isActive && new Date(current.expiresAt).getTime() > Date.now()
      ? new Date(current.expiresAt)
      : new Date();
    baseExpiry.setDate(baseExpiry.getDate() + Math.max(1, existingCode.validDays));
    const nextExpiresAt = baseExpiry.toISOString();

    const updateResult = db.prepare(`
      UPDATE activation_codes
      SET is_used = 1,
          used_by = ?,
          used_at = ?,
          expires_at = ?
      WHERE code = ? AND is_used = 0
    `).run(ownerId, redeemedAt, nextExpiresAt, code);

    if (updateResult.changes <= 0) {
      const error = new Error('该激活码已被使用。');
      error.statusCode = 409;
      throw error;
    }

    db.prepare(`
      INSERT INTO user_entitlements (owner_id, source_code, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET
        source_code = excluded.source_code,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).run(ownerId, code, nextExpiresAt, redeemedAt, redeemedAt);

    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }

  entitlement = getEntitlementByOwner(ownerId);

  return {
    code,
    validDays: existingCode.validDays,
    entitlement
  };
}

export function getActivationAccess(ownerId) {
  const entitlement = getEntitlementByOwner(ownerId);
  if (!entitlement || !entitlement.isActive) {
    return {
      isActive: false,
      expiresAt: '',
      sourceCode: '',
      remainingMs: 0
    };
  }

  const remainingMs = Math.max(0, new Date(entitlement.expiresAt).getTime() - Date.now());
  return {
    isActive: true,
    expiresAt: entitlement.expiresAt,
    sourceCode: entitlement.sourceCode,
    remainingMs
  };
}
