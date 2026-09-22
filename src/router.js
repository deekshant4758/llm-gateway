// router.js — cheap-vs-capable request router (stretch goal).
//
// Policy: route on the *shape* of the request, not its content. A short
// prompt paired with a small requested `max_tokens` is treated as a
// "cheap" task — a lookup, a classification, a short chat turn, a yes/no
// — and goes to each provider's smaller/faster model. Anything longer,
// or a caller that explicitly asks for more headroom via `max_tokens`,
// is treated as "capable" territory and goes to each provider's larger
// model. An explicit `tier` field in the request always wins over the
// heuristic, since the caller usually knows more about the task than
// two numbers can capture.
//
// Why shape instead of content? A real content-based classifier (e.g.
// "does this look like a coding question / does it need multi-step
// reasoning") needs either a taxonomy of task types or a cheap model
// call just to classify the request — which either adds real
// engineering scope or defeats the purpose of a *cheap* pre-filter by
// spending a model call to decide whether to spend a model call. Input
// length and requested output length are free signals already present
// on every request, cost nothing extra to compute, and correlate
// reasonably well with task complexity in practice: a one-line question
// expecting a one-line answer is rarely the request that needs the
// biggest model. See DECISIONS.md for where this heuristic is expected
// to be wrong and what a better version would look like.

const CHEAP_INPUT_TOKEN_THRESHOLD = 200; // ~800 characters of input
const CHEAP_MAX_OUTPUT_TOKENS_THRESHOLD = 150; // caller isn't asking for a long answer

function chooseTier({ explicitTier, estInputTokens, requestedMaxTokens }) {
  if (explicitTier === "cheap" || explicitTier === "capable") return explicitTier;

  const looksCheap =
    estInputTokens <= CHEAP_INPUT_TOKEN_THRESHOLD && requestedMaxTokens <= CHEAP_MAX_OUTPUT_TOKENS_THRESHOLD;

  return looksCheap ? "cheap" : "capable";
}

module.exports = { chooseTier, CHEAP_INPUT_TOKEN_THRESHOLD, CHEAP_MAX_OUTPUT_TOKENS_THRESHOLD };
