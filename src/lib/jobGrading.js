export const JOB_GRADING_ROLES = {
  baseSalary: 'retribuzione_base',
  variableComponents: 'componenti_variabili',
  totalSalary: 'retribuzione_totale',
  role: 'ruolo',
  level: 'livello_inquadramento',
  description: 'job_description',
  employeeName: 'nome_dipendente',
}

export const JOB_GRADING_ROLE_LABELS = {
  [JOB_GRADING_ROLES.baseSalary]: 'Retribuzione base',
  [JOB_GRADING_ROLES.variableComponents]: 'Componenti variabili',
  [JOB_GRADING_ROLES.totalSalary]: 'Retribuzione totale',
  [JOB_GRADING_ROLES.role]: 'Ruolo',
  [JOB_GRADING_ROLES.level]: 'Livello di inquadramento',
  [JOB_GRADING_ROLES.description]: 'Job description',
  [JOB_GRADING_ROLES.employeeName]: 'Nome / Cognome',
}

export function getJobGradingRoleLabel(role) {
  return JOB_GRADING_ROLE_LABELS[role] || role
}

export function detectJobGradingColumnsHeuristic(headers) {
  const suggestions = {}
  const norm = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ')
  const h = headers.map((x) => norm(x))
  const idx = (re) => h.findIndex((x) => re.test(x))

  const roleIdx = idx(/(^| )ruolo($| )|mansione|job title|position/)
  const levelIdx = idx(/livello|inquadramento|grade|classification|qualifica/)
  const descIdx = idx(/job description|descrizione|attivit|responsabil|task/)
  const baseIdx = idx(/sal\.?\s*ingresso|retribuzione base|stipendio base|minimo ccnl|base salary/)
  const varIdx = idx(/tot\s*comp\s*variab|componenti?\s*variabili|bonus|mbo|pdr|premi|incentiv/)
  const totalIdx = idx(/totale retribuzione|costo totale|retribuzione totale|ral|compensation total/)
  const nameIdx = idx(/dipendente|nome\s*(e\s*)?cognome|cognome|nominativo|employee|full\s*name|worker/)

  if (nameIdx >= 0) suggestions[JOB_GRADING_ROLES.employeeName] = nameIdx
  if (roleIdx >= 0) suggestions[JOB_GRADING_ROLES.role] = roleIdx
  if (levelIdx >= 0) suggestions[JOB_GRADING_ROLES.level] = levelIdx
  if (descIdx >= 0) suggestions[JOB_GRADING_ROLES.description] = descIdx
  if (baseIdx >= 0) suggestions[JOB_GRADING_ROLES.baseSalary] = baseIdx
  if (varIdx >= 0) suggestions[JOB_GRADING_ROLES.variableComponents] = varIdx
  if (totalIdx >= 0) suggestions[JOB_GRADING_ROLES.totalSalary] = totalIdx

  return suggestions
}

