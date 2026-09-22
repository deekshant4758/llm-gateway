// providers/openai-compatible.js — shared client for any provider that
// speaks the OpenAI chat-completions dialect. Groq and OpenRouter both
// do (same request shape, same response shape: choices[0].message.content
// + usage.prompt_tokens/completion_tokens), so one implementation covers
// both instead of duplicating the fetch/parsing logic per file.

const TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS || 15000);

async function callOpenAICompatible({ baseUrl, apiKey, providerName, model, messages, max_tokens, extraHeaders }) {
  if (!apiKey) {
    const err = new Error(`${providerName}: no API key configured`);
    err.code = "NO_UPSTREAM_KEY";
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        ...(extraHeaders || {}),
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: max_tokens || 512,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`${providerName} error ${res.status}: ${body.slice(0, 300)}`);
      err.code = "UPSTREAM_ERROR";
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content ?? "";

    return {
      provider: providerName,
      model: data.model || model,
      text,
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? 0,
      // OpenRouter reports real dollar cost directly in usage.cost for
      // some models; when present we trust it over our own pricing
      // table estimate (see pricing.js / server.js reconciliation).
      apiReportedCostUsd: typeof data.usage?.cost === "number" ? data.usage.cost : null,
      raw: data,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { callOpenAICompatible };
