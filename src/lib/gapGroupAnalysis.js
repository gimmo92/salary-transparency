/**
 * Analisi gap M/F per gruppi (livello CCNL, fascia job grading, …).
 */
import { mean, median, pctGap } from './indicators.js'
import { classifyGapStatus, MIN_GENDER_SAMPLE, EU_GAP_THRESHOLD_PCT } from './salaryMetrics.js'
import { normalizeLevelLabel, levelSortOrder } from './jobGrading.js'

export function gapStatusCssClass(status) {
  if (status === 'red') return 'gap-status-red'
  if (status === 'yellow') return 'gap-status-yellow'
  if (status === 'insufficient') return 'gap-status-insufficient'
  return 'gap-status-green'
}

/**
 * @param {Array} people
 * @param {{
 *   getSalary: (p) => number|null,
 *   isExcludedFromGap?: (p) => boolean,
 *   hasJustification?: boolean,
 * }} options
 */
export function analyzeGenderPayGap(people, options = {}) {
  const getSalary = options.getSalary
  const isExcludedFromGap = options.isExcludedFromGap || (() => false)
  const hasJustification = !!options.hasJustification

  const withSal = (people || []).filter(
    (p) => (p.gender === 'M' || p.gender === 'F') && getSalary?.(p) != null,
  )
  const nM = withSal.filter((p) => p.gender === 'M').length
  const nF = withSal.filter((p) => p.gender === 'F').length
  const nTotal = nM + nF

  const forGap = withSal.filter((p) => !isExcludedFromGap(p))
  const mVals = forGap.filter((p) => p.gender === 'M').map(getSalary)
  const fVals = forGap.filter((p) => p.gender === 'F').map(getSalary)

  const avgM = mVals.length ? mean(mVals) : null
  const avgF = fVals.length ? mean(fVals) : null
  const gapMean = mVals.length && fVals.length ? pctGap(avgM, avgF) : null
  const gapMedian = mVals.length && fVals.length ? pctGap(median(mVals), median(fVals)) : null

  const status = classifyGapStatus(gapMean, { hasJustification, nM, nF })
  const insufficientSample = status === 'insufficient'

  return {
    nM,
    nF,
    nTotal,
    avgM,
    avgF,
    gapMean,
    gapMedian,
    status,
    insufficientSample,
    sampleMsg: insufficientSample
      ? `Campione ridotto, dato non significativo (M=${nM}, F=${nF}; min. ${MIN_GENDER_SAMPLE} per genere)`
      : '',
  }
}

/** Scostamento retributivo vs media di genere nello stesso livello/gruppo. */
export function enrichPeopleWithGenderMeanDeviation(people, getSalary) {
  const men = (people || []).filter((p) => p.gender === 'M' && getSalary(p) != null)
  const women = (people || []).filter((p) => p.gender === 'F' && getSalary(p) != null)
  const avgM = men.length ? mean(men.map(getSalary)) : null
  const avgF = women.length ? mean(women.map(getSalary)) : null

  return (people || []).map((p) => {
    const sal = getSalary?.(p)
    const genderAvg =
      p.gender === 'M' ? avgM : p.gender === 'F' ? avgF : null
    const deviationFromGenderMeanPct =
      sal != null && genderAvg != null && genderAvg > 0
        ? ((sal - genderAvg) / genderAvg) * 100
        : null
    return {
      ...p,
      comparisonSalary: sal,
      deviationFromGenderMeanPct,
    }
  })
}

function buildComparisonRow(groupKey, groupLabel, rawPeople, options = {}) {
  const getSalary = options.getSalary
  const isExcludedFromGap = options.isExcludedFromGap || (() => false)
  const hasGroupJustification =
    options.hasGroupJustification ||
    ((people) => people.some((p) => options.isPersonJustified?.(p)))
  const hasJustification = hasGroupJustification(rawPeople)
  const stats = analyzeGenderPayGap(rawPeople, {
    getSalary,
    isExcludedFromGap,
    hasJustification,
  })
  const people = enrichPeopleWithGenderMeanDeviation(rawPeople, getSalary)
  return {
    groupKey,
    groupLabel,
    people,
    hasJustification,
    ...stats,
  }
}

/**
 * Confronto M/F raggruppato per chiave arbitraria (centro di costo, …).
 */
export function computeGroupedComparison(peopleList, getGroupKey, options = {}) {
  const map = new Map()
  for (const p of peopleList || []) {
    if (p.gender !== 'M' && p.gender !== 'F') continue
    const key = getGroupKey(p)
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(p)
  }
  return Array.from(map.entries())
    .map(([key, rawPeople]) => buildComparisonRow(key, key, rawPeople, options))
    .sort((a, b) => String(a.groupLabel).localeCompare(String(b.groupLabel), 'it'))
}

/**
 * Confronto M/F per centro di costo (campo category nei dati normalizzati).
 */
export function computeCostCenterComparison(normalized, options = {}) {
  return computeGroupedComparison(
    normalized,
    (p) => {
      const s = String(p.category ?? '').trim()
      return s || 'N/D'
    },
    options,
  ).map((row) => ({
    ...row,
    costCenterKey: row.groupKey,
    costCenterLabel: row.groupLabel,
  }))
}

