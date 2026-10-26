# moraq

An AI gateway you import, not a server you run. moraq gives Node apps one API across LLM providers, with fallbacks, rate limiting and caching built in.

> **Status: pre-alpha.** Nothing is published to npm yet and the API will change. Watch the repo if you want to follow along.

## What it will do

- **One request format** for OpenAI, Anthropic, Gemini and any OpenAI-compatible API (Groq, DeepSeek, OpenRouter, Ollama and others).
- **Fallbacks.** If one provider fails or hits its limit, moraq retries and then moves to the next provider in your list.
- **Rate limiting.** Tracks requests and tokens per minute for each provider and reads the limit headers providers send back.
- **Caching.** Identical requests return the stored answer instead of paying for a new call. Works with streaming.

It runs inside your app. No proxy, no extra service, no hosted dashboard.

The design notes live in [`docs/research/build-approach.md`](docs/research/build-approach.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Report security issues privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## License

[MIT](LICENSE)
