# moraq v1 decisions

Settled 2026-10-26. Background research is in `research/build-approach.md`. Where that file disagrees with this one, this one wins.

## What moraq is

An open source npm library that solo developers import into their Node app. There's no separate server. It handles four jobs: provider adapters behind one request format, routing with fallbacks, per-user rate limits by plan, and response caching.

## Runtime and packaging

- Node 22+ only. ESM only. TypeScript strict. Build with tsdown.
- One npm package, `@moraq/core`, with subpath import `@moraq/core/redis`. (npm blocked the plain name `moraq` as too similar to `morgan` and `ora`.) `ioredis` and `redis` are optional peer deps. No monorepo.
- Runtime deps: zero if possible, `eventsource-parser` at most. Call providers with built-in `fetch`, never with vendor SDKs.
- MIT license.

## Request format and API shape

- moraq uses OpenAI Chat Completions as its format (`messages: [{ role, content }]`), not the Responses API.
- It's a drop-in for the OpenAI SDK. `ai.chat.completions.create(...)` takes and returns standard `ChatCompletion` objects, and with `stream: true` it yields `ChatCompletionChunk`s.
- moraq's extra info goes in one added field: `res.moraq = { provider, cached, attempts }`.
- Every response includes `usage` with token counts. An `onRequest` hook lets the dev log or bill. No price table in v1.
- The `model` field takes either form:
  - `route:<name>` uses a named fallback chain from config.
  - `<provider>/<model>` is a direct call with no fallback.
- moraq has no built-in model list. It passes any model string through. If a provider rejects it, the router moves to the next target.
- API keys come from config, or from `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` and `XAI_API_KEY`. A configured provider with no key throws at startup.

## Features in v1

- In: text chat, streaming, tool calling, JSON/structured output, image input.
- Later: embeddings, audio, image generation, file uploads, batch.

## Providers in v1

- Native adapters: OpenAI, Anthropic, Google Gemini, xAI.
- OpenAI-compatible adapter with presets: DeepSeek, Mistral, Groq, Together, OpenRouter, Ollama.
- v2: AWS Bedrock, Azure OpenAI.

### OpenAI-compatible providers

Settled 2026-11-07.

