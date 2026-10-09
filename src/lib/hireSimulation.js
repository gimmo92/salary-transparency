import { enrichEmployeeSalaries, parseSalaryAmount } from './salaryMetrics.js'
import { gradePeople, payKpis } from './analysisSnapshot.js'

function numOrNull(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function buildHypotheticalEmployee(form, existingPeople) {
  const base = parseSalaryAmount(form?.baseSalary)
  if (!(base > 0)) {
    throw new Error('Inserisci una retribuzione base annua valida.')
  }
  const variable = parseSalaryAmount(form?.variableComponents || 0)
  const maxIndex = (existingPeople || []).reduce((m, p) => Math.max(m, Number(p?.index) || 0), 0)
  const partTimeRaw = numOrNull(form?.partTimePct)
  const partTimePct = partTimeRaw != null && partTimeRaw > 0 ? Math.min(100, partTimeRaw) : 100
  const gender = form?.gender === 'M' ? 'M' : form?.gender === 'F' ? 'F' : null
  if (!gender) throw new Error('Seleziona il genere (M o F).')

  return enrichEmployeeSalaries({
    index: maxIndex + 1,
    name: String(form?.name || '').trim() || 'Nuovo dipendente',
    role: String(form?.role || '').trim() || 'Nuovo ruolo',
    level: String(form?.level || '').trim() || 'N/D',
    gender,
    category: null,
    description: '',
    baseSalary: base,
    variableComponents: variable,
    structuralComponents: null,
    individualComponents: null,
    totalSalary: null,
    partTimePct,
    simulated: true,
  })
}

function findRole(jobResults, levelLabel, roleName) {
  const level = (jobResults || []).find((l) => l.level === levelLabel)
  if (!level) return null
  for (const hay of level.hayBands || []) {
    const role = (hay.roles || []).find((r) => r.role === roleName)
    if (role) return { level, hay, role }
  }
  return null
}

function findHay(jobResults, levelLabel, score) {
  const level = (jobResults || []).find((l) => l.level === levelLabel)
  if (!level) return null
  return (level.hayBands || []).find((h) => h.minScore === score) || null
}

function locatePerson(jobResults, index) {
  for (const level of jobResults || []) {
    for (const hay of level.hayBands || []) {
      const person = (hay.people || []).find((p) => p.index === index)
      if (person) return { level, hay, person }
    }
  }
  return null
}

function bandKey(level, score) {
  return `${level}::${score ?? ''}`
}

function flattenBands(jobResults) {
  const map = new Map()
  for (const level of jobResults || []) {
    for (const hay of level.hayBands || []) {
      const people = hay.people || []
      const stats = payKpis(people)
      map.set(bandKey(level.level, hay.minScore), {
        level: level.level,
        score: hay.minScore,
        fasciaId: hay.id,
        fasciaLabel: hay.label,
        n: stats.n,
        nMen: stats.nMen,
        nWomen: stats.nWomen,
        avgTotal: hay.avgTotalSalary,
        avgBase: stats.avgBase,
        avgVar: stats.avgVar,
        avgMen: hay.avgSalaryMen,
        avgWomen: hay.avgSalaryWomen,
        gapPct: hay.genderPayGapPct,
      })
    }
  }
  return map
}

function flattenLevels(jobResults) {
  const map = new Map()
  for (const level of jobResults || []) {
    const stats = payKpis(level.people || [])
    map.set(level.level, {
      level: level.level,
      n: level.nValid ?? stats.n,
      avgTotal: level.avgTotalSalary,
      avgBase: level.avgBaseSalary,
      avgVar: level.avgVariableComponents,
      nMen: stats.nMen,
      nWomen: stats.nWomen,
      gapPct: stats.gapMean,
    })
  }
  return map
}

function changedNumber(a, b) {
  if (a == null && b == null) return false
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a !== b
  return Math.abs(a - b) > 0.5
}

function deviationShifts(beforeHay, afterHay, newIndex) {
  const beforeMap = new Map((beforeHay?.people || []).map((p) => [p.index, p]))
  const shifts = []
  for (const p of afterHay?.people || []) {
    if (p.index === newIndex) continue
    const prev = beforeMap.get(p.index)
    if (!prev) continue
    const beforeDev = Number(prev.deviationFromHayBandMeanPct)
    const afterDev = Number(p.deviationFromHayBandMeanPct)
    if (!Number.isFinite(beforeDev) || !Number.isFinite(afterDev)) continue
    shifts.push({
      index: p.index,
      name: p.name || `Dipendente ${p.index}`,
      role: p.role || '–',
      gender: p.gender || '–',
      totalSalary: p.totalSalary,
      beforeDev,
      afterDev,
      deltaDev: afterDev - beforeDev,
    })
  }
  shifts.sort((a, b) => Math.abs(b.deltaDev) - Math.abs(a.deltaDev))
  return shifts
}

/**
 * Confronta popolazione attuale e popolazione con un dipendente ipotetico.
 * Le fasce seguono il punteggio di grading del ruolo (stessa logica del job grading).
 */
export function simulateHire({ people, overrides = {}, form }) {
  const newbie = buildHypotheticalEmployee(form, people)
  const beforeResults = gradePeople(people, overrides)
  const afterPeople = [...(people || []), newbie]
  const afterResults = gradePeople(afterPeople, overrides)

  const beforeKpi = payKpis(people)
  const afterKpi = payKpis(afterPeople)
  const placed = locatePerson(afterResults, newbie.index)
  const levelLabel = placed?.level?.level || null
  const beforeRole = levelLabel ? findRole(beforeResults, levelLabel, newbie.role) : null
  const afterRole = levelLabel ? findRole(afterResults, levelLabel, newbie.role) : null
  const beforeDestHay = placed ? findHay(beforeResults, placed.level.level, placed.hay.minScore) : null

  const beforeBands = flattenBands(beforeResults)
  const afterBands = flattenBands(afterResults)
  const keys = new Set([...beforeBands.keys(), ...afterBands.keys()])
  const bandRows = [...keys].map((key) => {
    const before = beforeBands.get(key) || null
    const after = afterBands.get(key) || null
    const sample = after || before
    const changed =
      !before ||
      !after ||
      before.n !== after.n ||
      changedNumber(before.avgTotal, after.avgTotal) ||
      changedNumber(before.gapPct, after.gapPct)
    return { key, before, after, changed, level: sample.level, score: sample.score, fasciaLabel: sample.fasciaLabel }
  })

  const beforeLevels = flattenLevels(beforeResults)
  const afterLevels = flattenLevels(afterResults)
  const levelKeys = new Set([...beforeLevels.keys(), ...afterLevels.keys()])
  const levelGroups = [...levelKeys].map((level) => {
    const before = beforeLevels.get(level) || null
    const after = afterLevels.get(level) || null
    const bands = bandRows
      .filter((row) => row.level === level)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
    return {
      level,
      before,
      after,
      bands,
      affected: level === levelLabel || bands.some((b) => b.changed),
      isHireLevel: level === levelLabel,
    }
  })

  const shifts = deviationShifts(beforeDestHay, placed?.hay, newbie.index)

  return {
    employee: {
      ...newbie,
      totalSalary: newbie.totalSalary,
      deviationPct: placed?.person?.deviationFromHayBandMeanPct ?? null,
    },
    beforeKpi,
    afterKpi,
    placement: placed
      ? {
          level: placed.level.level,
          fasciaId: placed.hay.id,
          fasciaLabel: placed.hay.label,
          score: placed.hay.minScore,
          avgTotalBefore: beforeDestHay?.avgTotalSalary ?? null,
          avgTotalAfter: placed.hay.avgTotalSalary,
          avgBaseBefore: beforeDestHay ? payKpis(beforeDestHay.people).avgBase : null,
          avgBaseAfter: payKpis(placed.hay.people).avgBase,
          avgVarBefore: beforeDestHay ? payKpis(beforeDestHay.people).avgVar : null,
          avgVarAfter: payKpis(placed.hay.people).avgVar,
          nBefore: beforeDestHay?.nValid ?? 0,
          nAfter: placed.hay.nValid,
          nMenBefore: beforeDestHay?.nMen ?? 0,
          nMenAfter: placed.hay.nMen,
          nWomenBefore: beforeDestHay?.nWomen ?? 0,
          nWomenAfter: placed.hay.nWomen,
          gapBefore: beforeDestHay?.genderPayGapPct ?? null,
          gapAfter: placed.hay.genderPayGapPct,
          avgMenBefore: beforeDestHay?.avgSalaryMen ?? null,
          avgMenAfter: placed.hay.avgSalaryMen,
          avgWomenBefore: beforeDestHay?.avgSalaryWomen ?? null,
          avgWomenAfter: placed.hay.avgSalaryWomen,
          newFascia: !beforeDestHay,
        }
      : null,
    roleMove: {
      role: newbie.role,
      level: levelLabel,
      beforeScore: beforeRole?.role?.trWeightedScore ?? null,
      afterScore: afterRole?.role?.trWeightedScore ?? null,
      beforeFascia: beforeRole?.hay?.label || null,
      afterFascia: afterRole?.hay?.label || placed?.hay?.label || null,
      moved:
        !!beforeRole &&
        beforeRole.hay?.minScore !== (afterRole?.hay?.minScore ?? placed?.hay?.minScore ?? null),
    },
    levelGroups,
    colleagueShifts: shifts.slice(0, 8),
    colleagueShiftCount: shifts.length,
  }
}
