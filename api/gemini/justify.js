const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'

function fmt(n) {
  if (n == null || !Number.isFinite(Number(n))) return 'n/d'
  return Number(n).toLocaleString('it-IT', { maximumFractionDigits: 2 })
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(Number(n))) return 'n/d'
  return `${Number(n).toFixed(2)}%`
}

function parseSuggestionOptions(rawText) {
  const txt = String(rawText || '').trim()
  if (!txt) return []
  const fenceJson = txt.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenceJson?.[1] || txt).trim()
  try {
    const parsed = JSON.parse(candidate)
    if (Array.isArray(parsed)) return parsed.map((s) => String(s || '').trim()).filter(Boolean)
    if (Array.isArray(parsed?.suggestions)) return parsed.suggestions.map((s) => String(s || '').trim()).filter(Boolean)
  } catch {}
  const suggestionsArrayMatch = candidate.match(/"suggestions"\s*:\s*\[(?<arr>[\s\S]*?)\]/i)
  if (suggestionsArrayMatch?.groups?.arr) {
    const arrRaw = `[${suggestionsArrayMatch.groups.arr}]`
    try {
      const arr = JSON.parse(arrRaw)
      if (Array.isArray(arr)) return arr.map((s) => String(s || '').trim()).filter(Boolean)
    } catch {}
  }
  return txt
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .split(/\n{2,}|(?:^|\n)\s*(?:Opzione|Option)\s*\d+\s*[:.)-]?\s*/i)
    .map((s) => s.replace(/^\s*[-*]\s*/, '').trim())
    .filter((s) => s.length > 20 && !/^\{?\s*"suggestions"\s*:/i.test(s))
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
      personBaseSalary,
      personVariableComponents,
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
      benchmarkN,
      benchmarkMedian,
      benchmarkQ1,
      benchmarkQ3,
      optionsCount,
    } = b

    const nOptions = Math.min(5, Math.max(2, Number(optionsCount) || 3))

    const prompt = `Sei un consulente del lavoro e HR. Devi proporre possibili GIUSTIFICATIVI (report interno / documentazione trasparenza retributiva, riferimento Direttiva UE 2023/970 e principi di non discriminazione).

CONTESTO (stessa fascia di job grading: stesso punteggio parametrico / stesso bucket retributivo atteso):
- Ruolo: ${role || 'N/D'}
- Livello CCNL: ${level || 'N/D'}
- Fascia: ${bandId || 'N/D'} — ${bandRangeLabel || 'N/D'}
- Punteggio parametrico ruolo (0–100): ${trParametricScore100 != null ? fmt(trParametricScore100) : 'n/d'}
- Media pesata fattori (1–5): ${trWeightedScore != null ? fmt(trWeightedScore) : 'n/d'}

DIPENDENTE PER CUI SI REDIGE IL GIUSTIFICATIVO:
- Nome o etichetta: ${employeeName || 'N/D'}
- Genere (M/F): ${gender || 'N/D'}
- Retribuzione base: € ${fmt(personBaseSalary)}
- Variabile: € ${fmt(personVariableComponents)}
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
- Benchmark esterno annunci (se presente): n=${benchmarkN ?? 'n/d'}, mediana € ${fmt(benchmarkMedian)}, Q1 € ${fmt(benchmarkQ1)}, Q3 € ${fmt(benchmarkQ3)}

ISTRUZIONI DI SCRITTURA (OBBLIGATORIE):
1) Scrivi in ITALIANO, tono professionale e neutro.
2) Genera ${nOptions} OPZIONI ALTERNATIVE, ciascuna composta da 3-5 frasi complete.
3) Ogni opzione deve evidenziare un taglio diverso (es. focus performance, focus anzianità, focus mercato/benchmark).
4) Spiega il contesto del gap di genere nella fascia (medie M vs F) e, quando utile, la posizione del dipendente rispetto alla media.
5) Non inventare cifre: usa solo i dati sopra o formulazioni prudenti ("ove applicabile").
6) Non usare formule discriminatorie o causali sensibili non documentate.
7) Rispondi SOLO con JSON valido nel formato:
{"suggestions":["opzione 1","opzione 2","opzione 3"]}
Nessun testo extra fuori dal JSON.`

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
      if (lastPeriod > 40) out = out.slice(0, lastPeriod + 1).trim()
    }
    let suggestions = parseSuggestionOptions(out).slice(0, nOptions)
    if (!suggestions.length && out) suggestions = [out]
    return res.status(200).json({
      suggestion: suggestions[0] || '',
      suggestions,
    })
  } catch (err) {
    console.error('Gemini justify error:', err)
    return res.status(500).json({ error: err.message || 'Gemini justify failed' })
  }
}
