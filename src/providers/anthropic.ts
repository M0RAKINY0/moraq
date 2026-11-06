import { MoraqConfigError, MoraqProviderError, type ProviderErrorKind } from '../errors.js'
import type { SSEEvent } from '../sse.js'
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionChunkDelta,
  ChatCompletionContentPart,
  ChatCompletionCreateParams,
  ChatCompletionFinishReason,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  CompletionUsage,
} from '../types.js'
import type { ProviderAdapter, ProviderRequest } from './types.js'

export interface AnthropicAdapterOptions {
  apiKey: string
  baseURL?: string
  /** Anthropic requires `max_tokens`. This fills it in when a request leaves it out. */
  defaultMaxTokens?: number
}

const API_VERSION = '2023-06-01'
/** JSON mode is emulated with a forced call to this tool, then turned back into text. */
const JSON_TOOL = 'moraq_json_output'

type Block =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string }
    }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: Block[]
}

interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

interface AnthropicResponse {
  id: string
  model: string
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>
  stop_reason: string | null
  usage: AnthropicUsage
}

export function createAnthropicAdapter({
  apiKey,
  baseURL = 'https://api.anthropic.com/v1',
  defaultMaxTokens = 4096,
}: AnthropicAdapterOptions): ProviderAdapter {
  return {
    id: 'anthropic',
    buildRequest(params: ChatCompletionCreateParams): ProviderRequest {
      return {
        url: `${baseURL}/messages`,
        init: {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': API_VERSION,
            'content-type': 'application/json',
          },
          body: JSON.stringify(toAnthropicBody(params, defaultMaxTokens)),
        },
      }
    },
    parseResponse(json: unknown, params: ChatCompletionCreateParams): ChatCompletion {
      const res = json as AnthropicResponse
      const jsonMode = isJsonMode(params)
      let text = ''
      const toolCalls: ChatCompletionMessageToolCall[] = []
      for (const block of res.content) {
        if (block.type === 'text') text += block.text ?? ''
        else if (block.type === 'tool_use' && jsonMode && block.name === JSON_TOOL) {
          text += JSON.stringify(block.input)
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id ?? '',
            type: 'function',
            function: { name: block.name ?? '', arguments: JSON.stringify(block.input ?? {}) },
          })
        }
      }
      return {
        id: res.id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: res.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: text === '' && toolCalls.length > 0 ? null : text,
              ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
            },
            finish_reason: finishReason(res.stop_reason, jsonMode),
          },
        ],
        usage: toUsage(res.usage),
      }
    },
    parseStream(
      events: AsyncIterable<SSEEvent>,
      params: ChatCompletionCreateParams,
    ): AsyncIterable<ChatCompletionChunk> {
      return streamChunks(events, isJsonMode(params))
    },
    classifyError(status: number, body: unknown): ProviderErrorKind {
      const error = errorObject(body)
      const message = typeof error?.message === 'string' ? error.message.toLowerCase() : ''
      if (status === 401 || status === 403) return 'auth'
      if (status === 429) {
        const code = (error?.details as { error_code?: unknown } | undefined)?.error_code
        return code === 'enforced_spend_limit_reached' ? 'quota_exhausted' : 'rate_limit'
      }
      if (status === 400 && message.includes('prompt is too long')) return 'context_length'
      if (status === 400 && message.includes('credit balance')) return 'quota_exhausted'
      if (status >= 400 && status < 500) return 'bad_request'
      if (status === 529 || status === 503) return 'overloaded'
      if (status >= 500 && status < 600) return 'server'
      return 'unknown'
    },
  }
}

function isJsonMode(params: ChatCompletionCreateParams): boolean {
  const type = params.response_format?.type
  return type === 'json_object' || type === 'json_schema'
}

