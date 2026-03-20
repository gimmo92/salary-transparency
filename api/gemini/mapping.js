const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'

function extractJson(text) {
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

  throw new Error(`Could not parse JSON from Gemini response: ${cleaned.slice(0, 220)}`)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.GOOGLE_AI_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'GOOGLE_AI_API_KEY not configured on server.' })
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

    const geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
      }),
    })

    if (!geminiRes.ok) {
      const errBody = await geminiRes.text()
      return res.status(502).json({ error: `Gemini API error ${geminiRes.status}: ${errBody.slice(0, 300)}` })
    }

    const data = await geminiRes.json()
    const parts = data.candidates?.[0]?.content?.parts || []
    const text = parts.map((p) => p?.text || '').join('\n').trim()
    const mapping = extractJson(text)

    return res.status(200).json(mapping)
  } catch (err) {
    console.error('Gemini mapping error:', err)
    return res.status(500).json({ error: err.message || 'Gemini mapping failed' })
  }
}
