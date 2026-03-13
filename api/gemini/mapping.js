import { getModel, jsonResponse, errorResponse, askGeminiJson } from '../_shared.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const { headers, rows } = req.body
    if (!headers?.length) {
      res.status(400).json({ error: 'Missing headers' })
      return
    }

    const model = getModel()
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

    const mapping = await askGeminiJson(model, prompt)
    res.status(200).json(mapping)
  } catch (err) {
    console.error('Gemini mapping error:', err)
    res.status(500).json({ error: err.message || 'Gemini mapping failed' })
  }
}
