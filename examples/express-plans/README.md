# Express: plans, fallbacks and caching

A small API where free users get 5 requests an hour on a cheap route and pro users get 100 on any route. Gemini answers first, and Groq takes over if Gemini fails. Repeated questions come from the cache for 10 minutes.

Both providers have free tiers, so this runs at no cost.

## Run it

1. Get a key from [Google AI Studio](https://aistudio.google.com/apikey) and one from [Groq](https://console.groq.com/keys).
2. Put them in a `.env` file in this folder. It's ignored by git.

   ```sh
   GEMINI_API_KEY=...
   GROQ_API_KEY=...
   ```

3. Build moraq once from the repo root, then start the server:

   ```sh
   cd ../.. && npm ci && npm run build && cd examples/express-plans
   npm install
   npm start
   ```

## Try it

```sh
# A free user on the cheap route
curl -X POST localhost:3000/chat -H 'content-type: application/json' -d '{"message":"Say hi"}'

# The same question again comes from the cache: "cached": true, no quota used
curl -X POST localhost:3000/chat -H 'content-type: application/json' -d '{"message":"Say hi"}'

# A free user asking for the smart route gets 403
curl -X POST localhost:3000/chat -H 'content-type: application/json' -d '{"message":"Hi","route":"smart"}'

# A pro user can use it
curl -X POST localhost:3000/chat -H 'x-plan: pro' -H 'content-type: application/json' -d '{"message":"Hi","route":"smart"}'

# Remaining quota for the demo user
curl localhost:3000/usage
```

After 5 uncached questions in an hour, a free user gets `429` with a `Retry-After` header.

## What to look at

- `routes` in `server.js`: the fallback chains.
- `plans`: the limits per plan, and which routes each plan may call.
- The `catch` block: how each moraq error maps to an HTTP status.
- The console: `onRequest` logs which provider answered and whether it came from the cache.

This uses the default in-memory store, so limits reset when the server restarts. For more than one instance, pass `store: redisStore(redis)` from `moraq/redis`.
