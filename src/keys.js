// keys.js — virtual key auth + budget enforcement.
//
// Budget model: RESERVE then RECONCILE.
//   1. Before calling any provider, estimate a worst-case cost (input
//      tokens from text length + requested max_tokens as worst-case
//      output) and atomically add that to spent_usd IF it still fits
//      under budget_usd. If it doesn't fit, reject with 402 — no call
//      is ever made.
//   2. After a provider responds, we know the REAL token counts. We adjust
//      spent_usd by (actual - estimated), which is usually a refund since
//      actual output is normally well under max_tokens. If all providers
//      fail, the reservation is refunded completely.
// This means a key can never go over budget from a successful, priced
// call, and small transient overshoots from in-flight estimates get
// corrected within the same request — there's no polling/cron needed.

const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");

function hashKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

function createKey({ name, budgetUsd }) {
  const id = uuidv4();
  const raw = "gw_" + crypto.randomBytes(24).toString("hex");
  db.prepare(
    `INSERT INTO keys (id, key_hash, name, budget_usd, spent_usd, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`
  ).run(id, hashKey(raw), name, budgetUsd, new Date().toISOString());
  return { id, rawKey: raw, name, budgetUsd };
}

function findKeyByRaw(rawKey) {
  if (!rawKey) return null;
  const row = db
    .prepare(`SELECT * FROM keys WHERE key_hash = ? AND revoked = 0`)
    .get(hashKey(rawKey));
  return row || null;
}

/**
 * Atomically reserve `estCost` against a key's budget.
 * Returns true if reserved (spent_usd was incremented), false if it
 * would have exceeded budget_usd (nothing was changed).
 *
 * Atomicity note: better-sqlite3 statements run synchronously and the
 * Node process only has one thread executing JS, so no other request
 * handler can run between the SELECT-ish check and the UPDATE here —
 * they're combined into a single conditional UPDATE anyway, which is
 * the standard "compare-and-swap in SQL" pattern and would still be
 * correct even under real concurrency (e.g. multiple DB connections).
 */
function reserveBudget(keyId, estCost) {
  const result = db
    .prepare(
      `UPDATE keys
       SET spent_usd = spent_usd + ?
       WHERE id = ? AND spent_usd + ? <= budget_usd`
    )
    .run(estCost, keyId, estCost);
  return result.changes === 1;
}

/** Adjust spent_usd by a signed delta (actualCost - estimatedCost). */
function reconcileBudget(keyId, delta) {
  db.prepare(`UPDATE keys SET spent_usd = spent_usd + ? WHERE id = ?`).run(delta, keyId);
}

function getKeyById(keyId) {
  return db.prepare(`SELECT * FROM keys WHERE id = ?`).get(keyId);
}

function logUsage({ keyId, model, provider, status, tokensIn, tokensOut, costUsd, latencyMs }) {
  db.prepare(
    `INSERT INTO usage_log (key_id, model, provider, status, tokens_in, tokens_out, cost_usd, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(keyId, model, provider, status, tokensIn, tokensOut, costUsd, latencyMs, new Date().toISOString());
}

function getUsageSummary(keyId) {
  const key = getKeyById(keyId);
  if (!key) return null;
  const rows = db
    .prepare(`SELECT * FROM usage_log WHERE key_id = ? ORDER BY id DESC LIMIT 50`)
    .all(keyId);
  const totals = db
    .prepare(
      `SELECT COUNT(*) as requests, COALESCE(SUM(tokens_in),0) as tokens_in,
              COALESCE(SUM(tokens_out),0) as tokens_out
      FROM usage_log WHERE key_id = ? AND status = 'ok'`
    )
    .get(keyId);
  return {
    key: { id: key.id, name: key.name, budget_usd: key.budget_usd, spent_usd: key.spent_usd },
    totals,
    recent_requests: rows,
  };
}

module.exports = {
  hashKey,
  createKey,
  findKeyByRaw,
  reserveBudget,
  reconcileBudget,
  getKeyById,
  logUsage,
  getUsageSummary,
};
