// providers/groq.js — Groq's OpenAI-compatible endpoint.
// https://api.groq.com/openai/v1/chat/completions
// Groq's LPU inference is fast and (at the time of writing) has a
// generous free tier, which is why it's the default first choice in
// the provider chain — see server.js / DECISIONS.md.

const { callOpenAICompatible } = require("./openai-compatible");

const BASE_URL = "https://api.groq.com/openai/v1";

async function callGroq({ model, messages, max_tokens }) {
  return callOpenAICompatible({
    baseUrl: BASE_URL,
    apiKey: process.env.GROQ_API_KEY,
    providerName: "groq",
    model,
    messages,
    max_tokens,
  });
}

module.exports = { callGroq };
