require("dotenv").config();
const express = require("express");
const { callGroq } = require("./providers/groq");
const { callGemini } = require("./providers/gemini");
const { callOpenRouter } = require("./providers/openrouter");
const { estimateTokensFromText, estimateCost, actualCost } = require("./pricing");
const { chooseTier } = require("./router");
const {
  findKeyByRaw,
  reserveBudget,
  reconcileBudget,
  logUsage,
  getUsageSummary,
  createKey,
} = require("./keys");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- provider chain ----
// Each entry: { name, call(args), envKeyName, cheapModel, capableModel }.
// The chain tries providers in order and moves to the next on ANY error
// (bad key, timeout, rate limit, 5xx, etc.) — see callWithFallbackChain
// below. Order is configurable via PROVIDER_ORDER (comma-separated
// names); a provider is skipped automatically if its API key env var
// isn't set, so you don't have to edit code just because you only have
// two of the three keys.
//
// Each provider exposes two models — a smaller/cheaper one and a
// larger/more capable one — and the router (src/router.js) picks which
// tier a given request uses. See "cheap-vs-capable routing" below.
const PROVIDER_REGISTRY = {
  groq: {
    call: callGroq,
    envKeyName: "GROQ_API_KEY",
    cheapModel: process.env.GROQ_CHEAP_MODEL || "qwen/qwen3.8-27b",
    capableModel: process.env.GROQ_CAPABLE_MODEL || "openai/gpt-oss-120b",
  },
  gemini: {
    call: callGemini,
    envKeyName: "GEMINI_API_KEY",
    cheapModel: process.env.GEMINI_CHEAP_MODEL || "gemini-2.5-flash-lite",
    capableModel: process.env.GEMINI_CAPABLE_MODEL || "gemini-2.5-flash",
  },
  openrouter: {
    call: callOpenRouter,
    envKeyName: "OPENROUTER_API_KEY",
    cheapModel: process.env.OPENROUTER_CHEAP_MODEL || "qwen/qwen3.8-27b:free",
    capableModel: process.env.OPENROUTER_CAPABLE_MODEL || "qwen/qwen3.8-27b:free",
  },
};

function getActiveProviderChain() {
  const order = (process.env.PROVIDER_ORDER || "groq,gemini,openrouter")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return order
    .map((name) => ({ name, ...PROVIDER_REGISTRY[name] }))
    .filter((p) => p.call && process.env[p.envKeyName]); // skip providers with no key configured
}

// ---- health ----
app.get("/healthz", (req, res) => {
  const active = getActiveProviderChain().map((p) => p.name);
  res.json({ ok: active.length > 0, active_providers: active });
});

// ---- auth middleware for the proxy endpoint ----
function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const rawKey = header.startsWith("Bearer ") ? header.slice(7) : null;
  const key = findKeyByRaw(rawKey);
  if (!key) {
    return res.status(401).json({ error: { message: "Invalid or missing virtual API key", type: "auth_error" } });
  }
  req.gatewayKey = key;
  next();
}

/**
 * Try each configured real provider in order; return the first success.
 * If ALL configured providers fail, return no result so the endpoint can
 * send a generic temporary-unavailable response. Provider errors remain
 * server-side only.
 *
 * `tier` ('cheap' | 'capable') selects which of each provider's two
 * models to use, unless `requestedModel` pins an exact provider+model
 * (e.g. "groq:openai/gpt-oss-20b"), which always wins.
 */
async function callWithFallbackChain({ messages, max_tokens, requestedModel, tier, chain }) {
  const attempts = [];

  for (const provider of chain) {
    let model;
    if (requestedModel && requestedModel.startsWith(provider.name + ":")) {
      model = requestedModel.slice(provider.name.length + 1);
    } else {
      model = tier === "cheap" ? provider.cheapModel : provider.capableModel;
    }
    try {
      const result = await provider.call({ model, messages, max_tokens });
      attempts.push({ provider: provider.name, model, tier, ok: true });
      return { result, attempts, usedFallback: false };
    } catch (err) {
      console.error(`[provider failed: ${provider.name}]`, err.message);
      attempts.push({ provider: provider.name, model, tier, ok: false, error: err.message });
      // fall through to the next provider in the chain
    }
  }

  return { result: null, attempts };
}

function modelForTier(provider, tier) {
  return tier === "cheap" ? provider.cheapModel : provider.capableModel;
}

