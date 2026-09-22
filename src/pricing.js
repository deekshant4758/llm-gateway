// pricing.js — $ per token, by model.
//
// IMPORTANT: verify these against each provider's current pricing page
// before relying on them for real money. They are a reasonable snapshot,
// not a guarantee. Kept in one small file on purpose so updating prices
// never requires touching gateway logic.
//
// These are internal shadow prices, not provider invoices. Free-tier
// access still consumes model capacity, so the gateway charges each key
// a predictable internal amount based on actual token usage. Update the
// values if the project's internal accounting policy changes.
//
// Prices are USD per single token (provider list prices are usually
// quoted per million tokens — we divide here so the rest of the code
// just does tokens * price).

const PRICING = {
  // Groq internal shadow prices.
  "openai/gpt-oss-20b": { inputPerToken: 0.20 / 1_000_000, outputPerToken: 0.60 / 1_000_000 },
  "openai/gpt-oss-120b": { inputPerToken: 0.50 / 1_000_000, outputPerToken: 1.50 / 1_000_000 },
  "qwen/qwen3.8-27b": { inputPerToken: 0.20 / 1_000_000, outputPerToken: 0.60 / 1_000_000 },

  // Gemini internal shadow prices.
  "gemini-2.5-flash-lite": { inputPerToken: 0.10 / 1_000_000, outputPerToken: 0.40 / 1_000_000 },
  "gemini-2.5-flash": { inputPerToken: 0.30 / 1_000_000, outputPerToken: 2.50 / 1_000_000 },

  // OpenRouter free-tagged model internal shadow price.
  "qwen/qwen3.8-27b:free": { inputPerToken: 0.20 / 1_000_000, outputPerToken: 0.60 / 1_000_000 },
};

// Unknown models use a conservative internal rate rather than becoming free.
const DEFAULT_PRICING = { inputPerToken: 0.50 / 1_000_000, outputPerToken: 1.50 / 1_000_000 };

function getPricing(model) {
  return PRICING[model] || DEFAULT_PRICING;
}

// Rough pre-call estimate of input tokens from raw text, used ONLY to
// reserve budget before we know the real number. ~4 chars/token is the
// standard rule-of-thumb approximation for English text.
function estimateTokensFromText(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateCost({ model, estInputTokens, estOutputTokens }) {
  const p = getPricing(model);
  return estInputTokens * p.inputPerToken + estOutputTokens * p.outputPerToken;
}

function actualCost({ model, tokensIn, tokensOut, apiReportedCostUsd }) {
  const p = getPricing(model);
  const shadowCost = tokensIn * p.inputPerToken + tokensOut * p.outputPerToken;
  const providerCost = typeof apiReportedCostUsd === "number" ? apiReportedCostUsd : 0;
  return Math.max(shadowCost, providerCost);
}

module.exports = { getPricing, estimateTokensFromText, estimateCost, actualCost };
