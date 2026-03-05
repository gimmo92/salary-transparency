import { COLUMN_ROLES } from './excel.js'

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
const VALID_ROLES = [
  COLUMN_ROLES.gender,
  COLUMN_ROLES.baseSalary,
  COLUMN_ROLES.variableComponents,
  COLUMN_ROLES.totalSalary,
  COLUMN_ROLES.category,
]
const VALID_ROLE_SET = new Set(VALID_ROLES)

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

  const roleList = VALID_ROLES.join(', ')

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
          maxOutputTokens: 16384,
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
    const raw = parseGeminiJson(text)
    const mapping = {}
    const headerToIndex = Object.fromEntries(headers.map((h, i) => [h, i]))
    const norm = (s) => String(s).toLowerCase().trim()

    for (const [columnName, role] of Object.entries(raw)) {
      if (!VALID_ROLE_SET.has(role)) continue
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

/**
 * Calcola gli indicatori (a)-(g) con Gemini partendo dai dati normalizzati.
 * Restituisce la stessa struttura di computeIndicators() in indicators.js
 */
export async function computeIndicatorsWithGemini(apiKey, normalizedData) {
  if (!apiKey) throw new Error('API key Gemini mancante')
  if (!Array.isArray(normalizedData) || !normalizedData.length)
    throw new Error('Nessun dato disponibile per il calcolo AI')

  const compactRows = normalizedData.map((r) => ({
    gender: r.gender,
    baseSalary: Number(r.baseSalary || 0),
    variableComponents: Number(r.variableComponents || 0),
    totalSalary: Number(r.totalSalary || 0),
    category: String(r.category || 'Non specificata'),
  }))

  const prompt = `Sei un analista retributivo. Calcola ESATTAMENTE gli indicatori richiesti sul dataset fornito.

Dataset (JSON array):
${JSON.stringify(compactRows)}

Definizioni:
- Gruppo femminile: gender = "F"
- Gruppo maschile: gender = "M"
- Se totalSalary manca usa baseSalary + variableComponents (nel dataset è già valorizzato)
- Divario % = ((valoreMaschile - valoreFemminile) / valoreMaschile) * 100
- Quartili: ordina per totalSalary crescente e dividi in 4 gruppi con logica ceil(n/4), come:
  Q1 = primi ceil(n/4), Q2 = successivi, Q3 = successivi, Q4 = restanti

Restituisci SOLO JSON valido con questa struttura ESATTA (stesse chiavi):
{
  "a_divarioRetributivoGenere": { "descrizione": "...", "percentuale": 0, "mediaMaschile": 0, "mediaFemminile": 0, "nMaschi": 0, "nFemmine": 0 },
  "b_divarioComponentiVariabili": { "descrizione": "...", "percentuale": 0, "mediaMaschile": 0, "mediaFemminile": 0 },
  "c_divarioMedianoGenere": { "descrizione": "...", "percentuale": 0, "medianaMaschile": 0, "medianaFemminile": 0 },
  "d_divarioMedianoComponentiVariabili": { "descrizione": "...", "percentuale": 0, "medianaMaschile": 0, "medianaFemminile": 0 },
  "e_percentualeConComponentiVariabili": { "descrizione": "...", "femminile": 0, "maschile": 0, "nFemmine": 0, "nMaschi": 0 },
  "f_percentualePerQuartile": { "descrizione": "...", "quartili": [ { "quartile": 1, "femminile": 0, "maschile": 0, "totale": 0 } ] },
  "g_divarioPerCategoria": { "descrizione": "...", "perCategoria": [ { "categoria": "...", "n": 0, "divarioBase": 0, "divarioVariabile": 0 } ] }
}`

  const res = await fetch(`${GEMINI_API}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 32768,
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
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Risposta Gemini senza testo (calcolo indicatori)')

  const raw = parseGeminiJson(text)
  const normalized = normalizeIndicatorsShape(raw)
  if (!normalized) throw new Error('Risposta AI incompleta per gli indicatori')
  return normalized
}

export async function suggestJobGradingMappingWithGemini(apiKey, headers, sampleRows) {
  if (!apiKey || !headers?.length) return null
  const sample = sampleRows.slice(0, 20).map((r) => {
    const row = {}
    headers.forEach((h) => { row[h] = r[h] != null ? String(r[h]).slice(0, 120) : '' })
    return row
  })
  const prompt = `Mappa le colonne del file sui ruoli richiesti per job grading.
Ruoli possibili (usa ESATTAMENTE questi identificatori):
- retribuzione_base
- componenti_variabili
- retribuzione_totale
- ruolo
- livello_inquadramento
- job_description

Restituisci SOLO JSON valido con formato:
{ "nome_colonna_esatto": "identificatore_ruolo", ... }

Intestazioni: ${JSON.stringify(headers)}
Campione righe: ${JSON.stringify(sample)}`

  const res = await fetch(`${GEMINI_API}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 16384,
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
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Risposta Gemini senza testo (job grading mapping)')
  const raw = parseGeminiJson(text)

  const valid = new Set([
    'retribuzione_base',
    'componenti_variabili',
    'retribuzione_totale',
    'ruolo',
    'livello_inquadramento',
    'job_description',
  ])
  const headerToIndex = Object.fromEntries(headers.map((h, i) => [h, i]))
  const norm = (s) => String(s).toLowerCase().trim()
  const mapping = {}
  for (const [columnName, role] of Object.entries(raw)) {
    if (!valid.has(role)) continue
    let idx = headerToIndex[columnName]
    if (idx == null) idx = headers.findIndex((h) => norm(h) === norm(columnName))
    if (idx >= 0) mapping[role] = idx
  }
  return Object.keys(mapping).length ? mapping : null
}

export async function scoreJobRolesWithGemini(apiKey, roleRows) {
  if (!apiKey) throw new Error('API key Gemini mancante')
  if (!Array.isArray(roleRows) || !roleRows.length) throw new Error('Nessun ruolo da analizzare')

  const prompt = `Assegna punteggi 0-100 per ogni ruolo in base a:
1) competenze_richieste
2) responsabilita
3) sforzo_mentale
4) condizioni_lavorative
5) totalScore = somma dei 4 punteggi (0-400)

Input ruoli:
${JSON.stringify(roleRows)}

Restituisci SOLO JSON con formato:
{
  "roles": [
    {
      "role": "...",
      "competenze_richieste": 0,
      "responsabilita": 0,
      "sforzo_mentale": 0,
      "condizioni_lavorative": 0,
      "totalScore": 0
    }
  ]
}`

  const res = await fetch(`${GEMINI_API}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 32768,
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
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Risposta Gemini senza testo (job grading scores)')
  const raw = parseGeminiJson(text)
  const roles = Array.isArray(raw?.roles) ? raw.roles : (Array.isArray(raw) ? raw : [])
  if (!roles.length) throw new Error('Risposta AI senza ruoli valutati')
  return roles
}

function parseGeminiJson(text) {
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim()

  const candidates = [
    cleaned,
    extractDelimited(cleaned, '{', '}'),
    extractDelimited(cleaned, '[', ']'),
  ].filter(Boolean)

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate)
    if (parsed) return normalizeParsedMapping(parsed)
  }

  const fromPairs = parsePairsFromText(cleaned)
  if (Object.keys(fromPairs).length) return fromPairs

  throw new SyntaxError('Invalid Gemini JSON response')
}

function tryParseJson(value) {
  try {
    // Tolleranza minima: elimina trailing commas prima di } o ]
    const sanitized = String(value).replace(/,\s*([}\]])/g, '$1')
    return JSON.parse(sanitized)
  } catch {
    return null
  }
}

function normalizeParsedMapping(parsed) {
  if (Array.isArray(parsed)) {
    // Supporta formato alternativo:
    // [{ "columnName": "...", "role": "genere" }, ...]
    const out = {}
    for (const item of parsed) {
      const columnName = item?.columnName ?? item?.column ?? item?.header ?? item?.name
      const role = item?.role
      if (!columnName || !VALID_ROLE_SET.has(role)) continue
      out[String(columnName)] = role
    }
    return out
  }
  if (parsed && typeof parsed === 'object') {
    return parsed
  }
  return {}
}

function parsePairsFromText(text) {
  const out = {}
  const quotedPairs = /["']([^"']+)["']\s*:\s*["']([^"']+)["']/g
  let match = quotedPairs.exec(text)
  while (match) {
    const [, columnName, role] = match
    if (VALID_ROLE_SET.has(role)) out[columnName] = role
    match = quotedPairs.exec(text)
  }
  if (Object.keys(out).length) return out

  // Fallback su righe tipo: COLONNA -> ruolo
  const rolePattern = Array.from(VALID_ROLE_SET).join('|')
  const linePairs = new RegExp(`^\\s*(.+?)\\s*(?:[:=\\-]|->)\\s*(${rolePattern})\\s*$`, 'i')
  for (const line of String(text).split('\n')) {
    const m = line.match(linePairs)
    if (!m) continue
    const columnName = m[1].replace(/^["']|["']$/g, '').trim()
    const role = m[2].trim()
    if (columnName && VALID_ROLE_SET.has(role)) out[columnName] = role
  }
  return out
}

function extractDelimited(text, open, close) {
  const start = text.indexOf(open)
  const end = text.lastIndexOf(close)
  if (start === -1 || end === -1 || end <= start) return null
  return text.slice(start, end + 1)
}

function normalizeIndicatorsShape(raw) {
  const obj = raw?.indicators && typeof raw.indicators === 'object' ? raw.indicators : raw
  if (!obj || typeof obj !== 'object') return null
  const required = [
    'a_divarioRetributivoGenere',
    'b_divarioComponentiVariabili',
    'c_divarioMedianoGenere',
    'd_divarioMedianoComponentiVariabili',
    'e_percentualeConComponentiVariabili',
    'f_percentualePerQuartile',
    'g_divarioPerCategoria',
  ]
  for (const k of required) {
    if (!obj[k]) return null
  }
  return obj
}
