/**
 * Analisi gap M/F per gruppi (livello CCNL, fascia job grading, …).
 */
import { mean, median, pctGap } from './indicators.js'
import { classifyGapStatus, MIN_GENDER_SAMPLE } from './salaryMetrics.js'

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

/**
 * Confronto M/F per livello CCNL (senza fasce di punteggio).
 * @param {Array} jobResults - output groupByLevel + enrichWithDeviation
 * @param {object} options - getSalary, isExcludedFromGap, hasGroupJustification(people)
 */
export function computeCcnlLevelComparison(jobResults, options = {}) {
  const getSalary = options.getSalary
  const isExcludedFromGap = options.isExcludedFromGap || (() => false)
  const hasGroupJustification =
    options.hasGroupJustification || ((people) => people.some((p) => options.isPersonJustified?.(p)))

  const rows = (jobResults || []).map((band) => {
    const rawPeople = band.people || []
    const hasJustification = hasGroupJustification(rawPeople)
    const stats = analyzeGenderPayGap(rawPeople, {
      getSalary,
      isExcludedFromGap,
      hasJustification,
    })
    const people = enrichPeopleWithGenderMeanDeviation(rawPeople, getSalary)
    return {
      levelKey: band.level,
      levelLabel: band.level,
      sortOrder: band.sortOrder ?? band.band ?? 0,
      bandNum: band.band,
      people,
      hasJustification,
      ...stats,
    }
  })

  return rows.sort((a, b) => (b.sortOrder ?? 0) - (a.sortOrder ?? 0))
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
