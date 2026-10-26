Live tests against real provider APIs. They run nightly in `.github/workflows/smoke.yml`, or locally with `npm run test:smoke`.

Each suite must skip itself when its key is missing, e.g. `describe.skipIf(!process.env.OPENAI_API_KEY)`. Use the cheapest model each provider offers and keep requests tiny.
