# moraq v1 decisions

Settled 2026-10-26. Background research is in `research/build-approach.md`. Where that file disagrees with this one, this one wins.

## What moraq is

An open source npm library that solo developers import into their Node app. There's no separate server. It handles four jobs: provider adapters behind one request format, routing with fallbacks, per-user rate limits by plan, and response caching.

## Runtime and packaging

- Node 22+ only. ESM only. TypeScript strict. Build with tsdown.
- One npm package with subpath imports `moraq` and `moraq/redis`. `ioredis` and `redis` are optional peer deps. No monorepo.
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

## Routing and fallbacks

- A route is an ordered list of `{ provider, model, retries }` targets.
- Rate limit, overload, 5xx, timeout and network errors get retried with exponential backoff and jitter, honoring `retry-after`. Once a target's retries run out, the router moves to the next target.
- Context-length errors, content-filter errors and provider spend caps skip straight to the next target.
- 400 and 401/403 errors throw right away, since they mean a bug in the dev's code or keys.
- Each target has a circuit breaker: after N failures in a row, the router skips it for a cooldown period.
- Streams can fall back only until the first chunk reaches the user. After that, moraq stays on that target.
- If every target fails, moraq throws `MoraqProvidersFailedError` with a list of every attempt (provider, model, error kind, status).

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

## Caching

- Off by default. The dev turns it on globally or per route, e.g. `cache: { ttl: '1h' }`.
- Exact-match only. The key is a SHA-256 of the normalized request. No semantic cache in v1.
- Shared across users by default. `scope: 'user'` keeps answers per user.
- Any temperature can be cached. The dev decides.
- On a miss, moraq records the stream. On a hit, it replays the stored answer as a stream.
- Identical requests in flight at the same time share one provider call.
- Never cached: errors, cancelled streams, tool-call turns.

## Docs and examples

- The main docs live on a separate docs website.
- The repo also has `examples/` with two small runnable apps that the docs site can link to:
  - `express-plans`: free/pro plans, a fallback route, mapping `MoraqRateLimitError` to a 429 response.
  - `nextjs-chat`: a streaming chat route with caching on.
- Examples call real providers, so CI doesn't run them. Tests use an injected fake `fetch`.
