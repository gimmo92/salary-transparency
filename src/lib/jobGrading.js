import { COLUMN_ROLES } from './excel.js'
import {
  TRANSPARENCY_FLAT_FACTORS,
  TRANSPARENCY_FACTOR_IDS,
  trFieldName,
  transparencyWeightsMap,
  transparencyParametricPointsFromFactor,
} from './transparencyCriteria.js'

// --- CCNL Level hierarchy (higher number = higher band) ---

const LEVEL_ORDER = {
  'd1': 1, 'd2': 2, 'd': 1,
  'c3': 3, 'c2': 4, 'c1': 5, 'c': 4,
  'b3': 6, 'b2': 7, 'b1': 8, 'b': 7,
  'as': 9,
  'a': 10, 'a2': 10, 'a1': 11,
  'q': 12, 'quadro': 12, 'quadri': 12,
  'dirigente': 13, 'dir': 13, 'manager': 13,
}

const LEVEL_NUMERIC = { 8: 1, 7: 2, 6: 3, 5: 4, 4: 5, 3: 7, 2: 10, 1: 12 }

const LEVEL_FUZZY = [
  [/\bdirig|manager/i, 13],
  [/\bq\b|quadr/i, 12],
  [/\ba1\b/i, 11],
  [/\ba2?\b/i, 10],
  [/\bas\b/i, 9],
  [/\bb1\b/i, 8],
  [/\bb2?\b/i, 7],
  [/\bb3\b/i, 6],
  [/\bc1\b/i, 5],
  [/\bc2?\b/i, 4],
  [/\bc3\b/i, 3],
  [/\bd2\b/i, 2],
  [/\bd1?\b/i, 1],
]

const KW_TITOLI = [
  'laurea', 'master', 'phd', 'dottor', 'diploma', 'certific', 'specializz',
  'istruzione', 'formazione', 'qualifica',
]
const KW_ESPERIENZA = [
  'senior', 'esperienza', 'consolidat', 'plurienn', 'ultra', 'decenn',
  'esperto', 'veteran',
]
const KW_TRASVERSALI = [
  'leadership', 'negozia', 'team', 'relazion', 'comunicaz', 'collabor',
  'influenz', 'soft skill', 'empatia',
]
const KW_AUTONOMIA = [
  'autonom', 'delega', 'discrezional', 'responsabile', 'decision', 'indipendent',
]
const KW_IMPATTO = [
  'strateg', 'budget', 'kpi', 'obiettiv', 'risultat', 'business', 'economico',
  'margine', 'fatturato', 'target',
]
const KW_GESTIONE_RH = [
  'coordina', 'manager', 'direttore', 'capo', 'supervision', 'team di',
  'struttura', 'risorse umane', 'valutazion', 'sviluppo del personale',
]
const KW_SFORZO_MENTALE = [
  'analisi', 'compless', 'problem', 'progett', 'architect', 'ottimizz',
  'innovaz', 'ricerca', 'sviluppo tecnico',
]
const KW_TENSIONE = [
  'stress', 'urgenz', 'reclami', 'crisi', 'conflitt', 'pressione', 'deadline',
]
const KW_AMBIENTE = [
  'impianto', 'produz', 'rumore', 'cantiere', 'magazzino', 'sicurezza',
  'rischio chimico', 'laboratorio', 'reparto',
]
const KW_DISAGIO_ORG = [
  'turno', 'notte', 'trasfert', 'reperibil', 'isolamento', 'mobilità',
  'mobilita', 'weekend', 'chiamata',
]

export function normalizeLevelLabel(levelRaw) {
  if (levelRaw == null || levelRaw === '') return null
  const raw = String(levelRaw).trim()
  const cleaned = raw.toLowerCase()
    .replace(/\s+/g, '')
    .replace(/^livello/i, '')
    .replace(/^liv\.?/i, '')
    .trim()

  if (LEVEL_ORDER[cleaned] != null) return cleaned.toUpperCase()

  const asNum = Number(cleaned)
  if (Number.isInteger(asNum) && LEVEL_NUMERIC[asNum] != null) return `Livello ${asNum}`

  for (const [regex] of LEVEL_FUZZY) {
    if (regex.test(raw)) return raw.trim()
  }

  return raw.trim() || null
}

