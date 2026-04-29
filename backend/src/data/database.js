import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { env } from '../config/env.js';

let database;

function getTableColumns(db, tableName) {
  return db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((row) => row.name);
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = getTableColumns(db, tableName);
  if (!columns.includes(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
  }
}

function migrateJobsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_json TEXT,
      error_message TEXT,
      pdf_file_name TEXT,
      owner_id TEXT,
      meta_json TEXT
    );
  `);

  ensureColumn(db, 'jobs', 'owner_id', 'TEXT');
  ensureColumn(db, 'jobs', 'meta_json', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_jobs_type_created_at ON jobs(type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_owner_id_created_at ON jobs(owner_id, created_at DESC);
  `);
}

function migrateSessionsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      open_id TEXT NOT NULL,
      union_id TEXT,
      session_key TEXT,
      user_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_open_id ON sessions(open_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  `);
}

function migrateOrdersTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      channel TEXT NOT NULL,
      credits INTEGER NOT NULL,
      storage_months INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      paid_at TEXT
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_orders_owner_id_created_at ON orders(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_owner_id_status ON orders(owner_id, status);
  `);
}

function migrateActivationTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS activation_codes (
      code TEXT PRIMARY KEY,
      valid_days INTEGER NOT NULL,
      is_used INTEGER NOT NULL DEFAULT 0,
      used_by TEXT,
      created_at TEXT NOT NULL,
      used_at TEXT,
      expires_at TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_entitlements (
      owner_id TEXT PRIMARY KEY,
      source_code TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_activation_codes_used ON activation_codes(is_used);
    CREATE INDEX IF NOT EXISTS idx_user_entitlements_expires_at ON user_entitlements(expires_at);
  `);
}

export function getDatabase() {
  if (!database) {
    fs.mkdirSync(path.dirname(env.appDbPath), { recursive: true });
    database = new DatabaseSync(env.appDbPath);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
    migrateJobsTable(database);
    migrateSessionsTable(database);
    migrateOrdersTable(database);
    migrateActivationTables(database);
  }

  return database;
}
