// providers/openrouter.js — OpenRouter's OpenAI-compatible endpoint.
// https://openrouter.ai/api/v1/chat/completions
// OpenRouter fronts many models (including several free ones, tagged
// `:free` in the model id) and is useful as a fallback specifically
// because it's a different upstream from Groq and Gemini — if one
// vendor has an outage, the other two are unrelated infrastructure.

const { callOpenAICompatible } = require("./openai-compatible");

const BASE_URL = "https://openrouter.ai/api/v1";

async function callOpenRouter({ model, messages, max_tokens }) {
  return callOpenAICompatible({
    baseUrl: BASE_URL,
    apiKey: process.env.OPENROUTER_API_KEY,
    providerName: "openrouter",
    model,
    messages,
    max_tokens,
    // Optional but recommended by OpenRouter for attribution/rankings;
    // harmless to omit, doesn't affect function.
    extraHeaders: {
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "http://localhost",
      "X-Title": process.env.OPENROUTER_APP_NAME || "llm-gateway",
    },
  });
}

module.exports = { callOpenRouter };
