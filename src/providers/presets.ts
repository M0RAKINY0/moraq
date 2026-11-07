export interface OpenAICompatiblePreset {
  baseURL: string
  /** Where the key comes from when config has none. Undefined means the server needs no key. */
  envVar?: string
  streamUsage?: boolean
}

export type OpenAICompatibleProvider =
  | 'openai'
  | 'xai'
  | 'gemini'
  | 'deepseek'
  | 'mistral'
  | 'groq'
  | 'together'
  | 'openrouter'
  | 'ollama'

/** Providers that speak the OpenAI Chat Completions API, so the OpenAI adapter handles them. */
export const OPENAI_COMPATIBLE_PRESETS: Record<OpenAICompatibleProvider, OpenAICompatiblePreset> = {
  openai: { baseURL: 'https://api.openai.com/v1', envVar: 'OPENAI_API_KEY' },
  xai: { baseURL: 'https://api.x.ai/v1', envVar: 'XAI_API_KEY' },
  // Google's official OpenAI-compatible endpoint for Gemini.
  gemini: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envVar: 'GEMINI_API_KEY',
  },
  deepseek: { baseURL: 'https://api.deepseek.com/v1', envVar: 'DEEPSEEK_API_KEY' },
  // Mistral's API has no stream_options field. It sends usage in the last stream chunk anyway.
  mistral: { baseURL: 'https://api.mistral.ai/v1', envVar: 'MISTRAL_API_KEY', streamUsage: false },
  groq: { baseURL: 'https://api.groq.com/openai/v1', envVar: 'GROQ_API_KEY' },
  together: { baseURL: 'https://api.together.xyz/v1', envVar: 'TOGETHER_API_KEY' },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', envVar: 'OPENROUTER_API_KEY' },
  ollama: { baseURL: 'http://localhost:11434/v1' },
}
