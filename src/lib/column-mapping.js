/** Valori allineati a COLUMN_ROLES in excel.js (no import per evitare cicli). */
const R = {
  gender: 'gender',
  employeeName: 'employeeName',
  baseSalary: 'baseSalary',
  variableComponents: 'variableComponents',
  totalSalary: 'totalSalary',
  category: 'category',
  role: 'role',
  level: 'level',
  description: 'description',
  seniority: 'seniority',
  roleSeniority: 'roleSeniority',
  performanceScore: 'performanceScore',
}

/** Ruoli per cui l'euristica ha priorità sull'AI (evita 14ma → base, INPS → totale). */
const SALARY_PRIORITY_ROLES = new Set([R.baseSalary, R.variableComponents, R.totalSalary])

const DISQUALIFY = {
  [R.baseSalary]: [
    /\b14\s*ma\b/i,
    /\b14\s*es/i,
    /\b13\s*ma\b/i,
    /\b13\s*es/i,
    /\b12\s*ma\b/i,
    /\bmensilit/i,
    /\binps\b/i,
    /\bcontribut/i,
    /\btfr\b/i,
    /\baccanton/i,
    /\bvariabil/i,
    /\bcosto\s*(del\s*)?lavoro/i,
    /\bcentro\s*di\s*costo/i,
    /\bjob\s*desc/i,
  ],
  [R.totalSalary]: [
    /\binps\b/i,
    /\bcontribut/i,
    /\bctr\s*inps/i,
    /\bcosto\s*azienda/i,
    /\b14\s*ma\b/i,
    /\b13\s*ma\b/i,
    /\bmensilit/i,
    /\baccanton/i,
    /\btfr\b/i,
    /\bcentro\s*di\s*costo/i,
  ],
  [R.variableComponents]: [
    /\binps\b/i,
    /\bcontribut/i,
    /\b14\s*ma\b/i,
    /\bretribuzione\s*base\b/i,
    /\bral\s*fiss/i,
    /\bcentro\s*di\s*costo/i,
  ],
}

const SCORE_PATTERNS = {
  [R.gender]: [
    { re: /\b(sesso|genere|gender|sex)\b/i, w: 8 },
    { re: /\bm\s*\/\s*f\b/i, w: 6 },
  ],
  [R.employeeName]: [
    { re: /\b(dipendente|nominativo|nome|cognome|employee)\b/i, w: 7 },
  ],
  [R.baseSalary]: [
    { re: /\b(retribuzione\s*base|ral\s*base|competenze\s*fisse|stipendio\s*base)\b/i, w: 10 },
    { re: /\b(ral|retribuzione\s*fissa)\b/i, w: 8 },
    { re: /\b(base\s*annua|fisso\s*annuo)\b/i, w: 7 },
    { re: /\bbase\b/i, w: 3 },
  ],
  [R.variableComponents]: [
    { re: /\b(tot\s*)?comp\.?\s*variab/i, w: 10 },
    { re: /\bcomponenti?\s*variabil/i, w: 9 },
    { re: /\b(bonus|premi|premio|incentiv|mbo|stock)\b/i, w: 6 },
    { re: /\bvariabil/i, w: 5 },
  ],
  [R.totalSalary]: [
    { re: /\b(retribuzione\s*totale|totale\s*competenze|lordo\s*annuo|competenze\s*totali)\b/i, w: 10 },
    { re: /\b(totale\s*annuo|ral\s*totale|tot\s*retrib)\b/i, w: 9 },
    { re: /\b(totale|total\s*comp|annual\s*total)\b/i, w: 5 },
  ],
  [R.category]: [
    { re: /\b(categoria|inquadramento|classificazione)\b/i, w: 8 },
    { re: /\bcentro\s*di\s*costo\b/i, w: 4 },
  ],
  [R.role]: [
    { re: /\b(ruolo|job\s*title|posizione|mansione|title)\b/i, w: 8 },
    { re: /\bjob\b/i, w: 2 },
  ],
  [R.level]: [
    { re: /\b(livello|level|grade|ccnl|inquadramento\s*contr)\b/i, w: 8 },
    { re: /\bband\b/i, w: 4 },
  ],
  [R.description]: [
    { re: /\b(job\s*desc|descrizione\s*ruolo|mansione|description)\b/i, w: 8 },
    { re: /\bdescrizione\b/i, w: 5 },
  ],
  [R.seniority]: [
    { re: /\b(anzianit[aà]|seniority|anni\s*servizio|data\s*assunzione|data\s*ingresso)\b/i, w: 8 },
  ],
  [R.roleSeniority]: [
    { re: /\b(anzianit[aà].*ruolo|ruolo.*anzianit|seniority.*role)\b/i, w: 10 },
  ],
  [R.performanceScore]: [
    { re: /\b(performance|valutazione|rating|punteggio)\b/i, w: 7 },
  ],
}

