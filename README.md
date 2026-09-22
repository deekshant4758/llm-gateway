# llm-gateway

A minimal LLM gateway: virtual API keys, per-key budget enforcement,
usage/spend logging, and provider fallback — sitting in front of Groq,
Gemini, and OpenRouter, cascading from one to the next on failure.

## Run locally

```bash
npm install
cp .env.example .env        # then fill in at least one of GROQ_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY
npm run dev
```

The development server listens on `http://localhost:3000`. For a deployed
gateway, replace the base URL in the examples below with your public URL.

You don't need all three provider keys. The gateway builds its fallback
chain from whichever ones are set (`PROVIDER_ORDER` controls the try
order, default `groq,gemini,openrouter`). If every configured provider
fails, the API returns a generic retryable `503` without exposing
upstream error details. Check `GET /healthz` to see which providers are
currently active.

## Access the API

Set the gateway URL first:

```bash
BASE_URL="http://localhost:3000"
```

Check that the gateway is running:

```bash
curl "$BASE_URL/healthz"
```

Create a virtual key. No admin token is required:

```bash
curl -X POST "$BASE_URL/admin/keys" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-app","budget_usd":1.00}'
```

Copy the `rawKey` from that response. It is shown only once, so set it as
`GATEWAY_KEY` before calling the chat endpoint:

```bash
GATEWAY_KEY="gw_xxx"
```

Send a chat request:

```bash
curl -X POST "$BASE_URL/chat" \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Say hi in 5 words."}],
    "max_tokens": 50
  }'
```

Check spend:

```bash
curl "$BASE_URL/usage?key=$GATEWAY_KEY"
```

## Providers & fallback chain

This build targets free-tier usage, so it fronts three providers instead
of one paid one:

| Order | Provider   | Endpoint style        | Default model                            |
|-------|-----------|------------------------|-------------------------------------------|
| 1     | Groq       | OpenAI-compatible      | `openai/gpt-oss-120b`                     |
| 2     | Gemini     | Google native          | `gemini-2.5-flash`                        |
| 3     | OpenRouter | OpenAI-compatible      | `qwen/qwen3.8-27b:free`                   |

A request tries providers in `PROVIDER_ORDER` (skipping any without an
API key set), moving to the next on **any** failure — bad key, rate
limit, timeout, 5xx, whatever. If all configured providers fail (or
none are configured), it returns a clean retryable error instead of
leaking provider details. Successful responses report only public
provider status in `attempts`:

```json
{
  "provider": "gemini",
  "status": "ok",
  "attempts": [
    { "provider": "groq", "tier": "cheap", "ok": true }
  ]
}
```

To pin a specific provider+model instead of letting the chain pick,
prefix the `model` field: `"model": "groq:openai/gpt-oss-20b"`.

## Cheap-vs-capable routing (stretch goal)

Each provider exposes two models — a small/fast one and a larger/more
capable one:

| Provider   | Cheap tier                            | Capable tier                             |
|------------|----------------------------------------|-------------------------------------------|
| Groq       | `qwen/qwen3.8-27b`                     | `openai/gpt-oss-120b`                     |
| Gemini     | `gemini-2.5-flash-lite`                | `gemini-2.5-flash`                        |
| OpenRouter | `qwen/qwen3.8-27b:free`                | `qwen/qwen3.8-27b:free`                   |

By default the gateway picks a tier per request based on its shape: a
short prompt (≤~200 estimated input tokens) paired with a small
requested `max_tokens` (≤150) is routed to the cheap tier; anything
bigger goes to the capable tier. Pass `"tier": "cheap"` or `"tier":
"capable"` explicitly to override the heuristic. The chosen tier and
which provider/model actually served the request are both in the
response (`"tier"` and `"attempts"`). See DECISIONS.md for the full
policy justification and its known blind spots.

Free-tier provider access is not treated as zero internal cost. The
gateway applies shadow prices per model and charges each key from actual
input/output token usage. It reserves the worst-case reachable model cost
before the provider call, then reconciles to actual usage afterward.

## Endpoints

| Method | Path                     | Purpose                                    |
|--------|--------------------------|---------------------------------------------|
| POST   | `/chat`                  | Proxy a chat request (auth required)        |
| GET    | `/usage?key=<rawKey>`    | Spend summary + recent requests for a key   |
| POST   | `/admin/keys`            | Mint a new virtual key                      |
| GET    | `/healthz`               | Liveness check                              |

See `DECISIONS.md` for the design reasoning and `AI-LOG.md` for how AI
was used to build this.

## Deploying to a real URL

This was built and tested locally in a sandboxed environment without
outbound access to hosting providers, so I did not click "deploy" on a
live platform myself — but the app is a standard stateless Node/Express
process with a file-based SQLite DB, so it deploys the same way
anywhere that runs a Node process and gives you a persistent disk
(or a mounted volume). Two concrete paths:

**Render.com (free tier, easiest):**
1. Push this repo to GitHub.
2. New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `node src/server.js`.
4. Add a **Disk** (e.g. 1 GB, mounted at `/opt/render/project/src/data`)
   so the SQLite file survives restarts — otherwise it resets on every
   deploy, since Render's filesystem is otherwise ephemeral.
5. Add environment variables from `.env.example` (`GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`,
   etc.) in the Render dashboard's Environment tab —
   never commit them.
6. Deploy. Render gives you a `https://<service>.onrender.com` URL.

**Fly.io (more control):**
1. `fly launch` (accept the Node detection, skip Postgres).
2. Add a volume for `/app/data`: `fly volumes create data --size 1`.
3. Mount it in `fly.toml` under `[mounts]`.
4. `fly secrets set GROQ_API_KEY=... GEMINI_API_KEY=... OPENROUTER_API_KEY=...`
5. `fly deploy`.

Either way, the two things that matter for correctness in production:
secrets go in the platform's secret store (never the repo), and the
SQLite file must live on a persistent volume, not ephemeral container
storage — otherwise every redeploy silently resets every key's spend
to zero, which would defeat the whole point of budget enforcement.
