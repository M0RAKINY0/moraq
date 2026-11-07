'use client'

import { type FormEvent, useState } from 'react'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)

  async function send(event: FormEvent) {
    event.preventDefault()
    if (!input.trim() || busy) return
    const history: Message[] = [...messages, { role: 'user', content: input }]
    setMessages([...history, { role: 'assistant', content: '' }])
    setInput('')
    setBusy(true)

    const res = await fetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: history }),
    })
    if (!res.ok || !res.body) {
      setMessages([...history, { role: 'assistant', content: 'Something went wrong.' }])
      setBusy(false)
      return
    }
    setSource(
      `${res.headers.get('x-moraq-provider')}, cached: ${res.headers.get('x-moraq-cached')}`,
    )

    // Show the answer as it streams in.
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let reply = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      reply += value
      setMessages([...history, { role: 'assistant', content: reply }])
    }
    setBusy(false)
  }

  return (
    <main>
      <h1>moraq chat</h1>
      {messages.map((m, i) => (
        // Messages are only ever appended, so the index is a stable key.
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
        <p key={i}>
          <strong>{m.role === 'user' ? 'You' : 'AI'}:</strong> {m.content}
        </p>
      ))}
      {source && <small>Answered by {source}</small>}
      <form onSubmit={send} style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <input
          aria-label="Message"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          style={{ flex: 1 }}
        />
        <button type="submit" disabled={busy}>
          Send
        </button>
      </form>
    </main>
  )
}
