import express from 'express'
import { createMoraq, MoraqPlanError, MoraqProvidersFailedError, MoraqRateLimitError } from '@moraq/core'

const ai = createMoraq({
  // Both have free tiers. Keys come from GEMINI_API_KEY and GROQ_API_KEY.
  providers: { gemini: {}, groq: {} },
  routes: {
    // If Gemini is down or rate limited, Groq answers instead.
    cheap: [
      { provider: 'gemini', model: 'gemini-flash-lite-latest' },
      { provider: 'groq', model: 'openai/gpt-oss-20b' },
    ],
    smart: [
      { provider: 'groq', model: 'openai/gpt-oss-120b' },
      { provider: 'gemini', model: 'gemini-flash-latest' },
    ],
  },
  plans: {
    free: {
      limits: [
        { requests: 5, per: '1h' },
        { requests: 20, per: '1d' },
      ],
      routes: ['cheap'],
    },
    pro: { limits: [{ requests: 100, per: '1h', strategy: 'token-bucket' }] },
  },
  cache: { ttl: '10m' },
  onRequest: (e) => {
    const who = e.user ? `${e.user.id}/${e.user.plan}` : 'anonymous'
    console.log(
      `${who} ${e.model} -> ${e.provider ?? 'failed'} cached=${e.cached} ${e.durationMs}ms`,
    )
  },
})

const app = express()
app.use(express.json())

// Stand-in for your auth. A real app reads the user and their plan from the session.
function currentUser(req) {
  return { id: req.get('x-user-id') ?? 'demo', plan: req.get('x-plan') ?? 'free' }
}

app.post('/chat', async (req, res) => {
  const user = currentUser(req)
  try {
    const completion = await ai.chat.completions.create({
      model: `route:${req.body.route ?? 'cheap'}`,
      messages: [{ role: 'user', content: String(req.body.message ?? '') }],
      user,
    })
    res.json({ reply: completion.choices[0]?.message.content, moraq: completion.moraq })
  } catch (error) {
    if (error instanceof MoraqRateLimitError) {
      res.set('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)))
      return res.status(429).json({ error: error.message, resetAt: error.resetAt })
    }
    if (error instanceof MoraqPlanError) return res.status(403).json({ error: error.message })
    if (error instanceof MoraqProvidersFailedError) {
      return res.status(502).json({ error: 'Every AI provider failed', attempts: error.attempts })
    }
    throw error
  }
})

app.get('/usage', async (req, res) => {
  res.json(await ai.limits.check(currentUser(req)))
})

const port = Number(process.env.PORT ?? 3000)
app.listen(port, () => console.log(`Listening on http://localhost:${port}`))
