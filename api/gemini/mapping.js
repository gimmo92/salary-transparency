import { completeText, extractJson, getAnthropicApiKey } from '../lib/claude.js'

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

    const sampleRows = (rows || []).slice(0, 5)
    const prompt = `You are a data analyst. Given the following spreadsheet column headers and sample rows, map each header to the most appropriate role for a salary transparency analysis.

Available roles (use these exact keys):
- gender: Gender column (M/F values)
- employeeName: Employee name
- baseSalary: Base annual salary
- variableComponents: Variable compensation (bonus, etc.)
- totalSalary: Total annual compensation
- category: Job category / classification
- role: Job title / position
- level: Level / grade (CCNL)
- description: Job description
- seniority: Seniority / years of service / hire date (for documented pay justification)

Column headers: ${JSON.stringify(headers)}
Sample data rows: ${JSON.stringify(sampleRows)}

Return ONLY a JSON object mapping role keys to column indices (0-based). Only include roles you are confident about. Example: {"gender": 0, "baseSalary": 3, "role": 5}

JSON:`

    const text = await completeText(apiKey, prompt, { maxTokens: 1024 })
    const mapping = extractJson(text)

    return res.status(200).json(mapping)
  } catch (err) {
    console.error('Claude mapping error:', err)
    const msg = err.message || 'Column mapping failed'
    if (msg.startsWith('Claude API error')) return res.status(502).json({ error: msg })
    return res.status(500).json({ error: msg })
  }
}
