const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.GOOGLE_AI_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'GOOGLE_AI_API_KEY not configured on server.' })
  }

  try {
    const { role, level, band, totalScore, medianSalary, deviation, jobFamily, nEmployees } = req.body || {}

    const prompt = `Sei un consulente HR esperto in politiche retributive e trasparenza salariale (D.Lgs. 198/2006, Direttiva UE 2023/970).

Devi suggerire un giustificativo professionale per la deviazione retributiva di un ruolo rispetto alla mediana della sua banda di appartenenza.

Dati del ruolo:
- Ruolo: ${role || 'N/D'}
- Livello contrattuale CCNL: ${level || 'N/D'}
- Job Family: ${jobFamily || 'General'}
- Banda di appartenenza: ${band}
- Punteggio totale: ${totalScore}
- Retribuzione mediana di banda: €${medianSalary}
- Deviazione dalla mediana: ${deviation}%
- Numero dipendenti nel ruolo: ${nEmployees}

Scrivi un giustificativo conciso (3-5 frasi) in italiano che spieghi la ragione della deviazione retributiva, citando fattori oggettivi come:
- Scarsità del profilo sul mercato del lavoro
- Competenze specialistiche richieste
- Livello contrattuale e minimi tabellari CCNL
- Anzianità media nel ruolo
- Responsabilità aggiuntive non catturate dal job grading
- Condizioni di mercato per la job family

Il tono deve essere professionale, adatto a un report di compliance.
Rispondi SOLO con il testo del giustificativo, senza premesse o formattazione.`

    const geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 300 },
      }),
    })

    if (!geminiRes.ok) {
      const errBody = await geminiRes.text()
      return res.status(502).json({ error: `Gemini API error ${geminiRes.status}: ${errBody.slice(0, 300)}` })
    }

    const data = await geminiRes.json()
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''

    return res.status(200).json({ suggestion: text.trim() })
  } catch (err) {
    console.error('Gemini justify error:', err)
    return res.status(500).json({ error: err.message || 'Gemini justify failed' })
  }
}