export function buildNormalizedJobGradingData(rows, headers, mapping) {
  const roleToKey = {}
  Object.entries(mapping).forEach(([role, colIndex]) => {
    if (typeof colIndex === 'number' && colIndex >= 0 && headers[colIndex] != null)
      roleToKey[role] = headers[colIndex]
  })

  const parseNum = (v) => {
    if (v == null) return null
    const raw = String(v).trim()
    if (!raw || raw === '-' || raw.toLowerCase() === 'n/a') return null
    const cleaned = raw.replace(/\s/g, '').replace(/[^\d,.-]/g, '')
    if (!cleaned || cleaned === '-' || cleaned === '.' || cleaned === ',') return null
    const hasComma = cleaned.includes(',')
    const hasDot = cleaned.includes('.')
    let normalized = cleaned
    if (hasComma && hasDot) normalized = cleaned.replace(/\./g, '').replace(',', '.')
    else if (hasComma) normalized = cleaned.replace(',', '.')
    else if (hasDot) {
      const thousandPattern = /^\d{1,3}(\.\d{3})+$/
      normalized = thousandPattern.test(cleaned) ? cleaned.replace(/\./g, '') : cleaned
    }
    const n = parseFloat(normalized)
    return Number.isFinite(n) ? n : null
  }

  const text = (v) => String(v ?? '').trim()

  return rows
    .map((row) => {
      const role = text(row[roleToKey[JOB_GRADING_ROLES.role]])
      const level = text(row[roleToKey[JOB_GRADING_ROLES.level]])
      const description = text(row[roleToKey[JOB_GRADING_ROLES.description]])
      const employeeName = text(row[roleToKey[JOB_GRADING_ROLES.employeeName]])
      const baseSalary = parseNum(row[roleToKey[JOB_GRADING_ROLES.baseSalary]])
      const variableComponents = parseNum(row[roleToKey[JOB_GRADING_ROLES.variableComponents]])
      const totalSalary = parseNum(row[roleToKey[JOB_GRADING_ROLES.totalSalary]])
      return {
        role,
        level,
        description,
        employeeName,
        baseSalary,
        variableComponents,
        totalSalary: totalSalary ?? ((baseSalary ?? 0) + (variableComponents ?? 0)),
      }
    })
    .filter((r) => r.role || r.level || r.description)
}

export function aggregateRolesForGrading(normalizedRows) {
  const map = new Map()
  for (const row of normalizedRows) {
    const key = row.role || `${row.level || ''} - ${row.description.slice(0, 40)}`
    if (!map.has(key)) {
      map.set(key, {
        role: row.role || 'Ruolo non specificato',
        level: row.level || '',
        description: row.description || '',
        _base: [],
        _var: [],
        _total: [],
        people: [],
        count: 0,
      })
    }
    const item = map.get(key)
    item.count += 1
    if (Number.isFinite(row.baseSalary)) item._base.push(row.baseSalary)
    if (Number.isFinite(row.variableComponents)) item._var.push(row.variableComponents)
    if (Number.isFinite(row.totalSalary)) item._total.push(row.totalSalary)
    if (!item.description && row.description) item.description = row.description
    if (!item.level && row.level) item.level = row.level
    item.people.push({
      name: row.employeeName || '',
      baseSalary: row.baseSalary,
      variableComponents: row.variableComponents,
      totalSalary: row.totalSalary,
    })
  }

  const avg = (arr) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null
  return [...map.values()].map((r) => {
    const avgTotal = avg(r._total)
    const people = r.people.map((p, i) => ({
      index: i + 1,
      name: p.name,
      baseSalary: p.baseSalary,
      variableComponents: p.variableComponents,
      totalSalary: p.totalSalary,
      deviationFromRoleAvgPct: (avgTotal && Number.isFinite(p.totalSalary))
        ? ((p.totalSalary - avgTotal) / avgTotal) * 100
        : null,
    }))
    return {
      role: r.role,
      level: r.level,
      description: r.description,
      n: r.count,
      avgBaseSalary: avg(r._base),
      avgVariableComponents: avg(r._var),
      avgTotalSalary: avgTotal,
      people,
    }
  })
}

export function enrichWithBandsAndDeviation(scoredRoles) {
  if (!scoredRoles.length) return []
  const sorted = [...scoredRoles].sort((a, b) => (b.totalScore ?? 0) - (a.totalScore ?? 0))
  const size = Math.ceil(sorted.length / 5)
  const out = sorted.map((r, idx) => ({
    ...r,
    band: Math.min(5, Math.floor(idx / size) + 1),
  }))

  for (let band = 1; band <= 5; band++) {
    const group = out.filter((x) => x.band === band)
    const avgBand = group.length
      ? group.reduce((s, x) => s + (x.avgTotalSalary ?? 0), 0) / group.length
      : null
    group.forEach((x) => {
      x.bandAverageTotalSalary = avgBand
      x.deviationFromBandAvgPct = (avgBand && Number.isFinite(x.avgTotalSalary))
        ? ((x.avgTotalSalary - avgBand) / avgBand) * 100
        : null
    })
  }
  return out
}