- xAI, Gemini and every preset run through the OpenAI adapter with their own base URL and key variable: `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `TOGETHER_API_KEY`, `OPENROUTER_API_KEY`. Ollama needs no key.
- Gemini uses Google's official OpenAI-compatible endpoint instead of the native `generateContent` API. It covers chat, streaming, tools, images and JSON schema. A native adapter can replace it later without changing the public API.
- `providers.compatible` adds any other OpenAI-compatible server under a name of your choice, called as `<name>/<model>`.

### Translating to providers that differ from OpenAI

Settled 2026-11-06, with the Anthropic adapter.

- A required field OpenAI makes optional gets a configurable default. Anthropic's `max_tokens` defaults to 4096 (`providers.anthropic.defaultMaxTokens`).
- Sampling settings with no equivalent are dropped without an error: `seed`, `frequency_penalty`, `presence_penalty`. Values outside the provider's range get clamped, e.g. Anthropic's `temperature` caps at 1.
- Anything that changes the shape of the response must be honored or throw. Anthropic has no JSON mode, so moraq forces a call to a hidden `moraq_json_output` tool and returns its input as the message text. Combining `response_format` with `tools` throws `MoraqConfigError` for Anthropic.

## Routing and fallbacks

- A route is an ordered list of `{ provider, model, retries }` targets.
- Rate limit, overload, 5xx, timeout and network errors get retried with exponential backoff and jitter, honoring `retry-after`. Once a target's retries run out, the router moves to the next target.
- Context-length errors, content-filter errors and provider spend caps skip straight to the next target.
- 400 and 401/403 errors throw right away, since they mean a bug in the dev's code or keys.
- Each target has a circuit breaker: after N failures in a row, the router skips it for a cooldown period.
- Streams can fall back only until the first chunk reaches the user. After that, moraq stays on that target.
- If every target fails, moraq throws `MoraqProvidersFailedError` with a list of every attempt (provider, model, error kind, status).

Details settled 2026-11-07, with the router:

- Defaults: 2 retries per target, backoff starting at 500 ms and capped at 8 s, a breaker that trips after 5 failures in a row for 30 s, and a 60 s timeout per attempt. All of these are configurable.
- A `retry-after` longer than the backoff cap moves on to the next target instead of waiting.
- 404 (unknown or retired model) skips to the next target, like a context-length error.
- Direct `<provider>/<model>` calls get the same retries, just no fallback.
- For streams, `create()` resolves when the first chunk arrives, not when the HTTP response starts. A provider that accepts the request and then fails before sending any text still falls back.
- The timeout covers the wait for the response, or for a stream's first chunk. It never cuts off a stream that is already sending.
- When a target trips its breaker mid-retry, the router stops retrying it. If every target in a route is tripped, moraq tries them anyway instead of failing without a call.

## Rate limiting

This feature protects the developer's credits from their own end users. It does not manage provider quotas.

- The dev passes the user on each call: `user: { id, plan }`. moraq never looks the plan up itself.
- Plans live in `createMoraq({ plans })` config. Changing a limit means a redeploy. Loading plans at runtime is v2.
- Limits count requests only, never tokens. moraq checks the limit before the call starts, so a response never gets cut off midway.
- Each plan takes a list of limits, and a request must pass all of them. Example: 5 per hour and 30 per day.
- The dev picks the window strategy per limit: `sliding` (the default), `fixed`, or `token-bucket`.
- A plan can restrict which routes a user may call (`routes: ['cheap']`). Calling any other route throws `MoraqPlanError`.
- Hitting a limit throws `MoraqRateLimitError` with `limit`, `remaining`, `resetAt` and `retryAfterMs`. `ai.limits.check(user)` returns the user's remaining quota without making a call.
- What counts:
  - One `create()` call is one request, whatever retries or fallbacks happen inside it.
  - Cache hits are free.
  - moraq reserves the slot when the call starts and refunds it if every target fails.
- A call with no `user` skips limits, for cron jobs and admin scripts. A plan name missing from config throws.

## Storage

- One `Store` interface that rate limiting and caching both use.
- In-memory store by default. Docs must warn that serverless cold starts and multiple instances reset or split the counts.
- `redisStore(client)` accepts `ioredis` or `node-redis`. Each limit check is one atomic Lua script. Upstash comes in v1.1.

Details settled 2026-11-07, with the limits:

- `Store` has `get`/`set` for the cache and `consume`/`peek`/`refund` for limits. The caller passes the clock (`now`), so every instance agrees on window boundaries.
- `sliding` uses the two-counter approximation: the previous window's count fades out linearly. It's O(1) memory per user. One quirk: with `requests: 1`, a user can wait up to two windows.
- `token-bucket` holds `requests` tokens and refills one every `per / requests`.
- A request takes from each limit in order. If one denies it, the ones already taken get refunded, so a denied call costs nothing.
- Limit keys are `moraq:limit:<requests>/<windowMs>/<strategy>:<userId>`, so changing a limit starts fresh counts.
- Lua scripts get their keys from JS, so they work on Redis Cluster.
- `user` is stripped from the request before it reaches the provider.
- `plans[*].routes` naming a route that doesn't exist throws at `createMoraq()`.

## Caching

- Off by default. The dev turns it on globally or per route, e.g. `cache: { ttl: '1h' }`.
- Exact-match only. The key is a SHA-256 of the normalized request. No semantic cache in v1.
- Shared across users by default. `scope: 'user'` keeps answers per user.
- Any temperature can be cached. The dev decides.
- On a miss, moraq records the stream. On a hit, it replays the stored answer as a stream.
- Identical requests in flight at the same time share one provider call.
- Never cached: errors, cancelled streams, tool-call turns.

Details settled 2026-11-07, with the cache:

- Order of checks per call: plan check, then cache, then rate limit, then the router. A cached answer still respects plan routes, and costs no quota.
- The key leaves out `user`, `stream` and `stream_options`, so streamed and plain calls share entries. Hashing uses Web Crypto, not `node:crypto`, so it also runs on Bun, Deno and edge runtimes.
- Only finished single-choice text answers get cached (`finish_reason` of `stop` or `length`).
- A hit returns the stored `usage`, with `moraq.cached: true` and `attempts: 0`. Billing code should check `cached`.
- A request that arrives while an identical one is running waits for it, up to `timeoutMs`, then makes its own call.
- `scope: 'user'` on a call with no `user` skips the cache rather than sharing.
- Per call, `create(params, { cache: false })` skips both lookup and storing. Per route, `{ targets, cache }` overrides the global setting.
- `onRequest(event)` runs once per call when it finishes: `model`, `user`, `stream`, `provider`, `cached`, `attempts`, `usage`, `durationMs`, `error`. For streams it runs when the stream ends.

## Docs and examples

- The main docs live on a separate docs website.
- The repo also has `examples/` with two small runnable apps that the docs site can link to:
  - `express-plans`: free/pro plans, a fallback route, mapping `MoraqRateLimitError` to a 429 response.
  - `nextjs-chat`: a streaming chat route with caching on.
- Examples call real providers, so CI doesn't run them. Tests use an injected fake `fetch`.
