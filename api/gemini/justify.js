const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'

function fmt(n) {
  if (n == null || !Number.isFinite(Number(n))) return 'n/d'
  return Number(n).toLocaleString('it-IT', { maximumFractionDigits: 2 })
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(Number(n))) return 'n/d'
  return `${Number(n).toFixed(2)}%`
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
    const b = req.body || {}
    const {
      role,
      level,
      bandId,
      bandRangeLabel,
      employeeName,
      gender,
      personTotalSalary,
      avgFasciaSalary,
      personDeviationFromFasciaPct,
      genderGapPct,
      avgSalaryMen,
      avgSalaryWomen,
      nMen,
      nWomen,
      trParametricScore100,
      trWeightedScore,
      seniorityPctVsFascia,
      performancePctVsFascia,
    } = b

    const prompt = `Sei un consulente del lavoro e HR. Devi scrivere un testo breve di GIUSTIFICATIVO (report interno / documentazione trasparenza retributiva, riferimento Direttiva UE 2023/970 e principi di non discriminazione).

CONTESTO (stessa fascia di job grading: stesso punteggio parametrico / stesso bucket retributivo atteso):
- Ruolo: ${role || 'N/D'}
- Livello CCNL: ${level || 'N/D'}
- Fascia: ${bandId || 'N/D'} — ${bandRangeLabel || 'N/D'}
- Punteggio parametrico ruolo (0–100): ${trParametricScore100 != null ? fmt(trParametricScore100) : 'n/d'}
- Media pesata fattori (1–5): ${trWeightedScore != null ? fmt(trWeightedScore) : 'n/d'}

DIPENDENTE PER CUI SI REDIGE IL GIUSTIFICATIVO:
- Nome o etichetta: ${employeeName || 'N/D'}
- Genere (M/F): ${gender || 'N/D'}
- Retribuzione totale del dipendente: € ${fmt(personTotalSalary)} (questo è il reddito del singolo, NON la media di fascia)

DATI DELLA FASCIA (tutti i ruoli con lo stesso punteggio nella stessa analisi):
- Retribuzione media complessiva della fascia: € ${fmt(avgFasciaSalary)}
- Scostamento % del dipendente rispetto alla media della fascia: ${fmtPct(personDeviationFromFasciaPct)} (positivo = sopra media, negativo = sotto media)
- Numero uomini nella fascia: ${nMen ?? 'n/d'}, numero donne: ${nWomen ?? 'n/d'}
- Media retribuzione uomini nella fascia: € ${fmt(avgSalaryMen)}
- Media retribuzione donne nella fascia: € ${fmt(avgSalaryWomen)}
- Gap retributivo M/F nella fascia (stima da medie: (media M − media F) / media M × 100): ${fmtPct(genderGapPct)}

ELEMENTI OPZIONALI (se disponibili, puoi citarli solo se coerenti):
- Scostamento anzianità vs media fascia: ${seniorityPctVsFascia != null ? fmtPct(seniorityPctVsFascia) : 'n/d'}
- Scostamento performance vs media fascia: ${performancePctVsFascia != null ? fmtPct(performancePctVsFascia) : 'n/d'}

ISTRUZIONI DI SCRITTURA (OBBLIGATORIE):
1) Scrivi in ITALIANO, tono professionale e neutro.
2) Tra 3 e 5 frasi COMPLETE: ogni frase deve finire con un punto fermo. Non interrompere a metà parola o a metà frase.
3) Spiega in modo chiaro il contesto del gap di genere nella fascia (medie M vs F) e, se utile, la posizione del dipendente rispetto alla media della fascia. NON scrivere che la "mediana di banda" sia la retribuzione del dipendente: sono concetti diversi.
4) Non inventare cifre: usa solo i dati sopra o formulazioni generiche ("ove applicabile").
5) Non usare elenchi puntati; solo paragrafo di testo continuo.
6) Non aggiungere titoli, prefissi tipo "Ecco il testo:" o conclusioni tipo "Spero sia utile". Solo il testo del giustificativo.

Rispondi ESCLUSIVAMENTE con il paragrafo del giustificativo, nient'altro.`

    const geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.25,
          maxOutputTokens: 1200,
          topP: 0.9,
        },
      }),
    })

    if (!geminiRes.ok) {
      const errBody = await geminiRes.text()
      return res.status(502).json({ error: `Gemini API error ${geminiRes.status}: ${errBody.slice(0, 300)}` })
    }

    const data = await geminiRes.json()
    const cand = data.candidates?.[0]
    const text = cand?.content?.parts?.[0]?.text || ''
    const finish = cand?.finishReason

    let out = String(text).trim()
    if (finish === 'MAX_TOKENS' && out.length > 0 && !/[.!?]\s*$/.test(out)) {
      const lastPeriod = Math.max(out.lastIndexOf('.'), out.lastIndexOf('!'), out.lastIndexOf('?'))
      if (lastPeriod > 40) {
        out = out.slice(0, lastPeriod + 1).trim()
      }
    }

    return res.status(200).json({ suggestion: out })
  } catch (err) {
    console.error('Gemini justify error:', err)
    return res.status(500).json({ error: err.message || 'Gemini justify failed' })
  }
}
