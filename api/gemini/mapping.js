const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'

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
- level: Level / seniority / grade
- description: Job description

Column headers: ${JSON.stringify(headers)}
Sample data rows: ${JSON.stringify(sampleRows)}

Return ONLY a JSON object mapping role keys to column indices (0-based). Only include roles you are confident about. Example: {"gender": 0, "baseSalary": 3, "role": 5}

JSON:`

    const geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 },
      }),
    })

    if (!geminiRes.ok) {
      const errBody = await geminiRes.text()
      return res.status(502).json({ error: `Gemini API error ${geminiRes.status}: ${errBody.slice(0, 300)}` })
    }

    const data = await geminiRes.json()
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
    const cleaned = text.replace(/```json\s*/g, '').replace(/```/g, '').trim()
    const mapping = JSON.parse(cleaned)

    return res.status(200).json(mapping)
  } catch (err) {
    console.error('Gemini mapping error:', err)
    return res.status(500).json({ error: err.message || 'Gemini mapping failed' })
  }
}
