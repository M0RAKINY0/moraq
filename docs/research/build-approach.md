# How to build moraq

Research notes, 2026-10-26. Scope agreed so far: an open source npm library that solo developers import into their own Node project. No separate server. v1 covers provider adapters with one request format, routing with fallbacks, rate limiting, and caching.

## 1. Overall shape: an in-process pipeline

Every competitor that does more than one job uses a chain of steps around the provider call. Each step can act before the call, after it, or both. The Vercel AI SDK calls these middleware (`wrapLanguageModel` with `transformParams`, `wrapGenerate`, `wrapStream` hooks). Portkey's gateway runs plugin hooks at `beforeRequest` and `afterRequest`. Koa's "onion" model is the same idea.

Proposed order for one `ai.chat()` call:

```
user request
  -> normalize + validate        (one moraq format)
  -> cache lookup                (hit: return or replay, stop here)
  -> router                      (picks target 1, then 2, ... on failure)
       -> rate limiter           (per provider+model, may wait or skip)
       -> adapter.toRequest      (moraq format -> provider JSON)
       -> fetch                  (with timeout via AbortSignal)
       -> adapter.fromResponse   (provider JSON/SSE -> moraq format)
       -> rate limiter update    (read provider headers, real token usage)
  -> cache write
  -> result / stream to user
```

Two ordering choices matter:

- Cache sits before the rate limiter. A cache hit should not spend quota.
- The rate limiter sits inside the router, per target. If OpenAI's local bucket is empty, the router can move on to Anthropic right away instead of sleeping.

Keep the steps internal in v1. A public middleware API is easy to add later and hard to change once people depend on it.

## 2. Provider adapters and request format

### The format decision

There are two ways competitors do this:

| Approach | Who | Upside | Downside |
|---|---|---|---|
| Use OpenAI Chat Completions as the format | LiteLLM, token.js, Portkey | Devs already know it. Many providers accept it natively. | Loses features OpenAI lacks: Anthropic thinking blocks, `cache_control`, Gemini safety settings. |
| Own format, mapped to each provider | Vercel AI SDK (`LanguageModelV3`) | Can represent every provider's features cleanly. | Devs must learn a new shape. More work to design. |

Recommendation: own types, shaped to look like OpenAI's (`messages`, `role`, content parts, `tools`) so it feels familiar, plus a `providerOptions` escape hatch per provider for features the shared shape lacks. This is close to what the AI SDK settled on after several versions.

### The adapter contract

Each provider is a plain object, roughly:

```ts
interface ProviderAdapter {
  id: string
  toRequest(req: MoraqRequest): { url: string; headers: Record<string, string>; body: unknown }
  fromResponse(json: unknown): MoraqResponse
  parseStream(events: AsyncIterable<SSEEvent>): AsyncIterable<MoraqStreamEvent>
  classifyError(status: number, body: unknown, headers: Headers): MoraqError
  readRateLimit(headers: Headers): RateLimitSnapshot | undefined
}
```

Notes:

