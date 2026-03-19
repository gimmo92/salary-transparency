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

function median(arr) {
  if (!arr.length) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
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
      baseSalary: base,
      variableComponents: variable,
      totalSalary: total,
    }
  })
}

// --- Group people by CCNL level → each level is a "band" ---

export function groupByLevel(normalizedData) {
  const map = new Map()

  for (const person of normalizedData) {
    const levelKey = normalizeLevelLabel(person.level) || 'N/D'
    if (!map.has(levelKey)) {
      map.set(levelKey, {
        level: levelKey,
        sortOrder: levelSortOrder(person.level),
        people: [],
      })
    }
    map.get(levelKey).people.push(person)
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
    const medianSalary = median(totalSals)
    const roles = [...new Set(g.people.map((p) => p.role).filter(Boolean))]

    return {
      level: g.level,
      band: g.band,
      sortOrder: g.sortOrder,
      roles,
      n: g.people.length,
      nValid: n,
      avgBaseSalary: n ? totalBase / n : 0,
      avgVariableComponents: n ? totalVar / n : 0,
      avgTotalSalary: n ? totalSals.reduce((a, b) => a + b, 0) / n : 0,
      medianTotalSalary: medianSalary,
      people: g.people,
    }
  })
}

// --- Compute deviation of each band from overall median ---

export function enrichWithDeviation(bands) {
  if (!bands.length) return []

  const allMedians = bands.filter((b) => b.nValid > 0).map((b) => b.medianTotalSalary)
  const overallMedian = median(allMedians)

  return bands.map((b) => {
    const val = b.medianTotalSalary || 0
    const deviationPct = overallMedian ? ((val - overallMedian) / overallMedian) * 100 : 0

    const people = b.people.map((p) => ({
      ...p,
      deviationFromLevelMedianPct: b.medianTotalSalary
        ? ((p.totalSalary - b.medianTotalSalary) / b.medianTotalSalary) * 100
        : 0,
    }))

    return {
      ...b,
      overallMedian,
      deviationFromOverallMedianPct: deviationPct,
      people,
    }
  })
}
