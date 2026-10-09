import { buildNormalizedData } from './excel.js'
import { buildNormalizedJobGradingData, groupByLevel, enrichWithDeviation } from './jobGrading.js'
import { mean, pctGap } from './indicators.js'

export const SNAPSHOT_VERSION = 2

function validPeople(people) {
  return (people || []).filter(
    (p) => Number.isFinite(p?.totalSalary) && p.totalSalary > 0 && Number.isFinite(p?.baseSalary) && p.baseSalary > 0,
  )
}

function avgOf(people, field) {
  return mean(validPeople(people).map((p) => p[field]))
}

export function payKpis(people) {
  const valid = validPeople(people)
  const men = valid.filter((p) => p.gender === 'M')
  const women = valid.filter((p) => p.gender === 'F')
  const avgMen = avgOf(men, 'totalSalary')
  const avgWomen = avgOf(women, 'totalSalary')
  const medMen = medianOf(men)
  const medWomen = medianOf(women)
  return {
    n: valid.length,
    nMen: men.length,
    nWomen: women.length,
    avgTotal: avgOf(valid, 'totalSalary'),
    avgBase: avgOf(valid, 'baseSalary'),
    avgVar: avgOf(valid, 'variableComponents'),
    avgMen,
    avgWomen,
    gapMean: men.length && women.length ? pctGap(avgMen, avgWomen) : null,
    gapMedian: men.length && women.length ? pctGap(medMen, medWomen) : null,
    gapBase: men.length && women.length ? pctGap(avgOf(men, 'baseSalary'), avgOf(women, 'baseSalary')) : null,
  }
}

function medianOf(people) {
  const arr = validPeople(people)
    .map((p) => p.totalSalary)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b)
  if (!arr.length) return 0
  const mid = Math.floor(arr.length / 2)
  return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid]
}

function bandStats(hay) {
  const people = hay?.people || []
  const valid = validPeople(people)
  const men = valid.filter((p) => p.gender === 'M')
  const women = valid.filter((p) => p.gender === 'F')
  return {
    n: valid.length,
    nMen: men.length,
    nWomen: women.length,
    avgTotal: Number.isFinite(hay?.avgTotalSalary) ? hay.avgTotalSalary : avgOf(valid, 'totalSalary'),
    avgBase: avgOf(valid, 'baseSalary'),
    avgVar: avgOf(valid, 'variableComponents'),
    avgMen: Number.isFinite(hay?.avgSalaryMen) ? hay.avgSalaryMen : avgOf(men, 'totalSalary'),
    avgWomen: Number.isFinite(hay?.avgSalaryWomen) ? hay.avgSalaryWomen : avgOf(women, 'totalSalary'),
    gapPct:
      hay?.genderPayGapPct != null
        ? hay.genderPayGapPct
        : men.length && women.length
          ? pctGap(avgOf(men, 'totalSalary'), avgOf(women, 'totalSalary'))
          : null,
  }
}

export function collectPeople(jobResults) {
  const people = []
  const seen = new Set()
  for (const level of jobResults || []) {
    for (const p of level.people || []) {
      const key = p?.index ?? `${level.level}:${people.length}`
      if (seen.has(key)) continue
      seen.add(key)
      people.push(p)
    }
  }
  return people
}

/** Istantanea compatta: organico, gap e medie di livello/fascia. Senza le righe duplicate del job grading. */
export function buildAnalysisSnapshot({ jobResults }) {
  const people = collectPeople(jobResults)
  const company = payKpis(people)
  const levels = (jobResults || []).map((level) => {
    const stats = payKpis(level.people || [])
    return {
      level: level.level,
      n: level.nValid ?? stats.n,
      avgTotal: level.avgTotalSalary ?? stats.avgTotal,
      avgBase: level.avgBaseSalary ?? stats.avgBase,
      avgVar: level.avgVariableComponents ?? stats.avgVar,
      nMen: stats.nMen,
      nWomen: stats.nWomen,
      gapPct: stats.gapMean,
    }
  })
  const bands = []
  for (const level of jobResults || []) {
    for (const hb of level.hayBands || []) {
      bands.push({
        level: level.level,
        fasciaId: hb.id,
        fasciaLabel: hb.label,
        score: hb.minScore,
        ...bandStats(hb),
      })
    }
  }
  return {
    version: SNAPSHOT_VERSION,
    ...company,
    levels,
    bands,
  }
}

