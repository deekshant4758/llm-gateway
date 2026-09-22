// providers/gemini.js — Google's native Generative Language API.
// POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
// Auth via x-goog-api-key header (not a Bearer token). Request/response
// shape is Google's own (contents/parts, candidates/usageMetadata), not
// OpenAI-style, so this gets its own adapter rather than sharing the
// openai-compatible.js helper.

const TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS || 15000);
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

// Our gateway's request shape is OpenAI-style messages: [{role, content}].
// Gemini wants `contents: [{role, parts:[{text}]}]` with role "user" |
// "model" (no "assistant", no "system" as a content role — system goes
// in a separate top-level field). Translate here.
function toGeminiContents(messages) {
  const systemParts = [];
  const contents = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push({ text: String(m.content || "") });
      continue;
    }
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "") }],
    });
  }
  return { contents, systemInstruction: systemParts.length ? { parts: systemParts } : undefined };
}

async function callGemini({ model, messages, max_tokens }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error("gemini: no API key configured");
    err.code = "NO_UPSTREAM_KEY";
    throw err;
  }

  const { contents, systemInstruction } = toGeminiContents(messages);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE_URL}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents,
        ...(systemInstruction ? { systemInstruction } : {}),
        generationConfig: { maxOutputTokens: max_tokens || 512 },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`gemini error ${res.status}: ${body.slice(0, 300)}`);
      err.code = "UPSTREAM_ERROR";
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");

    return {
      provider: "gemini",
      model,
      text,
      tokensIn: data.usageMetadata?.promptTokenCount ?? 0,
      tokensOut: data.usageMetadata?.candidatesTokenCount ?? 0,
      apiReportedCostUsd: null,
      raw: data,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { callGemini };
