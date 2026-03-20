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

const RESPONSIBILITY_KEYWORDS = [
  'responsabile', 'manager', 'direttore', 'director', 'head', 'lead', 'coordin',
  'budget', 'kpi', 'strateg', 'decision', 'governance',
]
const PROBLEM_SOLVING_KEYWORDS = [
  'analisi', 'problem solving', 'ottimizz', 'miglioramento', 'progett',
  'architect', 'root cause', 'compless', 'innovazione', 'troubleshoot',
]
const SKILLS_KEYWORDS = [
  'certific', 'specialist', 'senior', 'expert', 'engineer', 'svilupp',
  'tecnico', 'compliance', 'normativa', 'sap', 'erp', 'data', 'finance',
]
const CONDITIONS_KEYWORDS = [
  'turn', 'notte', 'impianto', 'produzione', 'trasferta', 'reperibil',
  'stress', 'sicurezza', 'rischio', 'cantiere', 'magazzino',
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

function clampScore(v) {
  return Math.max(1, Math.min(100, Math.round(v)))
}

function keywordHits(text, list) {
  return list.reduce((acc, kw) => acc + (text.includes(kw) ? 1 : 0), 0)
}

function normalizeGender(raw) {
  const g = String(raw || '').trim().toLowerCase()
  if (['m', 'maschio', 'uomo', 'male'].includes(g)) return 'M'
  if (['f', 'femmina', 'donna', 'female'].includes(g)) return 'F'
  return null
}

function haySubBandFromScore(totalHayScore) {
  const start = Math.floor((totalHayScore - 1) / 20) * 20 + 1
  const end = start + 19
  return { min: start, max: end, key: `${start}-${end}` }
}

function computeHayForPerson(person, { companyContext = '' } = {}) {
  const text = `${person.role || ''} ${person.description || ''} ${person.category || ''} ${companyContext}`.toLowerCase()
  const seniorityBoost = (person.level && String(person.level).length > 0) ? 4 : 0

  const responsibility = clampScore(30 + keywordHits(text, RESPONSIBILITY_KEYWORDS) * 8 + seniorityBoost)
  const problemSolving = clampScore(28 + keywordHits(text, PROBLEM_SOLVING_KEYWORDS) * 8 + String(person.description || '').length / 80)
  const requiredSkills = clampScore(30 + keywordHits(text, SKILLS_KEYWORDS) * 7 + seniorityBoost)
  const workingConditions = clampScore(20 + keywordHits(text, CONDITIONS_KEYWORDS) * 10)
  const totalHayScore = responsibility + problemSolving + requiredSkills + workingConditions

  return {
    hayResponsibility: responsibility,
    hayProblemSolving: problemSolving,
    hayRequiredSkills: requiredSkills,
    hayWorkingConditions: workingConditions,
    hayTotalScore: totalHayScore,
  }
}

function isValidSalary(person) {
  return Number.isFinite(person.baseSalary) && person.baseSalary > 0
    && Number.isFinite(person.totalSalary) && person.totalSalary > 0
}

// --- Core: parse Excel rows into normalized records ---

export function buildNormalizedJobGradingData(rows, headers, mapping) {
  if (!rows?.length || !headers?.length || !mapping) return []

  const idx = (key) =>
    Object.prototype.hasOwnProperty.call(mapping, key) ? mapping[key] : undefined

  const roleIdx = idx('role')
  const levelIdx = idx('level')
  const descIdx = idx('description')
  const categoryIdx = idx('category')
  const genderIdx = idx('gender')
  const baseIdx = idx('baseSalary')
  const varIdx = idx('variableComponents')
  const nameIdx = idx('employeeName')
  const totalIdx = idx('totalSalary')

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
      baseSalary: base,
      variableComponents: variable,
      totalSalary: total,
    }
  })
}

// --- Group people by CCNL level → each level is a "band" ---

export function groupByLevel(normalizedData) {
  const companyContext = [...new Set(normalizedData.map((p) => p.category).filter(Boolean))].slice(0, 8).join(' ')

  const map = new Map()

  for (const person of normalizedData) {
    const withHay = { ...person, ...computeHayForPerson(person, { companyContext }) }
    const levelKey = normalizeLevelLabel(person.level) || 'N/D'
    if (!map.has(levelKey)) {
      map.set(levelKey, {
        level: levelKey,
        sortOrder: levelSortOrder(person.level),
        people: [],
      })
    }
    map.get(levelKey).people.push(withHay)
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

    const hayMap = new Map()
    for (const p of g.people) {
      const bucket = haySubBandFromScore(p.hayTotalScore)
      if (!hayMap.has(bucket.key)) {
        hayMap.set(bucket.key, {
          ...bucket,
          people: [],
        })
      }
      hayMap.get(bucket.key).people.push(p)
    }

    const hayBands = Array.from(hayMap.values())
      .sort((a, b) => b.min - a.min)
      .map((hb, idx) => {
        const valid = hb.people.filter(isValidSalary)
        const salaries = valid.map((p) => p.totalSalary)
        const avgBandSalary = mean(salaries)
        const maleSalaries = valid.filter((p) => p.gender === 'M').map((p) => p.totalSalary)
        const femaleSalaries = valid.filter((p) => p.gender === 'F').map((p) => p.totalSalary)
        const maleAvg = mean(maleSalaries)
        const femaleAvg = mean(femaleSalaries)

        const people = hb.people.map((p) => ({
          ...p,
          haySubBand: hb.key,
          deviationFromHayBandMeanPct: avgBandSalary
            ? ((p.totalSalary - avgBandSalary) / avgBandSalary) * 100
            : 0,
        }))

        return {
          id: `H${idx + 1}`,
          label: `${hb.min}-${hb.max}`,
          minScore: hb.min,
          maxScore: hb.max,
          n: hb.people.length,
          nValid: valid.length,
          avgTotalSalary: avgBandSalary,
          avgHayResponsibility: mean(hb.people.map((p) => p.hayResponsibility)),
          avgHayProblemSolving: mean(hb.people.map((p) => p.hayProblemSolving)),
          avgHayRequiredSkills: mean(hb.people.map((p) => p.hayRequiredSkills)),
          avgHayWorkingConditions: mean(hb.people.map((p) => p.hayWorkingConditions)),
          avgHayTotalScore: mean(hb.people.map((p) => p.hayTotalScore)),
          genderPayGapPct: pctGap(maleAvg, femaleAvg),
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
