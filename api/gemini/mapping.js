import { GoogleGenerativeAI } from '@google/generative-ai'

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

    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })
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

    const result = await model.generateContent(prompt)
    const text = result.response.text()
    const cleaned = text.replace(/```json\s*/g, '').replace(/```/g, '').trim()
    const mapping = JSON.parse(cleaned)

    return res.status(200).json(mapping)
  } catch (err) {
    console.error('Gemini mapping error:', err)
    return res.status(500).json({ error: err.message || 'Gemini mapping failed' })
  }
}
