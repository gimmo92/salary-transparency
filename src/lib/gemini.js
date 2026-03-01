import { COLUMN_ROLES } from './excel.js'

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'

/**
 * Chiama l'API Google Gemini per suggerire il mapping colonne -> ruoli.
 * @param {string} apiKey - API key Google AI (Gemini)
 * @param {string[]} headers - Nomi delle colonne del foglio
 * @param {object[]} sampleRows - Prime righe (array di oggetti header -> valore)
 * @returns {Promise<{ [role]: number } | null>} Mapping ruolo -> indice colonna (0-based), o null se errore
 */
export async function suggestColumnMappingWithGemini(apiKey, headers, sampleRows) {
  if (!apiKey || !headers?.length) return null

  const sample = sampleRows.slice(0, 15).map((r) => {
    const row = {}
    headers.forEach((h) => { row[h] = r[h] != null ? String(r[h]).slice(0, 80) : '' })
    return row
  })

  const roleList = [
    COLUMN_ROLES.gender,
    COLUMN_ROLES.baseSalary,
    COLUMN_ROLES.variableComponents,
    COLUMN_ROLES.totalSalary,
    COLUMN_ROLES.category,
  ].join(', ')

  const prompt = `Sei un assistente per l'analisi di dati retributivi. Data la tabella sotto (intestazioni e un campione di righe), indica quale colonna corrisponde a ciascun ruolo.

RUOLI richiesti (usa ESATTAMENTE questi identificatori): ${roleList}

REGOLE:
- genere: colonna con sesso/genere (valori come M, F, Maschio, Femmina, ecc.)
- retribuzione_base: stipendio o retribuzione di base (solo numeri)
- componenti_variabili: bonus, premi, incentivi, straordinari (solo numeri)
- retribuzione_totale: retribuzione complessiva (solo numeri)
- categoria_lavoratore: ruolo, livello, qualifica, area (testo)

Rispondi SOLO con un JSON valido, senza altro testo prima o dopo. Formato:
{ "nome_colonna_esatto": "ruolo", ... }
Usa i nomi delle colonne esattamente come compaiono nella tabella. Se una colonna non corrisponde a nessun ruolo, non includerla.

Intestazioni: ${JSON.stringify(headers)}

Campione righe (prime 15):
${JSON.stringify(sample, null, 0)}
`

  try {
    const res = await fetch(`${GEMINI_API}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1024,
          responseMimeType: 'application/json',
        },
      }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const msg = err.error?.message || err.error?.status || `API ${res.status}`
      throw new Error(msg)
    }

    const data = await res.json()
    let text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) throw new Error('Risposta Gemini senza testo')
    text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    const raw = JSON.parse(text)
    const mapping = {}
    const headerToIndex = Object.fromEntries(headers.map((h, i) => [h, i]))
    const norm = (s) => String(s).toLowerCase().trim()

    for (const [columnName, role] of Object.entries(raw)) {
      if (!roleList.includes(role)) continue
      let idx = headerToIndex[columnName]
      if (idx == null)
        idx = headers.findIndex((h) => norm(h) === norm(columnName))
      if (typeof idx === 'number' && idx >= 0) mapping[role] = idx
    }

    return Object.keys(mapping).length ? mapping : null
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error('Risposta Gemini non valida (JSON)')
    throw e
  }
}
