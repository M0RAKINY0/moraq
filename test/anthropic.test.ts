import { expect, it } from 'vitest'
import { type ChatCompletionChunk, createMoraq } from '../src/index.js'
import { fakeFetch, fixture } from './helpers/fake-fetch.js'

const weatherTool = {
  type: 'function' as const,
  function: {
    name: 'get_weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  },
}

it('translates an OpenAI request to Anthropic and the reply back', async () => {
  const fetch = fakeFetch({ body: JSON.parse(fixture('anthropic/message-tool-use.json')) })
  const ai = createMoraq({ providers: { anthropic: { apiKey: 'sk-ant-test' } }, fetch })

  const res = await ai.chat.completions.create({
    model: 'anthropic/claude-haiku-4-5',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Weather in Abuja?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'toolu_00',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Abuja"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_00', content: '31C' },
      { role: 'user', content: 'And Lagos?' },
    ],
    tools: [weatherTool],
    tool_choice: 'required',
    temperature: 1.5,
    seed: 7,
  })

  const call = fetch.calls[0]
  expect(call?.url).toBe('https://api.anthropic.com/v1/messages')
  expect(call?.headers['x-api-key']).toBe('sk-ant-test')
  expect(call?.headers['anthropic-version']).toBe('2023-06-01')
  expect(call?.body).toEqual({
    model: 'claude-haiku-4-5',
    max_tokens: 4096,
    system: [{ type: 'text', text: 'Be brief.' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Weather in Abuja?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_00', name: 'get_weather', input: { city: 'Abuja' } },
        ],
      },
      {
        // The tool result and the next user message merge into one user turn.
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_00', content: '31C' },
          { type: 'text', text: 'And Lagos?' },
        ],
      },
    ],
    temperature: 1,
    tools: [
      {
        name: 'get_weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ],
    tool_choice: { type: 'any' },
  })

  expect(res.moraq.provider).toBe('anthropic')
  expect(res.choices[0]).toEqual({
    index: 0,
    message: {
      role: 'assistant',
      content: 'Checking the weather.',
      tool_calls: [
        {
          id: 'toolu_01',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Lagos"}' },
        },
      ],
    },
    finish_reason: 'tool_calls',
  })
  expect(res.usage).toEqual({
    prompt_tokens: 25,
    completion_tokens: 10,
    total_tokens: 35,
    prompt_tokens_details: { cached_tokens: 5 },
  })
})

it('turns an Anthropic stream with a tool call into OpenAI chunks', async () => {
  const fetch = fakeFetch({ chunks: [fixture('anthropic/stream-tool-use.sse')] })
  const ai = createMoraq({ providers: { anthropic: { apiKey: 'sk-ant-test' } }, fetch })

  const stream = await ai.chat.completions.create({
    model: 'anthropic/claude-haiku-4-5',
    messages: [{ role: 'user', content: 'Weather in Lagos?' }],
    tools: [weatherTool],
    stream: true,
  })
  const chunks: ChatCompletionChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)

  const deltas = chunks.flatMap((c) => c.choices.map((choice) => choice.delta))
  expect(deltas.map((d) => d.content ?? '').join('')).toBe('Let me check.')
  const toolDeltas = deltas.flatMap((d) => d.tool_calls ?? [])
  expect(toolDeltas[0]).toMatchObject({
    index: 0,
    id: 'toolu_02',
    function: { name: 'get_weather' },
  })
  expect(toolDeltas.map((t) => t.function?.arguments ?? '').join('')).toBe('{"city": "Lagos"}')
  expect(chunks.at(-2)?.choices[0]?.finish_reason).toBe('tool_calls')
  expect(chunks.at(-1)?.usage).toEqual({
    prompt_tokens: 20,
    completion_tokens: 15,
    total_tokens: 35,
  })
})

it('emulates response_format json_schema with a forced tool call', async () => {
  const fetch = fakeFetch({
    body: {
      id: 'msg_03',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [
        { type: 'tool_use', id: 'toolu_03', name: 'moraq_json_output', input: { answer: 42 } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  })
  const ai = createMoraq({ providers: { anthropic: { apiKey: 'sk-ant-test' } }, fetch })
  const schema = { type: 'object', properties: { answer: { type: 'number' } } }

  const res = await ai.chat.completions.create({
    model: 'anthropic/claude-haiku-4-5',
    messages: [{ role: 'user', content: 'What is 6 times 7?' }],
    response_format: { type: 'json_schema', json_schema: { name: 'result', schema } },
  })

  expect(fetch.calls[0]?.body).toMatchObject({
    tools: [{ name: 'moraq_json_output', input_schema: schema }],
    tool_choice: { type: 'tool', name: 'moraq_json_output' },
  })
  expect(res.choices[0]?.message).toEqual({ role: 'assistant', content: '{"answer":42}' })
  expect(res.choices[0]?.finish_reason).toBe('stop')
})
