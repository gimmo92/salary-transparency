const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'

function extractJson(text) {
  const cleaned = text.replace(/```json\s*/g, '').replace(/```/g, '').trim()
  try { return JSON.parse(cleaned) } catch {}
  const start = cleaned.search(/[\[{]/)
  const end = Math.max(cleaned.lastIndexOf(']'), cleaned.lastIndexOf('}'))
  if (start !== -1 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)) } catch {}
  }
  throw new Error('Could not parse JSON from Gemini response')
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
    const { normalizedData } = req.body || {}
    if (!normalizedData || !normalizedData.length) {
      return res.status(400).json({ error: 'Missing normalizedData' })
    }

    const prompt = `You are an expert in EU pay transparency regulations. Analyze the following employee salary data and compute gender pay gap indicators.

Each employee object has: gender (M/F), baseSalary, variableComponents, totalSalary, category.

Data (JSON): ${JSON.stringify(normalizedData.slice(0, 200))}

Compute and return a JSON object with EXACTLY this structure:
{
  "a_divarioRetributivoGenere": {
    "descrizione": "Divario retributivo medio complessivo tra uomini e donne.",
    "percentuale": <number: (meanMale - meanFemale) / meanMale * 100 on totalSalary>,
    "mediaMaschile": <number>,
    "mediaFemminile": <number>,
    "nMaschi": <int>,
    "nFemmine": <int>
  },
  "b_divarioComponentiVariabili": {
    "descrizione": "Divario medio sulle componenti variabili della retribuzione.",
    "percentuale": <number>,
    "mediaMaschile": <number>,
    "mediaFemminile": <number>
  },
  "c_divarioMedianoGenere": {
    "descrizione": "Divario mediano complessivo tra uomini e donne.",
    "percentuale": <number: on totalSalary medians>,
    "medianaMaschile": <number>,
    "medianaFemminile": <number>
  },
  "d_divarioMedianoComponentiVariabili": {
    "descrizione": "Divario mediano sulle componenti variabili.",
    "percentuale": <number>,
    "medianaMaschile": <number>,
    "medianaFemminile": <number>
  },
  "e_percentualeConComponentiVariabili": {
    "descrizione": "Quota di lavoratori che percepiscono componenti variabili.",
    "femminile": <number: % of females with variableComponents > 0>,
    "maschile": <number: % of males with variableComponents > 0>,
    "nFemmine": <int>,
    "nMaschi": <int>
  },
  "f_percentualePerQuartile": {
    "descrizione": "Distribuzione di uomini e donne per quartile retributivo.",
    "quartili": [
      {"quartile": 1, "femminile": <% of total>, "maschile": <% of total>, "totale": <count>},
      {"quartile": 2, ...},
      {"quartile": 3, ...},
      {"quartile": 4, ...}
    ]
  },
  "g_divarioPerCategoria": {
    "descrizione": "Divario retributivo per categoria/inquadramento.",
    "perCategoria": [
      {"categoria": "<name>", "n": <int>, "divarioBase": <number>, "divarioVariabile": <number>}
    ]
  },
  "h_divarioRetribuzioneBase": {
    "descrizione": "Divario retributivo di genere sulla retribuzione base.",
    "percentuale": <number>,
    "mediaMaschile": <number>,
    "mediaFemminile": <number>
  }
}

Gap formula: ((maleMean - femaleMean) / maleMean) * 100. Positive = men earn more.
Return ONLY the JSON, no explanation.

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
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
    const indicators = extractJson(text)

    return res.status(200).json(indicators)
  } catch (err) {
    console.error('Gemini indicators error:', err)
    return res.status(500).json({ error: err.message || 'Gemini indicators failed' })
  }
}