export function gradePeople(people, overrides = {}) {
  if (!people?.length) return []
  return enrichWithDeviation(groupByLevel(people, overrides))
}

export function peopleFromSource({ rows, headers, mapping, overrides = {} }) {
  const normalizedJob = buildNormalizedJobGradingData(rows, headers, mapping)
  const normalizedGender = buildNormalizedData(rows, headers, mapping)
  const genderByIndex = new Map(normalizedGender.map((x) => [x.index, x.gender]))
  const people = normalizedJob.map((p) => ({
    ...p,
    gender: p.gender || genderByIndex.get(p.index) || null,
  }))
  return {
    people,
    genderRows: normalizedGender,
    jobResults: gradePeople(people, overrides),
  }
}

export function snapshotFromSource({ rows, headers, mapping, overrides = {} }) {
  const { jobResults } = peopleFromSource({ rows, headers, mapping, overrides })
  return buildAnalysisSnapshot({ jobResults })
}

export function snapshotFromStoredRecord(record) {
  if (!record) return null
  const hasRows =
    Array.isArray(record.rows_json) &&
    record.rows_json.length > 0 &&
    Array.isArray(record.headers_json) &&
    record.headers_json.length > 0 &&
    record.mapping_json &&
    Object.keys(record.mapping_json).length > 0
  if (hasRows) {
    try {
      return snapshotFromSource({
        rows: record.rows_json,
        headers: record.headers_json,
        mapping: record.mapping_json,
        overrides: record.overrides_json || {},
      })
    } catch {
      // si ricade sullo snapshot o sui risultati già salvati
    }
  }
  if (record.snapshot_json?.bands) return record.snapshot_json
  const results = record.results_json || {}
  if (Array.isArray(results.jobGrading) && results.jobGrading.length) {
    return buildAnalysisSnapshot({ jobResults: results.jobGrading })
  }
  return null
}

export function needsSnapshotUpgrade(record) {
  const snap = record?.snapshot_json
  if (!snap || snap.version !== SNAPSHOT_VERSION || !Array.isArray(snap.bands)) return true
  return false
}

export function sourceLabel(record) {
  const raw = String(record?.source_url || '').trim()
  if (!raw) return 'Analisi'
  if (raw.startsWith('file:')) return raw.slice(5) || 'File locale'
  try {
    const last = new URL(raw).pathname.split('/').filter(Boolean).pop()
    return decodeURIComponent(last || raw)
  } catch {
    return raw
  }
}

function roundKey(level, score) {
  return `${level}::${score ?? ''}`
}

/**
 * Serie temporale per la tab di analisi storico.
 * I punti sono in ordine cronologico. Le colonne fascia/livello coprono gli ultimi `maxPoints`.
 */
export function buildHistoryView(records, { maxPoints = 8 } = {}) {
  const points = (records || [])
    .filter((r) => r?.snapshot_json && Array.isArray(r.snapshot_json.bands))
    .map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      label: sourceLabel(r),
      snapshot: r.snapshot_json,
    }))
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))

  const shown = points.slice(-maxPoints)
  const hiddenCount = Math.max(0, points.length - shown.length)

  const levelMeta = new Map()
  const bandMeta = new Map()
  for (const p of shown) {
    for (const level of p.snapshot.levels || []) {
      const key = String(level.level)
      if (!levelMeta.has(key)) levelMeta.set(key, { level: level.level })
    }
    for (const band of p.snapshot.bands || []) {
      const key = roundKey(band.level, band.score)
      if (!bandMeta.has(key)) {
        bandMeta.set(key, {
          key,
          level: band.level,
          score: band.score,
          fasciaLabel: band.fasciaLabel,
        })
      }
    }
  }

  const levels = [...levelMeta.values()].map((meta) => ({
    ...meta,
    cells: shown.map((p) => (p.snapshot.levels || []).find((l) => l.level === meta.level) || null),
  }))

  const bands = [...bandMeta.values()]
    .sort((a, b) => String(a.level).localeCompare(String(b.level), 'it') || (b.score || 0) - (a.score || 0))
    .map((meta) => ({
      ...meta,
      cells: shown.map(
        (p) =>
          (p.snapshot.bands || []).find((b) => b.level === meta.level && b.score === meta.score) || null,
      ),
    }))

  const latest = points[points.length - 1] || null
  const previous = points.length > 1 ? points[points.length - 2] : null

  return {
    points,
    shown,
    hiddenCount,
    levels,
    bands,
    latest,
    previous,
  }
}