/**
 * Top centri/gruppi per |gap| (campione sufficiente) con peso sul totale aziendale.
 */
export function computeGapHotspots(rows, { topN = 5, thresholdPct = EU_GAP_THRESHOLD_PCT } = {}) {
  const allRows = rows || []
  const companyN = allRows.reduce((s, r) => s + (r.nTotal || 0), 0)
  const eligible = allRows.filter(
    (r) =>
      !r.insufficientSample &&
      r.gapMean != null &&
      Number.isFinite(r.gapMean) &&
      Math.abs(r.gapMean) > thresholdPct,
  )
  eligible.sort((a, b) => Math.abs(b.gapMean) - Math.abs(a.gapMean))
  return eligible.slice(0, topN).map((r, idx) => ({
    rank: idx + 1,
    groupKey: r.costCenterKey ?? r.groupKey ?? r.levelKey,
    groupLabel: r.costCenterLabel ?? r.groupLabel ?? r.levelLabel,
    gapMean: r.gapMean,
    gapMedian: r.gapMedian,
    nTotal: r.nTotal,
    nM: r.nM,
    nF: r.nF,
    status: r.status,
    hasJustification: r.hasJustification,
    headcountWeightPct: companyN > 0 ? ((r.nTotal || 0) / companyN) * 100 : 0,
  }))
}

/** Estrae tutte le persone da jobResults (band per livello). */
export function flattenJobResultsPeople(jobResults) {
  const people = []
  for (const band of jobResults || []) {
    for (const p of band.people || []) people.push(p)
  }
  return people
}

/** Confronto M/F per livello di inquadramento su un sottoinsieme di persone. */
export function computeLevelComparisonFromPeople(peopleList, options = {}) {
  const map = new Map()
  for (const p of peopleList || []) {
    if (p.gender !== 'M' && p.gender !== 'F') continue
    const levelKey = normalizeLevelLabel(p.level) || 'N/D'
    if (!map.has(levelKey)) {
      map.set(levelKey, {
        levelKey,
        sortOrder: levelSortOrder(p.level),
        people: [],
      })
    }
    map.get(levelKey).people.push(p)
  }

  return Array.from(map.values())
    .sort((a, b) => (b.sortOrder ?? 0) - (a.sortOrder ?? 0))
    .map(({ levelKey, sortOrder, people }) => {
      const row = buildComparisonRow(levelKey, levelKey, people, options)
      return {
        ...row,
        levelKey,
        levelLabel: levelKey,
        sortOrder,
      }
    })
}

/**
 * Raggruppa per CCNL (contratto) e, all'interno, analizza gap per livello di inquadramento.
 */
export function computeCcnlGroupedComparison(peopleList, options = {}) {
  const ccnlMap = new Map()
  for (const p of peopleList || []) {
    if (p.gender !== 'M' && p.gender !== 'F') continue
    const ccnlKey = String(p.ccnl ?? '').trim() || 'N/D'
    if (!ccnlMap.has(ccnlKey)) ccnlMap.set(ccnlKey, [])
    ccnlMap.get(ccnlKey).push(p)
  }

  return Array.from(ccnlMap.entries())
    .map(([ccnlKey, people]) => {
      const levels = computeLevelComparisonFromPeople(people, options)
      return {
        ccnlKey,
        ccnlLabel: ccnlKey,
        levels,
        nTotal: levels.reduce((s, r) => s + (r.nTotal || 0), 0),
        nLevels: levels.length,
      }
    })
    .sort((a, b) => String(a.ccnlLabel).localeCompare(String(b.ccnlLabel), 'it'))
}

/** Righe piatte livello×CCNL (label composta se più CCNL). */
export function flattenCcnlLevelRows(groups) {
  const multiCcnl = (groups || []).length > 1
  const rows = []
  for (const g of groups || []) {
    for (const level of g.levels || []) {
      rows.push({
        ...level,
        ccnlKey: g.ccnlKey,
        ccnlLabel: g.ccnlLabel,
        compositeKey: `${g.ccnlKey}::${level.levelKey}`,
        displayLevelLabel: level.levelLabel,
        levelLabel: multiCcnl ? `${g.ccnlLabel} · ${level.levelLabel}` : level.levelLabel,
      })
    }
  }
  return rows
}

/**
 * Confronto M/F per livello CCNL (senza fasce di punteggio).
 * @param {Array} jobResults - output groupByLevel + enrichWithDeviation
 * @param {object} options - getSalary, isExcludedFromGap, hasGroupJustification(people)
 */
export function computeCcnlLevelComparison(jobResults, options = {}) {
  const groups = computeCcnlGroupedComparison(flattenJobResultsPeople(jobResults), options)
  return flattenCcnlLevelRows(groups)
}

export function countGapStatuses(rows, { excludeInsufficient = true } = {}) {
  let toFix = 0
  let toVerify = 0
  for (const r of rows || []) {
    if (excludeInsufficient && r.insufficientSample) continue
    if (r.status === 'red') toFix += 1
    else if (r.status === 'yellow') toVerify += 1
  }
  return { toFix, toVerify }
}
