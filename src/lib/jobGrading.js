const LEVEL_MAP = {
  'q': 100, 'quadro': 100, 'quadri': 100, 'dirigente': 100, 'dir': 100,
  'as': 85, 'a': 85, 'a1': 85, 'a2': 80,
  'b': 70, 'b1': 70, 'b2': 65, 'b3': 60,
  'c': 50, 'c1': 55, 'c2': 50, 'c3': 45,
  'd': 30, 'd1': 35, 'd2': 30, 'd3': 25,
  'e': 15, 'e1': 15, 'e2': 10,
  '1': 100, '2': 85, '3': 70, '4': 55, '5': 40, '6': 30, '7': 20, '8': 15,
}

export function normalizeLevelScore(levelRaw) {
  if (levelRaw == null || levelRaw === '') return 50
  const cleaned = String(levelRaw).trim().toLowerCase()
    .replace(/\s+/g, '')
    .replace(/^livello\s*/i, '')
    .replace(/^liv\.?\s*/i, '')
  if (LEVEL_MAP[cleaned] != null) return LEVEL_MAP[cleaned]
  for (const [key, val] of Object.entries(LEVEL_MAP)) {
    if (cleaned.includes(key)) return val
  }
  const num = Number(cleaned)
  if (Number.isFinite(num) && num >= 0 && num <= 100) return num
  return 50
}

export function buildNormalizedJobGradingData(rows, headers, mapping) {
  if (!rows?.length || !headers?.length || !mapping) return []

  const idx = (key) =>
    Object.prototype.hasOwnProperty.call(mapping, key) ? mapping[key] : undefined

  const roleIdx = idx('role')
  const levelIdx = idx('level')
  const descIdx = idx('description')
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
    return {
      index: index + 1,
      name: nameIdx != null ? row[nameIdx] : null,
      role: roleIdx != null ? row[roleIdx] : null,
      level: levelRaw,
      levelScore: normalizeLevelScore(levelRaw),
      description: descIdx != null ? row[descIdx] : null,
      baseSalary: base,
      variableComponents: variable,
      totalSalary: total,
    }
  })
}

function isValidSalary(person) {
  return Number.isFinite(person.baseSalary) && person.baseSalary > 0
    && Number.isFinite(person.totalSalary) && person.totalSalary > 0
}

export function aggregateRolesForGrading(normalizedJob, { filterOutliers = true } = {}) {
  const map = new Map()
  for (const r of normalizedJob) {
    const key = `${r.role || 'N/D'}|${r.level || ''}`
    if (!map.has(key)) {
      map.set(key, {
        role: r.role || 'N/D',
        level: r.level || '',
        levelScore: r.levelScore ?? 50,
        description: r.description || '',
        people: [],
      })
    }
    map.get(key).people.push(r)
  }

  return Array.from(map.values()).map((agg) => {
    const validPeople = filterOutliers
      ? agg.people.filter(isValidSalary)
      : agg.people

    const n = validPeople.length
    const totalBase = validPeople.reduce((s, p) => s + p.baseSalary, 0)
    const totalVar = validPeople.reduce((s, p) => s + p.variableComponents, 0)
    const totalSal = validPeople.reduce((s, p) => s + p.totalSalary, 0)

    return {
      role: agg.role,
      level: agg.level,
      levelScore: agg.levelScore,
      description: agg.description,
      n: agg.people.length,
      nValid: n,
      avgBaseSalary: n ? totalBase / n : 0,
      avgVariableComponents: n ? totalVar / n : 0,
      avgTotalSalary: n ? totalSal / n : 0,
      people: agg.people,
    }
  })
}

export function computeWeightedScore(scores, weights) {
  const wLevel = (weights?.level ?? 45) / 100
  const wSkills = (weights?.skills ?? 15) / 100
  const wResp = (weights?.responsibility ?? 20) / 100
  const wEffort = (weights?.mentalEffort ?? 10) / 100
  const wCond = (weights?.conditions ?? 10) / 100

  return (
    (Number(scores.levelScore) || 0) * wLevel +
    (Number(scores.competenze_richieste) || 0) * wSkills +
    (Number(scores.responsabilita) || 0) * wResp +
    (Number(scores.sforzo_mentale) || 0) * wEffort +
    (Number(scores.condizioni_lavorative) || 0) * wCond
  )
}

export function enrichWithBandsAndDeviation(roles, { bandWidth = 50, filterOutliers = true, weights } = {}) {
  if (!roles.length) return []

  roles.forEach((r) => {
    r.totalScore = computeWeightedScore(r, weights)
  })

  const sorted = [...roles].sort((a, b) => b.totalScore - a.totalScore)

  const maxScore = sorted[0]?.totalScore || 100
  sorted.forEach((r) => {
    r.band = Math.max(1, Math.ceil((maxScore - r.totalScore + 1) / bandWidth))
  })

  const maxBand = Math.max(...sorted.map((r) => r.band))
  for (let b = 1; b <= maxBand; b++) {
    const inBand = sorted.filter((x) => x.band === b)
    const validInBand = filterOutliers
      ? inBand.filter((x) => x.nValid > 0)
      : inBand
    const avg = validInBand.length
      ? validInBand.reduce((s, x) => s + (Number(x.avgTotalSalary) || 0), 0) / validInBand.length
      : 0
    inBand.forEach((r) => {
      const val = Number(r.avgTotalSalary) || 0
      r.deviationFromBandAvgPct = avg ? ((val - avg) / avg) * 100 : 0
    })
  }

  for (const r of sorted) {
    if (r.people && r.people.length > 1) {
      const roleAvg = r.avgTotalSalary || 1
      r.people.forEach((p) => {
        p.deviationFromRoleAvgPct = roleAvg ? ((p.totalSalary - roleAvg) / roleAvg) * 100 : 0
      })
    }
  }

  return sorted
}
