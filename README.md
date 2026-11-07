# moraq

An AI gateway you import, not a server you run. moraq gives a Node app one API for ten LLM providers, with fallbacks, per-user rate limits and caching built in.

> **Status: pre-release.** Not on npm yet. The API may still change before 1.0.

```ts
import { createMoraq } from 'moraq'

const ai = createMoraq({
  providers: { openai: {}, anthropic: {} }, // keys from OPENAI_API_KEY, ANTHROPIC_API_KEY
  routes: {
    chat: [
      { provider: 'openai', model: 'gpt-4o-mini' },
      { provider: 'anthropic', model: 'claude-haiku-4-5' }, // used if OpenAI fails
    ],
  },
  plans: { free: { limits: [{ requests: 5, per: '1h' }] } },
  cache: { ttl: '1h' },
})

const res = await ai.chat.completions.create({
  model: 'route:chat',
  messages: [{ role: 'user', content: 'Hello' }],
  user: { id: userId, plan: 'free' },
})
res.choices[0].message.content
res.moraq // { provider: 'openai', cached: false, attempts: 1 }
```

It runs inside your app. No proxy, no extra service, no hosted dashboard. Requests and responses use the OpenAI Chat Completions format, so code written for the OpenAI SDK works with any provider.

## Contents

- [Install](#install)
- [Providers](#providers)
- [Streaming](#streaming)
- [Routes and fallbacks](#routes-and-fallbacks)
- [Rate limits per user](#rate-limits-per-user)
- [Caching](#caching)
- [Sharing state with Redis](#sharing-state-with-redis)
- [Logging and billing](#logging-and-billing)
- [Errors](#errors)
- [Examples](#examples)

## Install

Requires Node 22 or newer. moraq has no runtime dependencies.

```sh
npm install moraq
```

## Providers

Call any configured provider directly as `<provider>/<model>`:

```ts
await ai.chat.completions.create({ model: 'anthropic/claude-haiku-4-5', messages })
await ai.chat.completions.create({ model: 'groq/openai/gpt-oss-20b', messages })
```

| Provider | Config key | API key variable |
|---|---|---|
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` |
| xAI | `xai` | `XAI_API_KEY` |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` |
| Mistral | `mistral` | `MISTRAL_API_KEY` |
| Groq | `groq` | `GROQ_API_KEY` |
| Together | `together` | `TOGETHER_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| Ollama (local) | `ollama` | none |

Each provider takes `{ apiKey?, baseURL? }`. A configured provider with no key throws when you call `createMoraq()`, not on the first request.

Any other OpenAI-compatible server goes under `compatible`:

```ts
createMoraq({ providers: { compatible: { lab: { baseURL: 'https://llm.example.com/v1', apiKey: '...' } } } })
await ai.chat.completions.create({ model: 'lab/my-model', messages })
```

Supported in every provider: text, streaming, tool calling, image input and `response_format` (JSON mode and JSON schema).

Anthropic needs a few translations. `max_tokens` defaults to 4096 (`providers.anthropic.defaultMaxTokens`). `seed` and the penalty settings are dropped, and `temperature` is capped at 1. JSON mode works through a hidden tool call, so it can't be combined with your own `tools`.

## Streaming

```ts
const stream = await ai.chat.completions.create({ model: 'route:chat', messages, stream: true })
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta.content ?? '')
```

Chunks are standard `ChatCompletionChunk`s. The last chunk carries `usage`. `create()` resolves when the first chunk arrives, so errors before any text throw from the `await`, and a route can still fall back. Breaking out of the loop or calling `stream.controller.abort()` closes the connection to the provider.

## Routes and fallbacks

A route is an ordered list of targets. Call it with `model: 'route:<name>'`.

```ts
createMoraq({
  providers: { openai: {}, anthropic: {}, gemini: {} },
  routes: {
    chat: [
      { provider: 'openai', model: 'gpt-4o-mini', retries: 2 },
      { provider: 'anthropic', model: 'claude-haiku-4-5' },
      { provider: 'gemini', model: 'gemini-flash-latest' },
    ],
  },
})
```

| What went wrong | What moraq does |
|---|---|
| Rate limit (429), overloaded, 5xx, timeout, network | Retries the same target with backoff, then moves to the next |
| Unknown model (404), context too long, content filter, quota or spend cap | Moves to the next target right away |
| Bad request (400), bad key (401/403) | Throws right away. It's a bug another provider won't fix |

- Retries use exponential backoff with jitter and honor `retry-after`.
- A circuit breaker skips a target after 5 failures in a row, for 30 seconds.
- Each attempt times out after 60 seconds without a response, or without a stream's first chunk.
- A stream can fall back until its first chunk. After that it stays on its provider.
- Direct `<provider>/<model>` calls get the same retries, just no fallback.

All of these are configurable: `retry: { retries, baseDelayMs, maxDelayMs }`, `circuitBreaker: { failureThreshold, cooldownMs }` (or `false`) and `timeoutMs`.

## Rate limits per user

Limit how many requests each of your users can make, by plan. moraq checks before calling a provider, so a blocked request costs nothing.

```ts
createMoraq({
  providers: { openai: {} },
  routes: { cheap: [...], smart: [...] },
  plans: {
    free: { limits: [{ requests: 5, per: '1h' }, { requests: 20, per: '1d' }], routes: ['cheap'] },
    pro: { limits: [{ requests: 100, per: '1h', strategy: 'token-bucket' }] },
  },
})

await ai.chat.completions.create({ model: 'route:cheap', messages, user: { id: user.id, plan: user.plan } })
await ai.limits.check({ id: user.id, plan: user.plan }) // [{ limit, remaining, resetAt }, ...]
```

- `per` takes milliseconds or `'30s'`, `'15m'`, `'1h'`, `'1d'`.
- `strategy` is `'sliding'` (default), `'fixed'` or `'token-bucket'`.
- A request has to fit every limit on its plan.
- `routes` restricts a plan to those routes. Anything else throws `MoraqPlanError`.
- One `create()` counts once, however many retries happen inside it. A call that fails gets its request back. Cache hits are free.
- A call without `user` isn't limited, which suits cron jobs and admin scripts. `user` is never sent to the provider.

Map the error to a 429 in your API:

```ts
catch (error) {
  if (error instanceof MoraqRateLimitError) {
    res.set('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)))
    return res.status(429).json({ error: error.message, resetAt: error.resetAt })
  }
}
```

## Caching

Off by default. Turn it on for everything, or per route:

```ts
createMoraq({
  providers: { openai: {} },
  cache: { ttl: '1h' },
  routes: {
    chat: [{ provider: 'openai', model: 'gpt-4o-mini' }],
    live: { targets: [{ provider: 'openai', model: 'gpt-4o' }], cache: false },
  },
})
```

- An identical request returns the stored answer with `res.moraq.cached === true`. There's no provider call and no rate-limit cost.
- Streamed and plain calls share entries. A cached answer replays as a stream if you asked for one.
- Identical requests that arrive while one is in flight share its provider call.
- Never cached: errors, tool-call turns and abandoned streams.
- `scope: 'user'` keeps answers per `user.id` instead of sharing them.
- Skip it for one call with `create(params, { cache: false })`.

## Sharing state with Redis

Limits and the cache live in memory by default. That's fine for one long-running server. On serverless platforms or with several instances, each instance keeps its own counts. Pass a Redis client to share them:

```ts
import { Redis } from 'ioredis' // or createClient() from 'redis'
import { redisStore } from 'moraq/redis'

createMoraq({ providers: { openai: {} }, store: redisStore(new Redis(process.env.REDIS_URL)) })
```

Each limit check is one atomic Lua script.

## Logging and billing

`onRequest` runs once per call when it finishes:

```ts
createMoraq({
  providers: { openai: {} },
  onRequest: ({ model, user, provider, cached, attempts, usage, durationMs, error }) => {
    db.insert('ai_calls', { userId: user?.id, provider, cached, tokens: usage?.total_tokens, durationMs })
  },
})
```

For streams it runs when the stream ends. A cache hit reports the stored `usage`, so check `cached` before billing for tokens.

## Errors

All errors extend `MoraqError`.

| Error | When |
|---|---|
| `MoraqConfigError` | Bad config, a missing key, an unknown route, plan or provider |
| `MoraqProviderError` | One provider failed. `kind`, `provider`, `status`, `body`, `retryAfterMs` |
| `MoraqProvidersFailedError` | Every target in a route failed. `attempts` lists each try |
| `MoraqRateLimitError` | A user hit a limit. `limit`, `resetAt`, `retryAfterMs` |
| `MoraqPlanError` | A user's plan doesn't allow the route they called |

## Examples

- [`examples/express-plans`](examples/express-plans): an API with free and pro plans, a fallback route and errors mapped to HTTP status codes.
- [`examples/nextjs-chat`](examples/nextjs-chat): a streaming chat page with caching.

Both use Gemini and Groq, which have free tiers.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Report security issues privately as described in [SECURITY.md](SECURITY.md). Design decisions are recorded in [docs/decisions.md](docs/decisions.md), and the release process in [RELEASING.md](RELEASING.md).

## License

[MIT](LICENSE)
