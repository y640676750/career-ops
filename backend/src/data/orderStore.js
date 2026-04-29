import crypto from 'node:crypto';
import { getDatabase } from './database.js';

function mapOrderRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    ownerId: row.owner_id,
    productId: row.product_id,
    productName: row.product_name,
    amountCents: row.amount_cents,
    currency: row.currency,
    status: row.status,
    channel: row.channel,
    credits: row.credits,
    storageMonths: row.storage_months,
    snapshot: row.snapshot_json ? JSON.parse(row.snapshot_json) : null,
    note: row.note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at || null
  };
}

export function createDraftOrder(ownerId, product, options = {}) {
  const db = getDatabase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const snapshot = {
    productId: product.id,
    name: product.name,
    subtitle: product.subtitle,
    priceLabel: product.priceLabel,
    credits: product.credits,
    storageMonths: product.storageMonths
  };

  db.prepare(`
    INSERT INTO orders (
      id, owner_id, product_id, product_name, amount_cents, currency, status, channel,
      credits, storage_months, snapshot_json, note, created_at, updated_at, paid_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    id,
    ownerId,
    product.id,
    product.name,
    product.amountCents,
    product.currency,
    options.channel || 'wechatpay_jsapi',
    product.credits,
    product.storageMonths,
    JSON.stringify(snapshot),
    options.note || '',
    now,
    now
  );

  return getOrderById(id, ownerId);
}

export function getOrderById(id, ownerId) {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT id, owner_id, product_id, product_name, amount_cents, currency, status, channel,
           credits, storage_months, snapshot_json, note, created_at, updated_at, paid_at
    FROM orders
    WHERE id = ? AND owner_id = ?
  `).get(id, ownerId);

  return mapOrderRow(row);
}

export function listOrdersByOwner(ownerId, limit = 20) {
  const db = getDatabase();
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 20;
  const rows = db.prepare(`
    SELECT id, owner_id, product_id, product_name, amount_cents, currency, status, channel,
           credits, storage_months, snapshot_json, note, created_at, updated_at, paid_at
    FROM orders
    WHERE owner_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(ownerId, safeLimit);

  return rows.map(mapOrderRow);
}

export function markOrderPaid(id, ownerId, note = '') {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE orders
    SET status = 'paid',
        updated_at = ?,
        paid_at = ?,
        note = CASE WHEN ? != '' THEN ? ELSE note END
    WHERE id = ? AND owner_id = ? AND status != 'paid'
  `).run(now, now, note, note, id, ownerId);

  return getOrderById(id, ownerId);
}

export function countPaidCredits(ownerId) {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT COALESCE(SUM(credits), 0) AS total_credits
    FROM orders
    WHERE owner_id = ? AND status = 'paid'
  `).get(ownerId);

  return row ? row.total_credits : 0;
}

export function countPaidStorageMonths(ownerId) {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT COALESCE(SUM(storage_months), 0) AS total_months
    FROM orders
    WHERE owner_id = ? AND status = 'paid'
  `).get(ownerId);

  return row ? row.total_months : 0;
}