// ---- core proxy endpoint ----
// Request body shape (a deliberately small OpenAI-ish subset):
// { model?: string, messages: [{role, content}], max_tokens?: number, tier?: "cheap"|"capable" }
//
// `model` is optional. If you want to force a specific provider's
// model, omit `model` and the router will pick a tier (or pass `tier`
// explicitly) — the chain then uses whichever provider succeeds first
// at that tier. To pin an exact model for one specific provider in the
// chain, prefix it, e.g. "gemini:gemini-2.5-flash" — note this only
// overrides the model used *if and when the chain reaches that
// provider*; other providers earlier or later in the chain still use
// normal tier-based routing as fallback candidates.
app.post("/chat", authenticate, async (req, res) => {
  const start = Date.now();
  const key = req.gatewayKey;
  const { messages, max_tokens, model: requestedModel, tier: explicitTier } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: "`messages` array is required", type: "invalid_request" } });
  }

  const requestedMaxTokens = Math.min(Number(max_tokens) || 512, 4096);
  const inputText = messages.map((m) => String(m.content || "")).join("\n");
  const estInputTokens = estimateTokensFromText(inputText);

  // Cheap-vs-capable routing: pick which tier of model each provider
  // should use for this request (skipped entirely if `model` pins an
  // exact provider+model). See src/router.js for the policy.
  const tier = chooseTier({ explicitTier, estInputTokens, requestedMaxTokens });

  const providerChain = getActiveProviderChain();
  if (providerChain.length === 0) {
    return res.status(503).json({
      error: {
        message: "No model providers are configured. Please try again later.",
        type: "provider_unavailable",
        retryable: true,
      },
    });
  }

  // Reserve against the most expensive model that can be reached. This
  // keeps fallback attempts inside the same per-key budget cap.
  const reservationModels = providerChain.map((provider) => {
    if (requestedModel && requestedModel.startsWith(provider.name + ":")) {
      return requestedModel.slice(provider.name.length + 1);
    }
    return modelForTier(provider, tier);
  });
  const estCost = Math.max(
    ...reservationModels.map((model) =>
      estimateCost({ model, estInputTokens, estOutputTokens: requestedMaxTokens })
    )
  );
  const estModelForPricing = reservationModels[0];

  // 1) Reserve budget BEFORE calling any provider. Nothing is spent on
  // the network until this succeeds.
  const reserved = reserveBudget(key.id, estCost);
  if (!reserved) {
    logUsage({
      keyId: key.id,
      model: estModelForPricing,
      provider: "none",
      status: "rejected_budget",
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      latencyMs: Date.now() - start,
    });
    return res.status(402).json({
      error: {
        message: `Budget exceeded for this key. spent+estimate would exceed budget_usd.`,
        type: "budget_exceeded",
      },
    });
  }

  // 2) Walk the configured provider chain at the chosen tier.
  let chainResult;
  try {
    chainResult = await callWithFallbackChain({
      messages,
      max_tokens: requestedMaxTokens,
      requestedModel,
      tier,
      chain: providerChain,
    });
  } catch (fatalErr) {
    reconcileBudget(key.id, -estCost);
    logUsage({
      keyId: key.id,
      model: estModelForPricing,
      provider: "none",
      status: "error",
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      latencyMs: Date.now() - start,
    });
    return res.status(502).json({
      error: { message: "Model providers are temporarily unavailable. Please try again later.", type: "upstream_error", retryable: true },
    });
  }

  const { result, attempts } = chainResult;
  if (!result) {
    reconcileBudget(key.id, -estCost);
    logUsage({
      keyId: key.id,
      model: estModelForPricing,
      provider: "none",
      status: "error",
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      latencyMs: Date.now() - start,
    });
    return res.status(503).json({
      error: {
        message: "Model providers are temporarily unavailable. Please try again later.",
        type: "upstream_unavailable",
        retryable: true,
      },
    });
  }

  const status = "ok";
  const publicAttempts = attempts.map(({ provider, tier, ok }) => ({ provider, tier, ok }));

  // 3) Reconcile: replace the estimate with the real cost.
  const realCost = actualCost({
    model: result.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    apiReportedCostUsd: result.apiReportedCostUsd,
  });
  reconcileBudget(key.id, realCost - estCost);

  logUsage({
    keyId: key.id,
    model: result.model,
    provider: result.provider,
    status,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: realCost,
    latencyMs: Date.now() - start,
  });

  res.json({
    id: "gwcmpl_" + Date.now(),
    model: result.model,
    provider: result.provider,
    status,
    tier,
    attempts: publicAttempts, // provider statuses only; upstream errors stay server-side
    choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
    usage: { input_tokens: result.tokensIn, output_tokens: result.tokensOut, cost_usd: Number(realCost.toFixed(6)) },
  });
});

// ---- admin: usage lookup ----
// GET /usage?key=<raw virtual key>  -> spend summary for that key.
app.get("/usage", (req, res) => {
  const rawKey = req.query.key;
  const key = findKeyByRaw(rawKey);
  if (!key) return res.status(404).json({ error: { message: "Unknown key" } });
  res.json(getUsageSummary(key.id));
});

// ---- create a new virtual key ----
app.post("/admin/keys", (req, res) => {
  const { name, budget_usd } = req.body || {};
  if (!name || typeof budget_usd !== "number") {
    return res.status(400).json({ error: { message: "`name` (string) and `budget_usd` (number) required" } });
  }
  const created = createKey({ name, budgetUsd: budget_usd });
  res.status(201).json(created);
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  const active = getActiveProviderChain().map((p) => p.name);
  app.listen(PORT, () =>
    console.log(`llm-gateway listening on :${PORT} — provider chain: [${active.join(", ") || "none configured"}]`)
  );
}

module.exports = app;

