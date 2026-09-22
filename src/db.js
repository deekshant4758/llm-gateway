// db.js — single SQLite connection, synchronous.
//
// Uses Node's built-in `node:sqlite` (stable enough for this purpose,
// available without any native compilation step) instead of a
// third-party binding like better-sqlite3. I switched to this after
// hitting a native-build failure (node-gyp couldn't fetch Node headers)
// in a network-restricted environment — since correctness here doesn't
// depend on which synchronous SQLite binding is used, removing the
// native-compile dependency entirely is strictly safer for deploys
// (Docker images, serverless, CI) that may not have build tools or full
// internet access. See AI-LOG.md for how this was caught.
//
// Why synchronous SQLite instead of an async driver (pg, mysql2, etc.)?
// It executes queries synchronously and blocks Node's single thread
// while doing so. That sounds bad for throughput, but it buys us
// something important for free: read-modify-write budget checks are
// naturally atomic. Two "requests" arriving "at the same time" in Node
// are still processed one at a time on the event loop, and since the DB
// call doesn't yield to the event loop mid-query, there's no window for
// a second request to interleave between "check budget" and "spend
// budget". See DECISIONS.md for the fuller argument and its limits
// (this does NOT hold if you scale to multiple processes/instances
// against the same file — see "Where it breaks").

const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "gateway.db");
const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS keys (
  id            TEXT PRIMARY KEY,        -- internal id
  key_hash      TEXT UNIQUE NOT NULL,    -- sha256 of the raw virtual key
  name          TEXT NOT NULL,
  budget_usd    REAL NOT NULL,           -- hard cap, in USD
  spent_usd     REAL NOT NULL DEFAULT 0, -- running total (includes reserved-but-not-yet-reconciled amounts)
  created_at    TEXT NOT NULL,
  revoked       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS usage_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id        TEXT NOT NULL,
  model         TEXT NOT NULL,
  provider      TEXT NOT NULL,           -- 'groq' | 'gemini' | 'openrouter' | 'none'
  status        TEXT NOT NULL,           -- 'ok' | 'error' | 'rejected_budget'
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (key_id) REFERENCES keys(id)
);

CREATE INDEX IF NOT EXISTS idx_usage_key ON usage_log(key_id);
`);

module.exports = db;
