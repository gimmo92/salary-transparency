export function buildNormalizedJobGradingData(rows, headers, mapping) {
  // For ora riutilizziamo i dati normalizzati di base:
  if (!rows?.length || !headers?.length || !mapping) return []

  const idx = (key) =>
    Object.prototype.hasOwnProperty.call(mapping, key) ? mapping[key] : undefined

  const roleIdx = idx('role')
  const levelIdx = idx('level')
  const descIdx = idx('description')
  const baseIdx = idx('baseSalary')
  const varIdx = idx('variableComponents')

  const parseNumber = (value) => {
    if (value == null || value === '') return 0
    if (typeof value === 'number') return value
    const cleaned = String(value)
      .replace(/\./g, '')
      .replace(/,/g, '.')
      .replace(/[^\d.-]/g, '')
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : 0
  }

  return rows.map((row, index) => ({
    index: index + 1,
    role: roleIdx != null ? row[roleIdx] : null,
    level: levelIdx != null ? row[levelIdx] : null,
    description: descIdx != null ? row[descIdx] : null,
    baseSalary: baseIdx != null ? parseNumber(row[baseIdx]) : 0,
    variableComponents: varIdx != null ? parseNumber(row[varIdx]) : 0,
  }))
}

export function aggregateRolesForGrading(normalizedJob) {
  const map = new Map()
  for (const r of normalizedJob) {
    const key = `${r.role || 'N/D'}|${r.level || ''}`
    if (!map.has(key)) {
      map.set(key, {
        role: r.role || 'N/D',
        level: r.level || '',
        description: r.description || '',
        n: 0,
        totalBase: 0,
        totalVar: 0,
        people: [],
      })
    }
    const agg = map.get(key)
    agg.n += 1
    agg.totalBase += r.baseSalary
    agg.totalVar += r.variableComponents
    agg.people.push(r)
  }

  return Array.from(map.values()).map((agg) => ({
    role: agg.role,
    level: agg.level,
    description: agg.description,
    n: agg.n,
    avgBaseSalary: agg.n ? agg.totalBase / agg.n : 0,
    avgVariableComponents: agg.n ? agg.totalVar / agg.n : 0,
    avgTotalSalary:
      agg.n ? (agg.totalBase + agg.totalVar) / agg.n : 0,
    people: agg.people,
  }))
}

export function enrichWithBandsAndDeviation(roles) {
  if (!roles.length) return []

  const sorted = [...roles].sort(
    (a, b) => (b.totalScore || b.avgTotalSalary) - (a.totalScore || a.avgTotalSalary),
  )
  const n = sorted.length
  const bandSize = Math.ceil(n / 5)

  sorted.forEach((r, i) => {
    r.band = Math.min(5, Math.floor(i / bandSize) + 1)
  })

  for (let b = 1; b <= 5; b++) {
    const inBand = sorted.filter((x) => x.band === b)
    const avg =
      inBand.length &&
      inBand.reduce((s, x) => s + (Number(x.avgTotalSalary) || 0), 0) / inBand.length
    inBand.forEach((r) => {
      const val = Number(r.avgTotalSalary) || 0
      r.deviationFromBandAvgPct = avg ? ((val - avg) / avg) * 100 : 0
    })
  }

  return sorted
}