export function levelSortOrder(levelRaw) {
  if (levelRaw == null || levelRaw === '') return 0
  const raw = String(levelRaw).trim()
  const cleaned = raw.toLowerCase()
    .replace(/\s+/g, '')
    .replace(/^livello/i, '')
    .replace(/^liv\.?/i, '')
    .trim()

  if (LEVEL_ORDER[cleaned] != null) return LEVEL_ORDER[cleaned]

  const asNum = Number(cleaned)
  if (Number.isInteger(asNum) && LEVEL_NUMERIC[asNum] != null) return LEVEL_NUMERIC[asNum]

  for (const [regex, order] of LEVEL_FUZZY) {
    if (regex.test(raw)) return order
  }

  return 0
}

function mean(arr) {
  if (!arr.length) return 0
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

function pctGap(maleAvg, femaleAvg) {
  if (!Number.isFinite(maleAvg) || maleAvg === 0) return 0
  return ((maleAvg - femaleAvg) / maleAvg) * 100
}

function clamp0100(n) {
  return Math.max(0, Math.min(100, Math.round(Number(n) || 0)))
}

function score15to100(n) {
  const s = Math.max(1, Math.min(5, Math.round(Number(n) || 0)))
  return Math.round(((s - 1) / 4) * 100)
}

function keywordHits(text, list) {
  return list.reduce((acc, kw) => acc + (text.includes(kw) ? 1 : 0), 0)
}

function scoreFromText(text, keywords, base = 2) {
  const h = keywordHits(text, keywords)
  return score15to100(base + Math.min(3, h))
}

function levelNormBoost(levelRaw) {
  const o = levelSortOrder(levelRaw)
  if (!o) return 0
  return Math.min(2, Math.floor(o / 5))
}

function normalizeGender(raw) {
  const g = String(raw || '').trim().toLowerCase()
  if (['m', 'maschio', 'uomo', 'male'].includes(g)) return 'M'
  if (['f', 'femmina', 'donna', 'female'].includes(g)) return 'F'
  return null
}

const WEIGHTS = transparencyWeightsMap()

/** Fascia da punteggio 0–100 (passi da 5 punti per cluster omogenei). */
function fasciaFromWeightedScore(w) {
  const x = Math.min(100, Math.max(0, Math.round(Number(w) / 5) * 5))
  return { min: x, max: x, key: String(x) }
}

/**
 * @param {object} person - record normalizzato job grading
 * @param {object} opts
 * @param {string} [opts.companyContext]
 * @param {Record<string, number>|null} [opts.override] - punteggi 0–100 per id fattore (es. titoliConoscenze)
 */
export function computeTransparencyScoresForPerson(person, { companyContext = '', override = null } = {}) {
  const text = `${person.role || ''} ${person.description || ''} ${person.category || ''} ${companyContext}`.toLowerCase()
  const descLen = String(person.description || '').length
  const lb = levelNormBoost(person.level)
  const sen = person.seniority
  const senNum = typeof sen === 'number' && Number.isFinite(sen) ? sen : null

  const heuristic = {
    titoliConoscenze: scoreFromText(text, KW_TITOLI, 2 + Math.min(1, Math.floor(descLen / 400))),
    esperienza: score15to100(
      2 + (senNum != null && senNum >= 10 ? 2 : senNum != null && senNum >= 5 ? 1 : 0) + lb + (keywordHits(text, KW_ESPERIENZA) ? 1 : 0),
    ),
    competenzeTrasversali: scoreFromText(text, KW_TRASVERSALI, 2 + Math.min(1, lb)),
    autonomiaDelega: scoreFromText(text, KW_AUTONOMIA, 2 + lb),
    impattoObiettivi: scoreFromText(text, KW_IMPATTO, 2 + lb),
    gestioneRisorseUmane: scoreFromText(text, KW_GESTIONE_RH, 2 + lb),
    sforzoMentale: scoreFromText(text, KW_SFORZO_MENTALE, 2 + Math.min(2, Math.floor(descLen / 200))),
    tensioneEmotiva: scoreFromText(text, KW_TENSIONE, 2),
    ambienteFisico: scoreFromText(text, KW_AMBIENTE, 1 + (keywordHits(text, KW_AMBIENTE) ? 2 : 0)),
    disagioOrganizzativo: scoreFromText(text, KW_DISAGIO_ORG, 1 + (keywordHits(text, KW_DISAGIO_ORG) ? 2 : 0)),
  }

  const out = {}
  for (const id of TRANSPARENCY_FACTOR_IDS) {
    const v = override && override[id] != null ? clamp0100(override[id]) : heuristic[id]
    out[trFieldName(id)] = v
  }

  let weighted = 0
  let parametric100 = 0
  for (const f of TRANSPARENCY_FLAT_FACTORS) {
    const s = out[trFieldName(f.id)]
    weighted += s * WEIGHTS[f.id]
    parametric100 += transparencyParametricPointsFromFactor(s, f.weightPct)
  }
  out.trWeightedScore = Math.round(weighted * 100) / 100
  out.trParametricScore100 = Math.round(parametric100 * 100) / 100

  return out
}

/** Media aritmetica dei punteggi trasparenza su un elenco di persone */
export function meanTransparencyScores(people) {
  if (!people?.length) return null
  const sums = Object.fromEntries(TRANSPARENCY_FACTOR_IDS.map((id) => [id, 0]))
  for (const p of people) {
    for (const id of TRANSPARENCY_FACTOR_IDS) {
      sums[id] += Number(p[trFieldName(id)]) || 0
    }
  }
  const n = people.length
  const avg = {}
  for (const id of TRANSPARENCY_FACTOR_IDS) {
    avg[trFieldName(id)] = Math.round((sums[id] / n) * 100) / 100
  }
  let w = 0
  let p100 = 0
  for (const f of TRANSPARENCY_FLAT_FACTORS) {
    const s = avg[trFieldName(f.id)]
    w += s * WEIGHTS[f.id]
    p100 += transparencyParametricPointsFromFactor(s, f.weightPct)
  }
  avg.trWeightedScore = Math.round(w * 100) / 100
  avg.trParametricScore100 = Math.round(p100 * 100) / 100
  return avg
}

function isValidSalary(person) {
  return Number.isFinite(person.baseSalary) && person.baseSalary > 0
    && Number.isFinite(person.totalSalary) && person.totalSalary > 0
}

// --- Core: parse Excel rows into normalized records ---

/**
 * Formatta un numero per visualizzazione italiana senza separatori migliaia (es. 16,1).
 */
function formatNumberItITNoGroup(n) {
  return n.toLocaleString('it-IT', { useGrouping: false, maximumFractionDigits: 20 })
}

/**
 * Interpreta stringhe numeriche in stile italiano: 16,1 · 1.234,56 · 16.1
 * Ritorna null se non è un numero riconoscibile.
 */
function parseItalianDecimalString(compact) {
  if (compact == null || compact === '') return null
  const s = String(compact).trim().replace(/\s/g, '')
  if (!s || !/^[-+]?\d[\d.,]*$/.test(s)) return null

  const hasComma = s.includes(',')
  const hasDot = s.includes('.')

  let normalized
  if (hasComma && hasDot) {
    // Es. 1.234,56
    normalized = s.replace(/\./g, '').replace(',', '.')
  } else if (hasComma && !hasDot) {
    // Es. 16,1 — virgola decimale
    normalized = s.replace(',', '.')
  } else if (hasDot && !hasComma) {
    // Solo punti: 16.1 decimale vs 1.234 migliaia (ultimo gruppo ≤3 cifre → decimale)
    const parts = s.split('.')
    if (parts.length === 2 && parts[1].length <= 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
      normalized = s
    } else {
      normalized = s.replace(/\./g, '')
    }
  } else {
    normalized = s
  }

  const n = parseFloat(normalized)
  return Number.isFinite(n) ? n : null
}

/**
 * Valore anzianità come da Excel italiano (virgola decimale preservata).
 */
function parseSeniorityDisplay(value) {
  if (value == null || value === '') return null

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Intero tipo 161 da export/celle male interpretate → 16,1
    if (Number.isInteger(value) && value >= 101 && value <= 509) {
      const recovered = parseSeniorityThreeDigitAmbiguous(String(value))
      if (recovered != null) return formatNumberItITNoGroup(recovered)
    }
    return formatNumberItITNoGroup(value)
  }

  const raw = String(value).trim()
  if (!raw) return null

  // Data o testo libero (es. "01/03/2010", "15 anni")
  if (/\d\s*[/]\s*\d/.test(raw) || /^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw
  }
  if (/[a-zA-Zàèéìòù]/.test(raw) && !/^[-+]?[\d.,]+$/.test(raw.replace(/\s/g, ''))) {
    return raw
  }

  const compact = raw.replace(/\s/g, '')
  const parsed = parseItalianDecimalString(compact)
  if (parsed != null) {
    return formatNumberItITNoGroup(parsed)
  }

  // Recupero virgola decimale persa: "161" da cella 16,1 letta male (anni con una cifra decimale)
  const lostComma = parseSeniorityThreeDigitAmbiguous(compact)
  if (lostComma != null) {
    return formatNumberItITNoGroup(lostComma)
  }

  return raw
}