- Call providers with built-in `fetch`. Do not depend on the vendor SDKs. They add weight, they have their own retry logic that fights ours (Anthropic's SDK retries twice by default), and their version churn becomes our problem.
- SSE parsing: use `eventsource-parser` (small, no deps) or write a ~60 line parser. Streaming translation is where most adapter bugs live, especially tool call deltas.
- One `openaiCompatible({ baseURL })` adapter covers Groq, Together, DeepSeek, xAI, OpenRouter, Ollama, LM Studio and others. That gives wide coverage for little code.
- Suggested v1 set: OpenAI, Anthropic, Google Gemini, openai-compatible.
- `classifyError` is what makes routing work. Each adapter maps its own errors to shared kinds: `rate_limit`, `overloaded`, `server`, `timeout`, `auth`, `bad_request`, `context_length`, `content_filter`, `quota_exhausted`.

### Stream events

Expose streams as an `AsyncIterable` of typed events: `text-delta`, `tool-call-delta`, `tool-call`, `reasoning-delta`, `usage`, `finish`, `error`. Add helpers on top (`stream.text()`, `stream.toReadableStream()`) so a solo dev can pipe it into a Next.js or Express response in one line.

## 3. Routing and fallbacks

A route is an ordered list of targets. Each target names its own provider and model, since model names differ per provider.

```ts
routes: {
  default: [
    { provider: 'openai', model: '<openai-model>', retries: 2 },
    { provider: 'anthropic', model: '<anthropic-model>' },
  ],
}
```

What to retry vs fall back vs give up:

| Error kind | Same target again? | Next target? |
|---|---|---|
| `rate_limit` (429), `overloaded` (529), `server` (5xx), `timeout`, network | Yes, with backoff | Yes, once retries run out |
| `context_length`, `content_filter` | No | Yes. Another model may accept it. |
| `auth` (401/403), `bad_request` (400) | No | No. It's a bug in the user's code or keys. Throw. |
| `quota_exhausted` (Anthropic spend cap returns 429 with `error_code: enforced_spend_limit_reached`) | No | Yes |

Details that competitors get right and we should copy:

- Exponential backoff with full jitter. Honor `retry-after` when present.
- A simple circuit breaker per target: after N failures in a row, skip that target for a cooldown period. Saves the user a timeout on every request while a provider is down.
- Timeouts through `AbortSignal.timeout()` combined with the user's own signal using `AbortSignal.any()`.

Streaming is the hard case. Once the first chunk has gone to the user, a fallback would restart the answer and send duplicate text. Rule: retry and fall back freely until the first chunk arrives, then commit to that target and surface errors after that point. Portkey and LiteLLM behave this way too.

Cockatiel is a good resilience library, but its policies wrap a function returning one Promise, which doesn't fit "commit after first chunk". Writing our own is about 150 lines and avoids the dependency.

## 4. Rate limiting

Two layers, because the library can't see the provider's real quota:

**Proactive (local token buckets).** One bucket per provider+model for requests per minute and one for tokens per minute. Capacity equals the per-minute limit and refills continuously at limit/60 per second. Anthropic documents that its own limiter is a token bucket, so this matches the provider. Before a call, estimate tokens (prompt characters / 4 + `max_tokens`) and take them from the bucket. After the call, correct the bucket using the real `usage` numbers. Estimates will overshoot or undershoot a little with concurrent calls; that's acceptable.

**Reactive (provider headers).** After every response, read what the provider says is left and shrink the local bucket to match:

- OpenAI: `x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-*`.
- Anthropic: `anthropic-ratelimit-requests-remaining`, `anthropic-ratelimit-tokens-remaining`, `*-reset` as RFC 3339 timestamps. Header names differ between Anthropic doc versions, so parse defensively.
- On 429, use `retry-after` (seconds) when present. It is not on every 429.

When a bucket is empty: if another target in the route has room, go there now. If not, wait up to `maxWaitMs`, then throw a typed `RateLimitedError`.

**Open question:** for solo devs, "rate limiting" often means a different thing: stopping their own end users from burning their API credits (e.g. 20 requests per user per hour). Same token bucket code, keyed by user ID instead of provider. Needs a decision before design.

### Storage

Both rate limits and the cache need state. Use one small store interface:

```ts
interface Store {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string, ttlMs?: number): Promise<void>
  delete(key: string): Promise<void>
}
```

Default: in-memory. Ship a Redis adapter later. Warn in docs that in-memory state resets on every serverless cold start (Vercel, Lambda), so limits there are per instance.

## 5. Caching

**Exact-match only in v1.** Cache key = SHA-256 (`node:crypto`) of the normalized request with sorted keys: model, messages, tools, temperature, max tokens, response format. Leave out fields that don't change the answer (user ID, metadata).

**Streaming.** On a miss, tee the stream: send chunks to the user and collect them. On a hit, replay the stored events as a stream so calling code doesn't change. NVIDIA's NeMo Relay cache stores one assembled response and replays it as chunks, so buffered and streaming calls share the same entries. Copy that.

**Request coalescing.** If two identical requests arrive while the first is still running, the second should wait for the first instead of paying twice. NeMo Relay doesn't do this. It's cheap to add and a good selling point.

**Defaults.** Off unless enabled, then TTL-based, with per-request `cache: false`. Never cache errors or calls that ended early. NeMo Relay only caches temperature-0 requests by default; I think that's too strict for solo devs, so make it opt-in config rather than a rule.

**Semantic caching: skip for v1.** It needs an embeddings call and a vector store per lookup, can return wrong answers for similar but different prompts, and is a lot of moving parts for a solo dev. Revisit later as a plugin.

Note that provider prompt caching (Anthropic `cache_control`, OpenAI automatic caching) is a different feature that saves cost on the provider side. Support it through `providerOptions`, don't confuse it with moraq's cache.

## 6. Packaging and tooling

- TypeScript, strict mode.
- Node 22+. Node 20 reached end of life in April 2026. Node 22.12+ can `require()` ESM, so ship ESM only and skip the dual build. If CJS turns out to be needed, tsdown can emit both.
- Build with tsdown (ESM default, emits `.d.ts`). tsup also works.
- Runtime deps: aim for zero, `eventsource-parser` at most. Use built-in `fetch`, `crypto`, `AbortSignal`.
- Subpath exports so unused providers aren't bundled: `moraq`, `moraq/openai`, `moraq/anthropic`, `moraq/gemini`.
- No Node-only APIs in core (use Web Crypto), so it also runs on Bun, Deno and edge runtimes for free.
- Tests: Vitest. Inject `fetch` into the client so tests pass a fake that returns recorded provider responses and SSE streams. No live API calls in CI.

## 7. Public API sketch

```ts
import { createMoraq } from 'moraq'
import { openai } from 'moraq/openai'
import { anthropic } from 'moraq/anthropic'

const ai = createMoraq({
  providers: {
    openai: openai({ apiKey: process.env.OPENAI_API_KEY }),
    anthropic: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  },
  routes: {
    default: [
      { provider: 'openai', model: '<openai-model>', retries: 2 },
      { provider: 'anthropic', model: '<anthropic-model>' },
    ],
  },
  rateLimit: { openai: { rpm: 500, tpm: 200_000 } },
  cache: { ttlMs: 60 * 60 * 1000 },
})

const res = await ai.chat({ route: 'default', messages: [{ role: 'user', content: 'Hi' }] })
res.text; res.usage; res.provider; res.cached

const stream = ai.stream({ route: 'default', messages })
for await (const ev of stream) if (ev.type === 'text-delta') process.stdout.write(ev.text)
```

## Decisions needed

1. Rate limiting: protect against provider limits, limit the developer's own end users, or both?
2. Request format: own OpenAI-like types (recommended) or plain OpenAI Chat Completions?
3. v1 providers: OpenAI, Anthropic, Gemini, openai-compatible?
4. Node only, or also Bun/Deno/edge from day one?

## Sources

- AI SDK middleware: https://ai-sdk.dev/v7/docs/ai-sdk-core/middleware
- AI SDK 3.4 middleware announcement: https://vercel.com/blog/ai-sdk-3-4
- Portkey routing: https://www.mintlify.com/portkey-AI/gateway/concepts/routing
- Portkey configs: https://www.mintlify.com/portkey-AI/gateway/concepts/configs
- Anthropic rate limits: https://docs.claude.com/en/api/rate-limits
- Anthropic errors: https://platform.claude.com/docs/en/api/errors
- OpenAI rate limits: https://developers.openai.com/api/docs/guides/rate-limits
- Client-side RPM/TPM bucket example: https://docs.rs/crate/klieo-core/3.8.2/source/src/rate_limit.rs
- Azure APIM token limit caveats: https://learn.microsoft.com/en-my/azUre/api-management/llm-token-limit-policy
- NeMo Relay response cache: https://docs.nvidia.com/nemo/relay/configure-plugins/adaptive/response-cache
- APISIX ai-cache: https://docs.api7.ai/hub/ai-cache
- Exact vs semantic cache: https://dev.to/panda_suraj/scaling-llms-why-deterministic-hashing-isnt-enough-3pk4
- Cockatiel: https://github.com/connor4312/cockatiel
- token.js: https://www.npmjs.com/token.js
- tsdown migration notes: https://unpkg.com/create-node-lib@2.19.21/docs/migrations/MIGRATION-GUIDE-TSUP-TO-TSDOWN.md
- ESM/CJS in 2026: https://blog.openreplay.com/fr/fin-dual-cjs-esm-builds-nodejs/
