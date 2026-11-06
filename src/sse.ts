export interface SSEEvent {
  event?: string
  data: string
}

/**
 * Parses a server-sent events body into events. Handles `\n`, `\r\n` and `\r` line endings,
 * including a `\r\n` split across two network chunks. Stopping the iteration cancels the body,
 * which closes the connection.
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.getReader()
  // `stream: true` keeps a multi-byte character that is split across chunks intact.
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  let event: string | undefined

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })

      // A trailing '\r' may be the first half of '\r\n', so hold it until the next chunk.
      const end = buffer.endsWith('\r') ? buffer.length - 1 : buffer.length
      const lines = buffer.slice(0, end).split(/\r\n|\r|\n/)
      buffer = (lines.pop() ?? '') + buffer.slice(end)

      for (const line of lines) {
        if (line === '') {
          if (data.length > 0)
            yield { data: data.join('\n'), ...(event !== undefined && { event }) }
          data = []
          event = undefined
          continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        let fieldValue = colon === -1 ? '' : line.slice(colon + 1)
        if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1)
        if (field === 'data') data.push(fieldValue)
        else if (field === 'event') event = fieldValue
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}