/**
 * Es. "161" → 16.1 se interpretabile come XX,Y con Y 1-9 e XX anni plausibili (0-50).
 */
function parseSeniorityThreeDigitAmbiguous(compact) {
  if (!/^\d{3}$/.test(compact)) return null
  const m = compact.match(/^(\d{2})([1-9])$/)
  if (!m) return null
  const whole = parseInt(m[1], 10)
  if (whole < 0 || whole > 50) return null
  const dec = parseInt(m[2], 10)
  return whole + dec / 10
}

/** Anni trascorsi da una data di ingresso (approssimato) */
function yearsFromSeniorityDate(raw) {
  const s = String(raw).trim()
  let d = null
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = Date.parse(s.slice(0, 10))
    if (!Number.isNaN(t)) d = new Date(t)
  } else {
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (m) {
      d = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10))
    }
  }
  if (!d || Number.isNaN(d.getTime())) return null
  const ms = Date.now() - d.getTime()
  return Math.max(0, ms / (365.25 * 24 * 3600 * 1000))
}

/**
 * Converte il valore anzianità (come in Excel) in anni numerici per confronti statistici.
 * Ritorna null se non è un numero né una data interpretabile.
 */
export function seniorityToYearsNumeric(value) {
  if (value == null || value === '') return null

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isInteger(value) && value >= 101 && value <= 509) {
      const recovered = parseSeniorityThreeDigitAmbiguous(String(value))
      if (recovered != null) return recovered
    }
    return value
  }

  const raw = String(value).trim()
  if (!raw) return null

  if (/\d\s*[/]\s*\d/.test(raw) || /^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return yearsFromSeniorityDate(raw)
  }

  const anniMatch = raw.match(/(\d+[.,]?\d*)\s*anni/i)
  if (anniMatch) {
    const compact = anniMatch[1].replace(/\s/g, '')
    const parsed = parseItalianDecimalString(compact)
    if (parsed != null) return parsed
    const n = parseFloat(compact.replace(',', '.'))
    return Number.isFinite(n) ? n : null
  }

  if (/[a-zA-Zàèéìòù]/.test(raw) && !/^[-+]?[\d.,]+$/.test(raw.replace(/\s/g, ''))) {
    return null
  }

  const compact = raw.replace(/\s/g, '')
  const parsed = parseItalianDecimalString(compact)
  if (parsed != null) return parsed
  const lostComma = parseSeniorityThreeDigitAmbiguous(compact)
  if (lostComma != null) return lostComma
  return null
}