function toAnthropicBody(params: ChatCompletionCreateParams, defaultMaxTokens: number) {
  const system: Array<{ type: 'text'; text: string }> = []
  const messages: AnthropicMessage[] = []

  for (const message of params.messages) {
    if (message.role === 'system' || message.role === 'developer') {
      system.push({ type: 'text', text: textOf(message.content) })
      continue
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const blocks = toBlocks(message)
    if (blocks.length === 0) continue
    // Anthropic wants tool results inside a user turn, so merge consecutive same-role messages.
    const last = messages.at(-1)
    if (last?.role === role) last.content.push(...blocks)
    else messages.push({ role, content: blocks })
  }

  // seed, frequency_penalty and presence_penalty have no Anthropic equivalent, so they're dropped.
  // Anthropic's temperature tops out at 1, OpenAI's at 2, so higher values get clamped.
  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.max_completion_tokens ?? params.max_tokens ?? defaultMaxTokens,
    messages,
  }
  if (system.length > 0) body.system = system
  if (params.temperature != null) body.temperature = Math.min(params.temperature, 1)
  if (params.top_p != null) body.top_p = params.top_p
  if (params.stop != null)
    body.stop_sequences = Array.isArray(params.stop) ? params.stop : [params.stop]
  if (params.stream) body.stream = true

  if (isJsonMode(params)) {
    if (params.tools?.length) {
      throw new MoraqConfigError(
        'anthropic cannot combine response_format with tools, since moraq emulates JSON mode with a tool',
      )
    }
    const format = params.response_format
    const schema = format?.type === 'json_schema' ? format.json_schema.schema : undefined
    body.tools = [
      {
        name: JSON_TOOL,
        description: 'Return the final answer as JSON.',
        input_schema: schema ?? { type: 'object' },
      },
    ]
    body.tool_choice = { type: 'tool', name: JSON_TOOL }
    return body
  }

  if (params.tools?.length) {
    body.tools = params.tools.map((tool) => ({
      name: tool.function.name,
      ...(tool.function.description !== undefined && { description: tool.function.description }),
      input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
    }))
  }
  const choice = params.tool_choice
  if (choice === 'auto') body.tool_choice = { type: 'auto' }
  else if (choice === 'required') body.tool_choice = { type: 'any' }
  else if (choice === 'none') body.tool_choice = { type: 'none' }
  else if (typeof choice === 'object')
    body.tool_choice = { type: 'tool', name: choice.function.name }
  return body
}

function toBlocks(message: ChatCompletionMessageParam): Block[] {
  if (message.role === 'tool') {
    return [
      { type: 'tool_result', tool_use_id: message.tool_call_id, content: textOf(message.content) },
    ]
  }
  if (message.role === 'assistant') {
    const blocks: Block[] = []
    const text = message.content == null ? '' : textOf(message.content)
    if (text !== '') blocks.push({ type: 'text', text })
    for (const call of message.tool_calls ?? []) {
      blocks.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: parseArguments(call),
      })
    }
    return blocks
  }
  const content = message.content
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  return content.map(toContentBlock)
}

function toContentBlock(part: ChatCompletionContentPart): Block {
  if (part.type === 'text') return { type: 'text', text: part.text }
  const url = part.image_url.url
  const match = /^data:([^;]+);base64,(.*)$/s.exec(url)
  if (match)
    return {
      type: 'image',
      source: { type: 'base64', media_type: match[1] ?? '', data: match[2] ?? '' },
    }
  return { type: 'image', source: { type: 'url', url } }
}

function textOf(content: string | Array<{ type: 'text'; text: string }>): string {
  return typeof content === 'string' ? content : content.map((part) => part.text).join('')
}

function parseArguments(call: ChatCompletionMessageToolCall): unknown {
  try {
    return JSON.parse(call.function.arguments)
  } catch (error) {
    throw new MoraqConfigError(
      `Tool call ${call.id} has arguments that are not valid JSON, so anthropic cannot accept it`,
      { cause: error },
    )
  }
}

function finishReason(
  stopReason: string | null,
  jsonMode: boolean,
): ChatCompletionFinishReason | null {
  switch (stopReason) {
    case null:
      return null
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return jsonMode ? 'stop' : 'tool_calls'
    case 'refusal':
      return 'content_filter'
    default:
      return 'stop'
  }
}

