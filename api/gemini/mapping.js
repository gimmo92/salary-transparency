import { completeText, extractJson, getAnthropicApiKey } from '../lib/claude.js'
import {
  buildMappingPrompt,
  detectColumnRoles,
  mergeColumnMappings,
} from '../../src/lib/column-mapping.js'

const MAPPING_MODEL = process.env.CLAUDE_MODEL_MAPPING || 'claude-sonnet-4-6'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = getAnthropicApiKey()
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server.' })
  }

  try {
    const { headers, rows } = req.body || {}
    if (!headers || !headers.length) {
      return res.status(400).json({ error: 'Missing headers' })
    }

    const heuristic = detectColumnRoles(headers, rows)
    const prompt = buildMappingPrompt(headers, rows)

    const text = await completeText(apiKey, prompt, {
      maxTokens: 1536,
      temperature: 0,
      model: MAPPING_MODEL,
    })
    const aiMapping = extractJson(text)
    const mapping = mergeColumnMappings(heuristic, aiMapping, headers)

    return res.status(200).json(mapping)
  } catch (err) {
    console.error('Claude mapping error:', err)
    const msg = err.message || 'Column mapping failed'
    if (msg.startsWith('Claude API error')) return res.status(502).json({ error: msg })
    return res.status(500).json({ error: msg })
  }
}
