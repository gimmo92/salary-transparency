/**
 * Calcoli per la Global Gender Pay Transparency Dashboard
 * Riferimento: Direttiva UE 2023/970
 */
import { mean, median, pctGap } from './indicators.js'
import {
  metricFromMode,
  salaryFieldKey,
  gapVerificationStatus,
  computeGapDecomposition,
  hasInsufficientGenderSample,
  MIN_GENDER_SAMPLE_PER_GROUP,
} from './compensation.js'

export const EU_GAP_THRESHOLD_PCT = 5
/** Massimo outlier retributivi mostrati (ordinati per |scostamento| decrescente) */
export const MAX_QUARTILE_OUTLIERS = 50

/** @deprecated usa salaryFieldKey(metricFromMode(mode), normalized) */
export function salaryFieldForMode(mode, normalized = true) {
  return salaryFieldKey(metricFromMode(mode), normalized)
}

/** Verde <4%, giallo 4–5%, rosso >5% (valore assoluto) */
export function gapSeverityClass(pct) {
  if (pct == null || !Number.isFinite(pct)) return 'gap-severity-na'
  const a = Math.abs(pct)
  if (a < 4) return 'gap-severity-green'
  if (a <= EU_GAP_THRESHOLD_PCT) return 'gap-severity-yellow'
  return 'gap-severity-red'
}

export function verificationStatusClass(status) {
  if (status === 'green') return 'gap-severity-green'
  if (status === 'yellow') return 'gap-severity-yellow'
  if (status === 'red') return 'gap-severity-red'
  return 'gap-severity-na'
}

function percentileSorted(sortedArr, p) {
  const n = sortedArr.length
  if (!n) return 0
  const idx = (n - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sortedArr[lo]
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo)
}

/**
 * Outlier retributivi: dipendenti la cui retribuzione si scosta di oltre il 5%
 * dalla media generale.
 * @returns {{ rows: Array, total: number, truncated: boolean }}
 */
export function computeQuartileOutliers(normalized, salaryMode, normalizedFte = true) {
  const empty = { rows: [], total: 0, truncated: false }
  const field = salaryFieldKey(metricFromMode(salaryMode), normalizedFte)
  const norm = (normalized || []).filter(
    (r) => (r.gender === 'M' || r.gender === 'F') && validSalary(r, field),
  )
  if (norm.length < 2) return empty

  const avg = norm.reduce((s, r) => s + r[field], 0) / norm.length

  const sortedBySalary = [...norm].sort((a, b) => a[field] - b[field])
  const len = sortedBySalary.length
  const qSize = Math.ceil(len / 4) || 1
  const quartileOf = (r) => {
    const pos = sortedBySalary.indexOf(r)
    return Math.min(4, Math.floor(pos / qSize) + 1)
  }

  const outliers = []
  for (const r of norm) {
    const v = r[field]
    const dev = ((v - avg) / avg) * 100
    if (Math.abs(dev) > 5) {
      const q = quartileOf(r)
      const sign = dev > 0 ? '+' : ''
      outliers.push({
        index: r.index,
        name: r.name,
        gender: r.gender,
        salary: v,
        quartile: q,
        deviationPct: Math.round(dev * 100) / 100,
        reason: `${sign}${dev.toFixed(1)}% dalla media (${Math.round(avg).toLocaleString('it-IT')})`,
      })
    }
  }

  const ranked = outliers.sort((a, b) => Math.abs(b.deviationPct) - Math.abs(a.deviationPct))
  const total = ranked.length
  return {
    rows: ranked.slice(0, MAX_QUARTILE_OUTLIERS),
    total,
    truncated: total > MAX_QUARTILE_OUTLIERS,
  }
}

function normByIndexMap(normalized) {
  return new Map((normalized || []).map((r) => [r.index, r]))
}

function validSalary(r, field) {
  const v = r[field]
  return Number.isFinite(v) && v > 0
}

/**
 * @param {Array} normalized - output buildNormalizedData (M/F)
 * @param {Array} jobResults - output enrichWithDeviation(groupByLevel(...))
 * @param {'base'|'level'|'total'} salaryMode
 * @param {{ normalized?: boolean, hasFasciaJustification?: (sub: object) => boolean }} [options]
 */
