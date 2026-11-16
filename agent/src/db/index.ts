/**
 * SQLite persistence (bun:sqlite). The worker is the single writer. Everything the agent
 * needs to resume after a restart lives here: indexer cursor, projections, intents,
 * spend accounting, tasks, settings.
 */
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { defaultSettings, parseSettings, serializeSettings, type Settings } from '../config'
import { parseJson, toJson } from '../util'

export type Db = Database

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cursor (key TEXT PRIMARY KEY, block INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, block INTEGER NOT NULL, log_index INTEGER NOT NULL,
  tx_hash TEXT NOT NULL, address TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL, ts INTEGER NOT NULL,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS events_block ON events (block);
CREATE TABLE IF NOT EXISTS collections (
  address TEXT PRIMARY KEY, creator TEXT NOT NULL, name TEXT NOT NULL, symbol TEXT NOT NULL,
  mint_price TEXT NOT NULL, max_supply INTEGER NOT NULL, max_per_wallet INTEGER NOT NULL,
  mint_start INTEGER NOT NULL, mint_end INTEGER NOT NULL, royalty_bps INTEGER NOT NULL,
  seed_commitment TEXT NOT NULL, created_block INTEGER NOT NULL, created_ts INTEGER NOT NULL,
  total_minted INTEGER NOT NULL DEFAULT 0, revealed INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS tokens (
  collection TEXT NOT NULL, token_id TEXT NOT NULL, owner TEXT NOT NULL, minter TEXT,
  traits INTEGER, minted_ts INTEGER, updated_ts INTEGER NOT NULL,
  PRIMARY KEY (collection, token_id)
);
CREATE INDEX IF NOT EXISTS tokens_owner ON tokens (owner);
CREATE TABLE IF NOT EXISTS listings (
  collection TEXT NOT NULL, token_id TEXT NOT NULL, seller TEXT NOT NULL, price TEXT NOT NULL,
  expiry INTEGER NOT NULL, status TEXT NOT NULL, listed_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL,
  PRIMARY KEY (collection, token_id)
);
CREATE INDEX IF NOT EXISTS listings_status ON listings (status);
CREATE TABLE IF NOT EXISTS offers (
  offer_id INTEGER PRIMARY KEY, collection TEXT NOT NULL, token_id TEXT NOT NULL, collection_wide INTEGER NOT NULL,
  bidder TEXT NOT NULL, price TEXT NOT NULL, expiry INTEGER NOT NULL, status TEXT NOT NULL,
  created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS offers_status ON offers (status, collection);
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, token_id TEXT NOT NULL, seller TEXT NOT NULL,
  buyer TEXT NOT NULL, price TEXT NOT NULL, fee TEXT NOT NULL, royalty TEXT NOT NULL, kind INTEGER NOT NULL,
  ts INTEGER NOT NULL, block INTEGER NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS sales_coll_ts ON sales (collection, ts);
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY, label TEXT NOT NULL, role TEXT NOT NULL, circle_wallet_id TEXT
);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, token_id TEXT NOT NULL,
  source TEXT NOT NULL, acquired_price TEXT NOT NULL, acquired_cost TEXT NOT NULL, acquired_ts INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', sold_price TEXT, sold_net TEXT, sold_ts INTEGER, realized TEXT,
  paper INTEGER NOT NULL DEFAULT 0, intent_key TEXT
);
CREATE INDEX IF NOT EXISTS positions_status ON positions (status, collection);
CREATE TABLE IF NOT EXISTS intents (
  key TEXT PRIMARY KEY, kind TEXT NOT NULL, strategy TEXT NOT NULL, params TEXT NOT NULL,
  status TEXT NOT NULL, mode TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', analysis TEXT,
  collection TEXT, token_id TEXT, spend TEXT NOT NULL DEFAULT '0',
  est_cost TEXT NOT NULL DEFAULT '0', circle_tx_id TEXT, tx_hash TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL, expires_ts INTEGER
);
CREATE INDEX IF NOT EXISTS intents_status ON intents (status);
CREATE TABLE IF NOT EXISTS spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, amount TEXT NOT NULL,
  collection TEXT, intent_key TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, collection TEXT, token_id TEXT,
  amount TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', intent_key TEXT, paper INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL, strategy TEXT NOT NULL,
  message TEXT NOT NULL, data TEXT
);
CREATE TABLE IF NOT EXISTS reprices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, token_id TEXT NOT NULL, ts INTEGER NOT NULL,
  from_price TEXT NOT NULL, to_price TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reprices_tok ON reprices (collection, token_id, ts);
CREATE TABLE IF NOT EXISTS tasks (
  name TEXT PRIMARY KEY, next_run INTEGER NOT NULL, interval_ms INTEGER NOT NULL, last_run INTEGER,
  last_status TEXT, last_error TEXT, runs INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS observations (
  collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (collection, key)
);
CREATE TABLE IF NOT EXISTS paper_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, collection TEXT NOT NULL, token_id TEXT NOT NULL,
  collection_wide INTEGER NOT NULL DEFAULT 0, price TEXT NOT NULL, expiry INTEGER NOT NULL, status TEXT NOT NULL,
  created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL, filled_sale_id INTEGER
);
CREATE INDEX IF NOT EXISTS paper_orders_status ON paper_orders (status, kind);
CREATE TABLE IF NOT EXISTS score_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, score REAL NOT NULL, realized TEXT NOT NULL, ts INTEGER NOT NULL
);
`

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  return db
}

export function kvGet<T>(db: Db, key: string, fallback: T): T {
  const row = db.query('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | null
  return row ? parseJson<T>(row.value, fallback) : fallback
}

export function kvSet(db: Db, key: string, value: unknown): void {
  db.query(
    'INSERT INTO kv (key, value, updated_ts) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_ts = excluded.updated_ts',
  ).run(key, toJson(value), Date.now())
}

export function loadSettings(db: Db): Settings {
  const raw = kvGet<unknown>(db, 'settings', null)
  if (raw === null) {
    const d = defaultSettings()
    kvSet(db, 'settings', serializeSettings(d))
    return d
  }
  try {
    return parseSettings(raw)
  } catch {
    // Corrupt or outdated settings must never leave the agent unprotected: fall back to defaults, paused.
    const d = { ...defaultSettings(), paused: true }
    kvSet(db, 'settings', serializeSettings(d))
    return d
  }
}

export function saveSettings(db: Db, settings: Settings): void {
  kvSet(db, 'settings', serializeSettings(settings))
}

export type Activity = { strategy: string; level?: 'info' | 'warn' | 'error'; message: string; data?: unknown }

export function logActivity(db: Db, a: Activity): void {
  db.query('INSERT INTO activity (ts, level, strategy, message, data) VALUES (?, ?, ?, ?, ?)').run(
    Date.now(),
    a.level ?? 'info',
    a.strategy,
    a.message,
    a.data === undefined ? null : toJson(a.data),
  )
}