export function buildNormalizedJobGradingData(rows, headers, mapping) {
  if (!rows?.length || !headers?.length || !mapping) return []

  const idx = (key) =>
    Object.prototype.hasOwnProperty.call(mapping, key) ? mapping[key] : undefined

  const roleIdx = idx(COLUMN_ROLES.role)
  const levelIdx = idx(COLUMN_ROLES.level)
  const descIdx = idx(COLUMN_ROLES.description)
  const categoryIdx = idx(COLUMN_ROLES.category)
  const genderIdx = idx(COLUMN_ROLES.gender)
  const baseIdx = idx(COLUMN_ROLES.baseSalary)
  const varIdx = idx(COLUMN_ROLES.variableComponents)
  const nameIdx = idx(COLUMN_ROLES.employeeName)
  const totalIdx = idx(COLUMN_ROLES.totalSalary)
  const seniorityIdx = idx(COLUMN_ROLES.seniority)

  const parseNumber = (value) => {
    if (value == null || value === '' || value === 'N/D') return 0
    if (typeof value === 'number') return value
    const cleaned = String(value)
      .replace(/\./g, '')
      .replace(/,/g, '.')
      .replace(/[^\d.-]/g, '')
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : 0
  }

  return rows.map((row, index) => {
    const base = baseIdx != null ? parseNumber(row[baseIdx]) : 0
    const variable = varIdx != null ? parseNumber(row[varIdx]) : 0
    const total = totalIdx != null ? parseNumber(row[totalIdx]) : base + variable
    const levelRaw = levelIdx != null ? row[levelIdx] : null
    const role = roleIdx != null ? row[roleIdx] : null
    return {
      index: index + 1,
      name: nameIdx != null ? row[nameIdx] : null,
      role,
      level: levelRaw,
      description: descIdx != null ? row[descIdx] : null,
      category: categoryIdx != null ? row[categoryIdx] : null,
      gender: genderIdx != null ? normalizeGender(row[genderIdx]) : null,
      seniority: seniorityIdx != null ? parseSeniorityDisplay(row[seniorityIdx]) : null,
      baseSalary: base,
      variableComponents: variable,
      totalSalary: total,
    }
  })
}