export function computeEuGenderDashboard(normalized, jobResults, salaryMode, options = {}) {
  const normalizedFte = options.normalized !== false
  const hasJustification = options.hasFasciaJustification || (() => false)
  const field = salaryFieldKey(metricFromMode(salaryMode), normalizedFte)
  const norm = normalized || []
  const jr = jobResults || []

  const males = norm.filter((r) => r.gender === 'M' && validSalary(r, field))
  const females = norm.filter((r) => r.gender === 'F' && validSalary(r, field))
  const mVals = males.map((r) => r[field])
  const fVals = females.map((r) => r[field])

  const gapMean =
    mVals.length && fVals.length ? pctGap(mean(mVals), mean(fVals)) : null
  const gapMedian =
    mVals.length && fVals.length ? pctGap(median(mVals), median(fVals)) : null

  const gapDecomposition = computeGapDecomposition(males, females, field)

  // b) Divario medio componente variabile (individuale + strutturale variabile)
  const mVar = males.filter((r) => Number.isFinite(r.variableComponents)).map((r) => r.variableComponents)
  const fVar = females.filter((r) => Number.isFinite(r.variableComponents)).map((r) => r.variableComponents)
  const gapVarMean =
    mVar.length && fVar.length ? pctGap(mean(mVar), mean(fVar)) : null

  // d) Divario mediano componente variabile
  const gapVarMedian =
    mVar.length && fVar.length ? pctGap(median(mVar), median(fVar)) : null

  // e) % lavoratori U/D che ricevono componenti variabili
  const allM = norm.filter((r) => r.gender === 'M')
  const allF = norm.filter((r) => r.gender === 'F')
  const mWithVar = allM.filter((r) => Number.isFinite(r.variableComponents) && r.variableComponents > 0).length
  const fWithVar = allF.filter((r) => Number.isFinite(r.variableComponents) && r.variableComponents > 0).length
  const pctMenWithVar = allM.length > 0 ? (mWithVar / allM.length) * 100 : null
  const pctWomenWithVar = allF.length > 0 ? (fWithVar / allF.length) * 100 : null

  const quartiles = [1, 2, 3, 4].map((quartile) => ({
    quartile,
    maschile: 0,
    femminile: 0,
    totale: 0,
    avgMaschile: null,
    avgFemminile: null,
    barPctM: 0,
    barPctF: 0,
    gapPct: null,
    insufficientSample: false,
  }))

  const sortedForQ = norm.filter((r) => validSalary(r, field)).sort((a, b) => a[field] - b[field])
  const lenQ = sortedForQ.length
  if (lenQ > 0) {
    const qSize = Math.ceil(lenQ / 4) || 1
    sortedForQ.forEach((r, idx) => {
      const qIndex = Math.min(3, Math.floor(idx / qSize))
      const bucket = quartiles[qIndex]
      bucket.totale += 1
      const sal = r[field]
      if (r.gender === 'M') {
        bucket.maschile += 1
        bucket._mSum = (bucket._mSum || 0) + sal
      } else if (r.gender === 'F') {
        bucket.femminile += 1
        bucket._fSum = (bucket._fSum || 0) + sal
      }
    })
    quartiles.forEach((q) => {
      q.avgMaschile = q.maschile > 0 ? (q._mSum || 0) / q.maschile : null
      q.avgFemminile = q.femminile > 0 ? (q._fSum || 0) / q.femminile : null
      delete q._mSum
      delete q._fSum
      q.insufficientSample = hasInsufficientGenderSample(q.maschile, q.femminile)
      const maxAvg = Math.max(q.avgMaschile ?? 0, q.avgFemminile ?? 0)
      if (maxAvg > 0) {
        q.barPctM = q.avgMaschile != null ? (q.avgMaschile / maxAvg) * 100 : 0
        q.barPctF = q.avgFemminile != null ? (q.avgFemminile / maxAvg) * 100 : 0
      }
      if (q.insufficientSample) {
        q.gapPct = null
      } else if (
        q.avgMaschile != null &&
        q.avgFemminile != null &&
        Number.isFinite(q.avgMaschile) &&
        Number.isFinite(q.avgFemminile) &&
        q.avgMaschile > 0
      ) {
        q.gapPct = pctGap(q.avgMaschile, q.avgFemminile)
      }
    })
    const totalM = allM.length
    const totalF = allF.length
    quartiles.forEach((q) => {
      q.pctOfTotalM = totalM > 0 ? (q.maschile / totalM) * 100 : null
      q.pctOfTotalF = totalF > 0 ? (q.femminile / totalF) * 100 : null
    })
  }

  const normMap = normByIndexMap(norm)

  const levelRows = []
  for (const band of jr) {
    const withSal = (band.people || [])
      .map((p) => normMap.get(p.index))
      .filter(Boolean)
      .filter((r) => r.gender === 'M' || r.gender === 'F')
      .filter((r) => validSalary(r, field))
    const mP = withSal.filter((r) => r.gender === 'M')
    const fP = withSal.filter((r) => r.gender === 'F')
    const insufficientSample = hasInsufficientGenderSample(mP.length, fP.length)
    const base = {
      band: band.band,
      levelLabel: band.level,
      gap: null,
      segregation: false,
      segregationMsg: '',
      nM: mP.length,
      nF: fP.length,
      insufficientSample,
      verificationStatus: 'insufficient',
    }
    if (!mP.length && !fP.length) {
      levelRows.push({
        ...base,
        segregation: true,
        segregationMsg: 'Nessun dato retributivo valido per questo livello',
      })
      continue
    }
    if (!mP.length || !fP.length) {
      levelRows.push({
        ...base,
        segregation: true,
        segregationMsg: !mP.length
          ? 'Segregazione occupazionale: nel livello sono presenti solo donne'
          : 'Segregazione occupazionale: nel livello sono presenti solo uomini',
      })
      continue
    }
    const gap = insufficientSample
      ? null
      : pctGap(mean(mP.map((r) => r[field])), mean(fP.map((r) => r[field])))
    levelRows.push({
      ...base,
      gap,
      verificationStatus: gapVerificationStatus(gap, false, mP.length, fP.length),
    })
  }

  const fasciaRows = []
  let bandsComparable = 0
  let bandsAboveThreshold = 0
  let bandsToVerify = 0
  let bandsToFix = 0
  let bandsInsufficientSample = 0
  let budgetEstimate = 0

  for (const band of jr) {
    for (const sub of band.hayBands || []) {
      const people = (sub.people || [])
        .map((p) => normMap.get(p.index))
        .filter(Boolean)
        .filter((r) => r.gender === 'M' || r.gender === 'F')
        .filter((r) => validSalary(r, field))
      const mP = people.filter((r) => r.gender === 'M')
      const fP = people.filter((r) => r.gender === 'F')
      const justified = hasJustification(sub)
      const insufficientSample = hasInsufficientGenderSample(mP.length, fP.length)
      const row = {
        band: band.band,
        levelLabel: band.level,
        fasciaId: sub.id,
        fasciaLabel: sub.label,
        gap: null,
        segregation: false,
        segregationMsg: '',
        nM: mP.length,
        nF: fP.length,
        insufficientSample,
        hasJustification: justified,
        verificationStatus: 'insufficient',
      }
      if (!mP.length || !fP.length) {
        row.segregation = true
        row.segregationMsg = !mP.length
          ? 'Solo donne in fascia: gap M/F non calcolabile'
          : 'Solo uomini in fascia: gap M/F non calcolabile'
        fasciaRows.push(row)
        continue
      }
      if (insufficientSample) {
        bandsInsufficientSample += 1
        row.segregationMsg = `Campione insufficiente (min. ${MIN_GENDER_SAMPLE_PER_GROUP} per genere)`
        fasciaRows.push(row)
        continue
      }
      bandsComparable += 1
      const avgM = mean(mP.map((r) => r[field]))
      const avgF = mean(fP.map((r) => r[field]))
      row.gap = pctGap(avgM, avgF)
      row.verificationStatus = gapVerificationStatus(row.gap, justified, mP.length, fP.length)
      if (Math.abs(row.gap) > EU_GAP_THRESHOLD_PCT) {
        bandsAboveThreshold += 1
        budgetEstimate += Math.max(0, avgM - avgF) * fP.length
        if (row.verificationStatus === 'yellow') bandsToVerify += 1
        if (row.verificationStatus === 'red') bandsToFix += 1
      }
      fasciaRows.push(row)
    }
  }

  const pctFasceSopraSoglia =
    bandsComparable > 0 ? (bandsAboveThreshold / bandsComparable) * 100 : null

  const criticalAlerts = fasciaRows
    .filter((r) => !r.segregation && !r.insufficientSample && r.gap != null && Math.abs(r.gap) > EU_GAP_THRESHOLD_PCT)
    .sort((a, b) => {
      const prio = { red: 0, yellow: 1, green: 2 }
      const pa = prio[a.verificationStatus] ?? 3
      const pb = prio[b.verificationStatus] ?? 3
      if (pa !== pb) return pa - pb
      return Math.abs(b.gap) - Math.abs(a.gap)
    })
    .slice(0, 3)

  return {
    gapMean,
    gapMedian,
    gapVarMean,
    gapVarMedian,
    pctMenWithVar,
    pctWomenWithVar,
    pctFasceSopraSoglia,
    bandsAboveThreshold,
    bandsComparable,
    bandsToVerify,
    bandsToFix,
    bandsInsufficientSample,
    budgetEstimate,
    gapDecomposition,
    nMaschi: males.length,
    nFemmine: females.length,
    nTotaleAnalizzati: males.length + females.length,
    quartiles,
    levelRows,
    fasciaRows,
    criticalAlerts,
    segregationWarnings: fasciaRows.filter((r) => r.segregation),
    normalizedFte,
    salaryField: field,
  }
}
