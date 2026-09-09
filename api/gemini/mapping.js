import { completeText, extractJson, getAnthropicApiKey } from '../lib/claude.js'
import {
  MAPPING_SAMPLE_ROWS,
  buildMappingPrompt,
  detectColumnRoles,
  mergeColumnMappings,
} from '../lib/column-mapping.js'

const MAPPING_MODEL =
  process.env.CLAUDE_MODEL_MAPPING || process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001'

function readBody(req) {
  const raw = req.body
  if (raw == null || raw === '') return {}
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }
  return raw
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = getAnthropicApiKey()
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server.' })
  }

  try {
    const { headers, rows } = readBody(req)
    if (!headers || !headers.length) {
      return res.status(400).json({ error: 'Missing headers' })
    }

    const sampleRows = Array.isArray(rows) ? rows.slice(0, MAPPING_SAMPLE_ROWS) : []
    const heuristic = detectColumnRoles(headers, sampleRows)

    try {
      const prompt = buildMappingPrompt(headers, sampleRows)
      const text = await completeText(apiKey, prompt, {
        maxTokens: 1536,
        temperature: 0,
        model: MAPPING_MODEL,
      })
      const aiMapping = extractJson(text)
      return res.status(200).json(mergeColumnMappings(heuristic, aiMapping, headers))
    } catch (aiErr) {
      console.error('Claude mapping fallback to heuristic:', aiErr)
      return res.status(200).json(heuristic)
    }
  } catch (err) {
    console.error('Claude mapping error:', err)
    const msg = err.message || 'Column mapping failed'
    if (msg.startsWith('Claude API error')) return res.status(502).json({ error: msg })
    return res.status(500).json({ error: msg })
  }
}
