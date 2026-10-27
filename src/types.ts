// Our own copy of the OpenAI Chat Completions shapes we support. We do not depend on the
// `openai` package. `user` is left out on purpose: moraq reserves it for `user: { id, plan }`.

export type ChatCompletionRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool'

export interface ChatCompletionContentPartText {
  type: 'text'
  text: string
}

export interface ChatCompletionContentPartImage {
  type: 'image_url'
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' }
}

export type ChatCompletionContentPart =
  | ChatCompletionContentPartText
  | ChatCompletionContentPartImage

export interface ChatCompletionMessageToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatCompletionSystemMessageParam {
  role: 'system'
  content: string | ChatCompletionContentPartText[]
  name?: string
}

export interface ChatCompletionDeveloperMessageParam {
  role: 'developer'
  content: string | ChatCompletionContentPartText[]
  name?: string
}

export interface ChatCompletionUserMessageParam {
  role: 'user'
  content: string | ChatCompletionContentPart[]
  name?: string
}

export interface ChatCompletionAssistantMessageParam {
  role: 'assistant'
  content?: string | ChatCompletionContentPartText[] | null
  refusal?: string | null
  tool_calls?: ChatCompletionMessageToolCall[]
  name?: string
}

export interface ChatCompletionToolMessageParam {
  role: 'tool'
  content: string | ChatCompletionContentPartText[]
  tool_call_id: string
}

export type ChatCompletionMessageParam =
  | ChatCompletionSystemMessageParam
  | ChatCompletionDeveloperMessageParam
  | ChatCompletionUserMessageParam
  | ChatCompletionAssistantMessageParam
  | ChatCompletionToolMessageParam

export interface ChatCompletionTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
    strict?: boolean | null
  }
}

export type ChatCompletionToolChoiceOption =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } }

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | {
      type: 'json_schema'
      json_schema: {
        name: string
        description?: string
        schema?: Record<string, unknown>
        strict?: boolean | null
      }
    }

export interface ChatCompletionCreateParams {
  model: string
  messages: ChatCompletionMessageParam[]
  tools?: ChatCompletionTool[]
  tool_choice?: ChatCompletionToolChoiceOption
  response_format?: ResponseFormat
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  max_completion_tokens?: number | null
  stop?: string | string[] | null
  seed?: number | null
  frequency_penalty?: number | null
  presence_penalty?: number | null
  stream?: boolean | null
}

export interface ChatCompletionMessage {
  role: 'assistant'
  content: string | null
  refusal?: string | null
  tool_calls?: ChatCompletionMessageToolCall[]
}

export interface ChatCompletionChoice {
  index: number
  message: ChatCompletionMessage
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | null
  logprobs?: unknown
}

export interface CompletionUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens?: number; audio_tokens?: number }
  completion_tokens_details?: {
    reasoning_tokens?: number
    audio_tokens?: number
    accepted_prediction_tokens?: number
    rejected_prediction_tokens?: number
  }
}

export interface ChatCompletion {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: ChatCompletionChoice[]
  usage?: CompletionUsage
  system_fingerprint?: string | null
}

export interface MoraqResponseInfo {
  provider: string
  cached: boolean
  attempts: number
}

export type MoraqChatCompletion = ChatCompletion & { moraq: MoraqResponseInfo }
