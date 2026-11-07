# Next.js: streaming chat with caching

A one-page chat. The answer streams in as it's written. Gemini answers first, and Groq takes over if Gemini fails before sending any text. Asking the same thing twice replays the cached answer instantly.

Both providers have free tiers, so this runs at no cost.

## Run it

1. Get a key from [Google AI Studio](https://aistudio.google.com/apikey) and one from [Groq](https://console.groq.com/keys).
2. Put them in `.env.local` in this folder. It's ignored by git.

   ```sh
   GEMINI_API_KEY=...
   GROQ_API_KEY=...
   ```

3. Build moraq once from the repo root, then start the app:

   ```sh
   cd ../.. && npm ci && npm run build && cd examples/nextjs-chat
   npm install
   npm run dev
   ```

4. Open http://localhost:3000. Under the chat it shows which provider answered and whether the answer came from the cache.

## What to look at

- `app/api/chat/route.ts`: the whole moraq setup, and how a `MoraqStream` becomes a streaming `Response`. Its `cancel()` closes the provider stream when the browser goes away.
- `app/page.tsx`: reading the streamed text in the browser. Nothing moraq-specific here.
