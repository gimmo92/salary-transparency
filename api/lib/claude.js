const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
export const CLAUDE_MODEL = 'claude-3-5-haiku-20241022'

export function getAnthropicApiKey() {
  return process.env.ANTHROPIC_API_KEY
}

export function extractJson(text) {
  const cleaned = String(text || '').replace(/```json\s*/gi, '').replace(/```/g, '').replace(/^\uFEFF/, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {}

  const starts = []
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '{' || cleaned[i] === '[') starts.push(i)
  }

  for (const start of starts) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{' || ch === '[') depth++
      if (ch === '}' || ch === ']') depth--
      if (depth === 0) {
        const candidate = cleaned.slice(start, i + 1)
        try {
          return JSON.parse(candidate)
        } catch {}
      }
    }
  }

  throw new Error(`Could not parse JSON from Claude response: ${cleaned.slice(0, 220)}`)
}

/**
 * @param {string} apiKey
 * @param {string} prompt
 * @param {{ maxTokens?: number, temperature?: number, model?: string }} [options]
 */
export async function completeText(apiKey, prompt, options = {}) {
  const { maxTokens = 4096, temperature = 0.1, model = CLAUDE_MODEL } = options

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`Claude API error ${res.status}: ${errBody.slice(0, 300)}`)
  }

  const data = await res.json()
  const blocks = data.content || []
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}