// --- Group people by CCNL level → each level is a "band" ---

/**
 * @param {Array} normalizedData
 * @param {Record<string, Record<string, number>>} [roleOverrides] chiave `${livelloCCNL}|${nomeRuolo}` → { factorId: 0-100 }
 */
export function groupByLevel(normalizedData, roleOverrides = {}) {
  const companyContext = [...new Set(normalizedData.map((p) => p.category).filter(Boolean))].slice(0, 8).join(' ')

  const map = new Map()

  for (const person of normalizedData) {
    const levelKey = normalizeLevelLabel(person.level) || 'N/D'
    const roleKey = String(person.role || 'N/D').trim() || 'N/D'
    const ov = roleOverrides[`${levelKey}|${roleKey}`] || null
    const withTr = {
      ...person,
      ...computeTransparencyScoresForPerson(person, { companyContext, override: ov }),
    }
    if (!map.has(levelKey)) {
      map.set(levelKey, {
        level: levelKey,
        sortOrder: levelSortOrder(person.level),
        people: [],
      })
    }
    map.get(levelKey).people.push(withTr)
  }

  const groups = Array.from(map.values())
    .sort((a, b) => b.sortOrder - a.sortOrder)

  groups.forEach((g, i) => {
    g.band = i + 1
  })

  return groups.map((g) => {
    const validPeople = g.people.filter(isValidSalary)
    const n = validPeople.length
    const totalBase = validPeople.reduce((s, p) => s + p.baseSalary, 0)
    const totalVar = validPeople.reduce((s, p) => s + p.variableComponents, 0)
    const totalSals = validPeople.map((p) => p.totalSalary)
    const avgSalary = mean(totalSals)
    const roles = [...new Set(g.people.map((p) => p.role).filter(Boolean))]

    // 1) Build Hay analysis at ROLE level inside each CCNL level
    const roleMap = new Map()
    for (const p of g.people) {
      const roleKey = p.role || 'N/D'
      if (!roleMap.has(roleKey)) {
        roleMap.set(roleKey, {
          role: roleKey,
          people: [],
        })
      }
      roleMap.get(roleKey).people.push(p)
    }

    const roleProfiles = Array.from(roleMap.values()).map((r) => {
      const people = r.people
      const validPeople = people.filter(isValidSalary)
      const maleSalaries = validPeople.filter((p) => p.gender === 'M').map((p) => p.totalSalary)
      const femaleSalaries = validPeople.filter((p) => p.gender === 'F').map((p) => p.totalSalary)
      const avgMen = mean(maleSalaries)
      const avgWomen = mean(femaleSalaries)
      const trMeans = meanTransparencyScores(people) || {}

      return {
        role: r.role,
        people,
        n: people.length,
        nValid: validPeople.length,
        avgTotalSalary: mean(validPeople.map((p) => p.totalSalary)),
        ...trMeans,
        avgSalaryMen: avgMen,
        avgSalaryWomen: avgWomen,
        nMen: maleSalaries.length,
        nWomen: femaleSalaries.length,
        genderPayGapPct: (maleSalaries.length > 0 && femaleSalaries.length > 0)
          ? pctGap(avgMen, avgWomen)
          : null,
      }
    })

    // 2) Raggruppa ruoli per punteggio pesato (scala 0–100, passi da 5)
    const hayMap = new Map()
    for (const roleProfile of roleProfiles) {
      const bucket = fasciaFromWeightedScore(roleProfile.trWeightedScore ?? 50)
      if (!hayMap.has(bucket.key)) {
        hayMap.set(bucket.key, {
          ...bucket,
          roles: [],
        })
      }
      hayMap.get(bucket.key).roles.push(roleProfile)
    }

    const hayBands = Array.from(hayMap.values())
      .sort((a, b) => b.min - a.min)
      .map((hb, idx) => {
        const allPeople = hb.roles.flatMap((r) => r.people)
        const valid = allPeople.filter(isValidSalary)
        const salaries = valid.map((p) => p.totalSalary)
        const avgBandSalary = mean(salaries)
        const maleSalaries = valid.filter((p) => p.gender === 'M').map((p) => p.totalSalary)
        const femaleSalaries = valid.filter((p) => p.gender === 'F').map((p) => p.totalSalary)
        const maleAvg = mean(maleSalaries)
        const femaleAvg = mean(femaleSalaries)

        const people = allPeople.map((p) => ({
          ...p,
          haySubBand: hb.key,
          deviationFromHayBandMeanPct: avgBandSalary
            ? ((p.totalSalary - avgBandSalary) / avgBandSalary) * 100
            : 0,
        }))

        const peopleByIndex = new Map(people.map((p) => [p.index, p]))
        const roles = hb.roles.map((r) => ({
          ...r,
          people: r.people.map((p) => ({
            ...p,
            ...(peopleByIndex.get(p.index) || {}),
          })),
        }))

        const bandTrMeans = meanTransparencyScores(allPeople) || {}

        return {
          id: `Fascia ${idx + 1}`,
          label: `Punteggio ${Math.round(hb.min)}/100`,
          minScore: hb.min,
          maxScore: hb.max,
          minScore100: hb.min,
          maxScore100: hb.max,
          n: people.length,
          nValid: valid.length,
          nRoles: hb.roles.length,
          roles,
          avgTotalSalary: avgBandSalary,
          ...bandTrMeans,
          genderPayGapPct: (maleSalaries.length > 0 && femaleSalaries.length > 0)
            ? pctGap(maleAvg, femaleAvg)
            : null,
          avgSalaryMen: maleAvg,
          avgSalaryWomen: femaleAvg,
          nMen: maleSalaries.length,
          nWomen: femaleSalaries.length,
          people,
        }
      })

    return {
      level: g.level,
      band: g.band,
      sortOrder: g.sortOrder,
      roles,
      n: g.people.length,
      nValid: n,
      avgBaseSalary: n ? totalBase / n : 0,
      avgVariableComponents: n ? totalVar / n : 0,
      avgTotalSalary: avgSalary,
      hayBands,
      people: g.people,
    }
  })
}

// --- Compute deviation of each band from overall mean ---

export function enrichWithDeviation(bands) {
  if (!bands.length) return []

  const allMeans = bands.filter((b) => b.nValid > 0).map((b) => b.avgTotalSalary)
  const overallMean = mean(allMeans)

  return bands.map((b) => {
    const val = b.avgTotalSalary || 0
    const deviationPct = overallMean ? ((val - overallMean) / overallMean) * 100 : 0

    const people = b.people.map((p) => ({
      ...p,
      deviationFromLevelMeanPct: b.avgTotalSalary
        ? ((p.totalSalary - b.avgTotalSalary) / b.avgTotalSalary) * 100
        : 0,
    }))

    return {
      ...b,
      overallMean,
      deviationFromOverallMeanPct: deviationPct,
      people,
    }
  })
}
