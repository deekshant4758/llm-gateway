# AI-LOG

## AI Tools Used

Claude and Qwen was used for Express and SQLite scaffolding, provider adapter drafts, model-catalog research, budget SQL, README updates, and manual test commands. Every change was reviewed in the repository and checked with local runtime tests before being kept.

## Where the AI Was Wrong and How It Was Caught

**Stale provider model IDs.** The initial defaults used retired or unavailable models: Groq `llama-3.1-8b-instant`, Gemini `gemini-2.0-flash-lite`, and an OpenRouter Llama `:free` slug. The API fell through to the mock response.

I caught this by running a real request and reading the provider status codes: all three returned `404 model_not_found` responses. I queried each provider's current model catalog with the configured API key, replaced the defaults, and verified Groq through the gateway.

**Leaking upstream errors.** The first public response copied raw provider errors into `attempts`, exposing model names and upstream response bodies to clients. I caught this by inspecting the JSON returned from `/chat`, then changed the public projection to provider/tier/status only while retaining detailed errors in server logs.

**Budget reservation priced at zero.** The original code reserved against `mock-fallback-v1`, whose price was zero, so normal requests could bypass meaningful per-key budget enforcement even when a real provider served them. I found this while reviewing the reservation path after removing the mock. The fix reserves against the maximum shadow cost of all reachable models and reconciles against actual token usage.

**Free-tier usage was treated as free accounting.** Provider APIs can report zero cost for free-tier access, but that made internal usage totals useless. The current pricing table applies project-defined shadow rates by model and uses provider-reported cost only when it is higher.

## Decisions Overridden

I rejected a two-step JavaScript budget check because it creates a race between checking and updating spend. The implementation uses a conditional SQLite `UPDATE` instead. I also rejected a local canned fallback: returning a clean retryable `503` is more honest and lets clients distinguish provider outage from a successful model response.

## Verification

- `node --check` passes for the edited JavaScript files.
- Live `/chat` requests use the current provider model IDs.
- Client responses contain no raw upstream error bodies.
- Per-key budget reservation rejects before provider calls when the shadow estimate would exceed the key budget.
- Total provider failure returns a generic retryable `503` and refunds the reservation.
