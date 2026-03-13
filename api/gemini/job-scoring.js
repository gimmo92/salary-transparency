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
    const { roles } = req.body || {}
    if (!roles || !roles.length) {
      return res.status(400).json({ error: 'Missing roles' })
    }

    const prompt = `You are an HR compensation expert using the Hay method for job evaluation. Score each job role on 4 dimensions (0-100 each):

1. competenze_richieste (Skills required): technical knowledge, certifications, years of experience needed
2. responsabilita (Responsibility): impact on organizational goals, decision scope, autonomy, resource management
3. sforzo_mentale (Mental effort): problem complexity, analysis depth, creativity, strategic thinking
4. condizioni_lavorative (Working conditions): physical environment, professional risks, stress, shifts, travel

Roles to evaluate:
${JSON.stringify(roles.slice(0, 50))}

Return ONLY a JSON array with one object per role:
[
  {
    "role": "<role name, must match input exactly>",
    "competenze_richieste": <0-100>,
    "responsabilita": <0-100>,
    "sforzo_mentale": <0-100>,
    "condizioni_lavorative": <0-100>,
    "totalScore": <sum of 4 scores>
  }
]

Be consistent: similar roles should have similar scores. Senior/management roles should score higher on responsibility. Return ONLY the JSON array.

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
    const scores = JSON.parse(cleaned)

    return res.status(200).json(scores)
  } catch (err) {
    console.error('Gemini job-scoring error:', err)
    return res.status(500).json({ error: err.message || 'Gemini job scoring failed' })
  }
}