export function isDisqualifiedHeader(header, role) {
  const h = String(header || '')
  const rules = DISQUALIFY[role]
  if (!rules) return false
  return rules.some((re) => re.test(h))
}

function parseSampleNumber(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const cleaned = String(value)
    .replace(/\./g, '')
    .replace(/,/g, '.')
    .replace(/[^\d.-]/g, '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

function columnNumericStats(rows, colIdx) {
  const vals = []
  for (const row of (rows || []).slice(0, 40)) {
    const n = parseSampleNumber(row?.[colIdx])
    if (n != null && n >= 500 && n <= 2_000_000) vals.push(n)
  }
  if (vals.length < 2) return null
  vals.sort((a, b) => a - b)
  const median = vals[Math.floor(vals.length / 2)]
  return { median, max: vals[vals.length - 1], count: vals.length }
}

function sampleScoreBoost(header, role, stats) {
  if (!stats || !SALARY_PRIORITY_ROLES.has(role)) return 0
  const h = String(header || '')
  const { median, max } = stats

  if (/\b(14|13|12)\s*ma\b/i.test(h) || /\bmensilit/i.test(h)) {
    if (median < 25_000) return -8
  }
  if (/\binps\b/i.test(h) || /\bcontribut/i.test(h)) return -8

  if (role === R.baseSalary) {
    if (median >= 22_000 && median <= 250_000) return 4
    if (median < 12_000) return -4
  }
  if (role === R.totalSalary) {
    if (median >= 24_000 && max >= median * 1.02) return 4
    if (median < 12_000) return -4
  }
  if (role === R.variableComponents) {
    if (median >= 500 && median <= 120_000) return 2
  }
  return 0
}

export function scoreHeaderForRole(header, role, rows, colIdx) {
  const h = String(header || '').trim()
  if (!h || isDisqualifiedHeader(h, role)) return -1
  const patterns = SCORE_PATTERNS[role] || []
  let score = 0
  for (const { re, w } of patterns) {
    if (re.test(h)) score += w
  }
  if (colIdx != null && rows) {
    score += sampleScoreBoost(h, role, columnNumericStats(rows, colIdx))
  }
  return score
}

function bestColumnForRole(headers, role, usedIndices, rows) {
  let bestIdx = -1
  let bestScore = 0
  for (let i = 0; i < headers.length; i++) {
    if (usedIndices.has(i)) continue
    const s = scoreHeaderForRole(headers[i], role, rows, i)
    if (s > bestScore) {
      bestScore = s
      bestIdx = i
    }
  }
  return bestScore >= 3 ? bestIdx : -1
}

/**
 * Rilevamento colonne con punteggio (IT payroll); più affidabile del solo includes().
 */
export function detectColumnRoles(headers, rows) {
  const result = {}
  const used = new Set()
  const roleOrder = [
    R.gender,
    R.employeeName,
    R.baseSalary,
    R.variableComponents,
    R.totalSalary,
    R.role,
    R.level,
    R.category,
    R.description,
    R.roleSeniority,
    R.seniority,
    R.performanceScore,
  ]

  for (const role of roleOrder) {
    const idx = bestColumnForRole(headers, role, used, rows)
    if (idx >= 0) {
      result[role] = idx
      used.add(idx)
    }
  }
  return result
}

/**
 * Unisce euristica + AI: per retribuzioni non sovrascrive match euristici validi;
 * scarta mapping AI su colonne palesemente errate (14ma, INPS, …).
 */
export function mergeColumnMappings(heuristic, ai, headers) {
  const merged = { ...(heuristic || {}) }

  for (const [role, rawIdx] of Object.entries(ai || {})) {
    const idx = Number(rawIdx)
    if (!Number.isFinite(idx) || idx < 0 || idx >= headers.length) continue
    const header = headers[idx]

    if (isDisqualifiedHeader(header, role)) continue

    const aiScore = scoreHeaderForRole(header, role, null, idx)
    if (aiScore < 0) continue

    if (SALARY_PRIORITY_ROLES.has(role) && heuristic?.[role] != null) {
      const heurIdx = heuristic[role]
      const heurHeader = headers[heurIdx]
      if (!isDisqualifiedHeader(heurHeader, role) && scoreHeaderForRole(heurHeader, role, null, heurIdx) >= 3) {
        continue
      }
    }

    if (SALARY_PRIORITY_ROLES.has(role)) {
      if (aiScore < 4) continue
      const existing = merged[role]
      if (existing != null && scoreHeaderForRole(headers[existing], role, null, existing) >= aiScore) continue
    }

    merged[role] = idx
  }

  return merged
}

export function buildMappingPrompt(headers, rows) {
  const sampleRows = (rows || []).slice(0, 8)
  const catalog = headers.map((h, i) => {
    const samples = sampleRows
      .map((r) => r?.[i])
      .filter((v) => v != null && String(v).trim() !== '')
      .slice(0, 4)
      .map((v) => String(v).slice(0, 40))
    return { index: i, header: String(h ?? '').trim(), samples }
  })

  return `Sei un esperto di fogli retributivi italiani (trasparenza salariale, CCNL, RAL).

Ti passo l'elenco colonne (indice 0-based) con esempi di valori. Mappa ogni "ruolo logico" alla colonna corretta.

REGOLE OBBLIGATORIE (Italia):
- baseSalary = retribuzione FISSA/BASE annua (RAL base, competenze fisse, stipendio base). MAI: 14ma, 13ma, mensilità aggiuntive, INPS, contributi, TFR, accantonamenti, "totale variabili" da sola.
- totalSalary = retribuzione TOTALE annua lorda (totale competenze, lordo annuo, RAL totale). MAI: INPS, contributi previdenziali, costo azienda, solo componenti variabili, 14ma/13ma.
- variableComponents = bonus, premi, MBO, componenti variabili (es. "TOT COMP VARIAB"). MAI: base fissa, INPS.
- gender = sesso/genere (M/F).
- employeeName = nome dipendente / nominativo.
- category = categoria o inquadramento (centro di costo solo se è l'unica colonna organizzativa).
- role = titolo ruolo/posizione (es. "Ruolo").
- level = livello CCNL contrattuale.
- description = descrizione mansione/job desc.
- seniority = anzianità aziendale / data assunzione.
- roleSeniority = anzianità nel ruolo attuale.
- performanceScore = valutazione performance se presente.

Usa gli ESEMPI numerici: importi in euro → colonne retributive; M/F → genere.

Colonne:
${JSON.stringify(catalog, null, 2)}

Restituisci SOLO JSON: chiavi ruolo → indice colonna (0-based). Includi solo mapping sicuri.
Esempio: {"gender":0,"employeeName":1,"baseSalary":5,"variableComponents":7,"totalSalary":8,"role":3,"level":4}

JSON:`
}
