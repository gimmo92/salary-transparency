// --- 1. Level Hierarchy ---

const LEVEL_MAP = {
  'd2': 20, 'd1': 20, 'd': 20,
  'c3': 40, 'c2': 40, 'c1': 40, 'c': 40,
  'b3': 65, 'b2': 65, 'b1': 65, 'b': 65,
  'as': 85, 'a': 85, 'a1': 85, 'a2': 85,
  'q': 100, 'quadro': 100, 'quadri': 100, 'dirigente': 100, 'dir': 100,
  '1': 100, '2': 85, '3': 65, '4': 40, '5': 20, '6': 20, '7': 20, '8': 20,
}

export function normalizeLevelScore(levelRaw) {
  if (levelRaw == null || levelRaw === '') return 40
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
  return 40
}

// --- 2. Job Families ---

const IT_KEYWORDS = ['it', 'sviluppo', 'sviluppatore', 'ingegnere', 'software', 'developer', 'devops', 'data engineer', 'data scientist', 'cyber', 'cloud', 'sre', 'frontend', 'backend', 'fullstack']
const MANAGER_KEYWORDS = ['manager', 'responsabile', 'head', 'direttore', 'director', 'lead', 'dirigente', 'quadro']

export function getJobFamily(role) {
  if (!role) return 'General'
  const lower = String(role).toLowerCase()
  for (const kw of IT_KEYWORDS) {
    if (lower.includes(kw)) return 'IT / Tech'
  }
  return 'General'
}

export function isManagerRole(role) {
  if (!role) return false
  const lower = String(role).toLowerCase()
  return MANAGER_KEYWORDS.some((kw) => lower.includes(kw))
}

const JOB_FAMILY_MULTIPLIER = {
  'IT / Tech': 1.20,
  'General': 1.00,
}

export function getJobFamilyMultiplier(family) {
  return JOB_FAMILY_MULTIPLIER[family] ?? 1.0
}

// --- 3. Strict Outlier helpers ---

export function isStrictOutlier(person, { isManager = false } = {}) {
  if (isManager) return false
  const ral = person.baseSalary ?? 0
  return ral < 15000 || ral > 150000
}

function median(arr) {
  if (!arr.length) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// --- Core functions ---

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
    const role = roleIdx != null ? row[roleIdx] : null
    return {
      index: index + 1,
      name: nameIdx != null ? row[nameIdx] : null,
      role,
      level: levelRaw,
      levelScore: normalizeLevelScore(levelRaw),
      jobFamily: getJobFamily(role),
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

export function aggregateRolesForGrading(normalizedJob, { filterOutliers = true, strictOutliers = true } = {}) {
  const map = new Map()
  for (const r of normalizedJob) {
    const key = `${r.role || 'N/D'}|${r.level || ''}`
    if (!map.has(key)) {
      map.set(key, {
        role: r.role || 'N/D',
        level: r.level || '',
        levelScore: r.levelScore ?? 40,
        jobFamily: r.jobFamily || 'General',
        description: r.description || '',
        people: [],
      })
    }
    map.get(key).people.push(r)
  }

  return Array.from(map.values()).map((agg) => {
    const manager = isManagerRole(agg.role)
    let validPeople = filterOutliers
      ? agg.people.filter(isValidSalary)
      : agg.people
    if (strictOutliers) {
      validPeople = validPeople.filter((p) => !isStrictOutlier(p, { isManager: manager }))
    }

    const n = validPeople.length
    const totalBase = validPeople.reduce((s, p) => s + p.baseSalary, 0)
    const totalVar = validPeople.reduce((s, p) => s + p.variableComponents, 0)
    const totalSals = validPeople.map((p) => p.totalSalary)
    const medianSalary = median(totalSals)

    return {
      role: agg.role,
      level: agg.level,
      levelScore: agg.levelScore,
      jobFamily: agg.jobFamily,
      jobFamilyMultiplier: getJobFamilyMultiplier(agg.jobFamily),
      description: agg.description,
      n: agg.people.length,
      nValid: n,
      avgBaseSalary: n ? totalBase / n : 0,
      avgVariableComponents: n ? totalVar / n : 0,
      avgTotalSalary: n ? totalSals.reduce((a, b) => a + b, 0) / n : 0,
      medianTotalSalary: medianSalary,
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

  const baseScore = (
    (Number(scores.levelScore) || 0) * wLevel +
    (Number(scores.competenze_richieste) || 0) * wSkills +
    (Number(scores.responsabilita) || 0) * wResp +
    (Number(scores.sforzo_mentale) || 0) * wEffort +
    (Number(scores.condizioni_lavorative) || 0) * wCond
  )

  const multiplier = scores.jobFamilyMultiplier ?? 1.0
  return baseScore * multiplier
}

export function enrichWithBandsAndDeviation(roles, { bandCount = 10, filterOutliers = true, strictOutliers = true, weights } = {}) {
  if (!roles.length) return []

  roles.forEach((r) => {
    r.totalScore = computeWeightedScore(r, weights)
  })

  const sorted = [...roles].sort((a, b) => b.totalScore - a.totalScore)

  const n = sorted.length
  const perBand = Math.max(1, Math.ceil(n / bandCount))
  sorted.forEach((r, i) => {
    r.band = Math.min(bandCount, Math.floor(i / perBand) + 1)
  })

  const maxBand = Math.max(...sorted.map((r) => r.band))
  for (let b = 1; b <= maxBand; b++) {
    const inBand = sorted.filter((x) => x.band === b)
    const validInBand = filterOutliers
      ? inBand.filter((x) => x.nValid > 0)
      : inBand
    const medianVals = validInBand.map((x) => Number(x.medianTotalSalary) || 0)
    const bandMedian = median(medianVals)
    inBand.forEach((r) => {
      r.bandMedianSalary = bandMedian
      const val = Number(r.medianTotalSalary) || 0
      r.deviationFromBandMedianPct = bandMedian ? ((val - bandMedian) / bandMedian) * 100 : 0
    })
  }

  for (const r of sorted) {
    if (r.people && r.people.length > 1) {
      const roleMedian = r.medianTotalSalary || 1
      r.people.forEach((p) => {
        p.deviationFromRoleAvgPct = roleMedian ? ((p.totalSalary - roleMedian) / roleMedian) * 100 : 0
      })
    }
  }

  return sorted
}
