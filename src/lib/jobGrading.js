import { COLUMN_ROLES } from './excel.js'

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

function parseSeniorityDisplay(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  const s = String(value).trim()
  return s || null
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
      const roleHayTotal = mean(people.map((p) => p.hayTotalScore))

      return {
        role: r.role,
        people,
        n: people.length,
        nValid: validPeople.length,
        avgTotalSalary: mean(validPeople.map((p) => p.totalSalary)),
        avgHayResponsibility: mean(people.map((p) => p.hayResponsibility)),
        avgHayProblemSolving: mean(people.map((p) => p.hayProblemSolving)),
        avgHayRequiredSkills: mean(people.map((p) => p.hayRequiredSkills)),
        avgHayWorkingConditions: mean(people.map((p) => p.hayWorkingConditions)),
        avgHayTotalScore: roleHayTotal,
        avgSalaryMen: avgMen,
        avgSalaryWomen: avgWomen,
        nMen: maleSalaries.length,
        nWomen: femaleSalaries.length,
        genderPayGapPct: (maleSalaries.length > 0 && femaleSalaries.length > 0)
          ? pctGap(avgMen, avgWomen)
          : null,
      }
    })

    // 2) Group ROLES by Hay interval (20 points)
    const hayMap = new Map()
    for (const roleProfile of roleProfiles) {
      const bucket = haySubBandFromScore(roleProfile.avgHayTotalScore)
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

        return {
          id: `Fascia ${idx + 1}`,
          label: `${hb.min}-${hb.max}`,
          minScore: hb.min,
          maxScore: hb.max,
          n: people.length,
          nValid: valid.length,
          nRoles: hb.roles.length,
          roles,
          avgTotalSalary: avgBandSalary,
          avgHayResponsibility: mean(hb.roles.map((r) => r.avgHayResponsibility)),
          avgHayProblemSolving: mean(hb.roles.map((r) => r.avgHayProblemSolving)),
          avgHayRequiredSkills: mean(hb.roles.map((r) => r.avgHayRequiredSkills)),
          avgHayWorkingConditions: mean(hb.roles.map((r) => r.avgHayWorkingConditions)),
          avgHayTotalScore: mean(hb.roles.map((r) => r.avgHayTotalScore)),
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