function toUsage(usage: AnthropicUsage): CompletionUsage {
  const cached = usage.cache_read_input_tokens ?? 0
  const prompt = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + cached
  const completion = usage.output_tokens ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(cached > 0 && { prompt_tokens_details: { cached_tokens: cached } }),
  }
}

function errorObject(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const error = (body as { error?: unknown }).error
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)
    : undefined
}

/** The fields moraq reads from Anthropic stream events. Every event type uses a subset. */
interface StreamEvent {
  type?: string
  index?: number
  message?: { id?: string; model?: string; usage?: AnthropicUsage }
  content_block?: { type?: string; text?: string; id?: string; name?: string }
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null }
  usage?: AnthropicUsage
  error?: { type?: string; message?: string }
}

function streamErrorKind(type: unknown): ProviderErrorKind {
  if (type === 'overloaded_error') return 'overloaded'
  if (type === 'rate_limit_error') return 'rate_limit'
  if (type === 'api_error') return 'server'
  return 'unknown'
}

/**
 * Anthropic streams typed events (message_start, content_block_delta, ...). This turns them into
 * OpenAI chunks, keeping track of which content block is which tool call.
 */
async function* streamChunks(
  events: AsyncIterable<SSEEvent>,
  jsonMode: boolean,
): AsyncGenerator<ChatCompletionChunk> {
  let id = ''
  let model = ''
  const created = Math.floor(Date.now() / 1000)
  let usage: AnthropicUsage = {}
  let toolCount = 0
  // Content block index -> OpenAI tool_calls index.
  const toolIndex = new Map<number, number>()

  const chunk = (
    delta: ChatCompletionChunkDelta,
    finish: ChatCompletionFinishReason | null = null,
  ): ChatCompletionChunk => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })

  for await (const event of events) {
    let data: StreamEvent
    try {
      data = JSON.parse(event.data)
    } catch (error) {
      throw new MoraqProviderError('anthropic sent a stream event that is not JSON', {
        kind: 'unknown',
        provider: 'anthropic',
        body: event.data,
        cause: error,
      })
    }

    switch (data.type) {
      case 'message_start':
        id = data.message?.id ?? ''
        model = data.message?.model ?? ''
        usage = { ...data.message?.usage }
        yield chunk({ role: 'assistant', content: '' })
        break
      case 'content_block_start': {
        const block = data.content_block
        if (block?.type === 'text' && block.text) yield chunk({ content: block.text })
        if (block?.type === 'tool_use' && !jsonMode) {
          const index = toolCount++
          toolIndex.set(data.index ?? -1, index)
          yield chunk({
            tool_calls: [
              {
                index,
                id: block.id ?? '',
                type: 'function',
                function: { name: block.name ?? '', arguments: '' },
              },
            ],
          })
        }
        break
      }
      case 'content_block_delta': {
        const delta = data.delta
        if (delta?.type === 'text_delta') yield chunk({ content: delta.text ?? '' })
        if (delta?.type === 'input_json_delta') {
          const json = delta.partial_json ?? ''
          const index = toolIndex.get(data.index ?? -1)
          if (jsonMode) yield chunk({ content: json })
          else if (index !== undefined) {
            yield chunk({ tool_calls: [{ index, function: { arguments: json } }] })
          }
        }
        break
      }
      case 'message_delta':
        usage = { ...usage, ...data.usage }
        yield chunk({}, finishReason(data.delta?.stop_reason ?? null, jsonMode))
        break
      case 'message_stop':
        yield {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage: toUsage(usage),
        }
        return
      case 'error':
        throw new MoraqProviderError('anthropic sent an error in the stream', {
          kind: streamErrorKind(data.error?.type),
          provider: 'anthropic',
          body: data,
        })
    }
  }
  throw new MoraqProviderError('anthropic stream ended before message_stop', {
    kind: 'network',
    provider: 'anthropic',
  })
}
