/**
 * Calcoli per la Global Gender Pay Transparency Dashboard
 * Riferimento: Direttiva UE 2023/970
 */
import { mean, median, pctGap } from './indicators.js'
import {
  getSalaryFieldName,
  classifyGapStatus,
  computeGapDecomposition,
  gapSampleSufficient,
  EU_GAP_THRESHOLD_PCT,
  MIN_GENDER_SAMPLE,
} from './salaryMetrics.js'

export { EU_GAP_THRESHOLD_PCT }
/** Massimo outlier retributivi mostrati (ordinati per |scostamento| decrescente) */
export const MAX_QUARTILE_OUTLIERS = 50

export function salaryFieldForMode(metric, { fte = true } = {}) {
  return getSalaryFieldName(metric || 'livello', { fte })
}

/** Verde <4%, giallo 4–5%, rosso >5% (valore assoluto) */
export function gapSeverityClass(pct) {
  if (pct == null || !Number.isFinite(pct)) return 'gap-severity-na'
  const a = Math.abs(pct)
  if (a < 4) return 'gap-severity-green'
  if (a <= EU_GAP_THRESHOLD_PCT) return 'gap-severity-yellow'
  return 'gap-severity-red'
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

function validSalary(r, field) {
  const v = r[field]
  return Number.isFinite(v) && v > 0
}

/**
 * Assegna ogni dipendente con retribuzione valida a Q1–Q4 (ordinamento crescente per metrica).
 * @returns {Array<{ quartile: number, people: Array<{ index, name, gender, role, level, salary }> }>}
 */
export function assignSalaryQuartiles(normalized, metric, options = {}) {
  const fte = options.fte !== false
  const field = salaryFieldForMode(metric, { fte })
  const groups = [1, 2, 3, 4].map((quartile) => ({ quartile, people: [] }))
  const sortedForQ = (normalized || [])
    .filter((r) => validSalary(r, field))
    .sort((a, b) => a[field] - b[field])
  const lenQ = sortedForQ.length
  if (lenQ === 0) return groups

  const qSize = Math.ceil(lenQ / 4) || 1
  sortedForQ.forEach((r, idx) => {
    const qIndex = Math.min(3, Math.floor(idx / qSize))
    groups[qIndex].people.push({
      index: r.index,
      name: r.name,
      gender: r.gender,
      role: r.role,
      level: r.level,
      salary: r[field],
    })
  })
  return groups
}

function quartileIndexByPerson(normalized, metric, options = {}) {
  const map = new Map()
  for (const g of assignSalaryQuartiles(normalized, metric, options)) {
    for (const p of g.people) map.set(p.index, g.quartile)
  }
  return map
}

/**
 * Outlier retributivi: dipendenti la cui retribuzione si scosta di oltre il 5%
 * dalla media generale.
 * @returns {{ rows: Array, total: number, truncated: boolean }}
 */
export function computeQuartileOutliers(normalized, metric, options = {}) {
  const fte = options.fte !== false
  const empty = { rows: [], total: 0, truncated: false }
  const field = salaryFieldForMode(metric, { fte })
  const norm = (normalized || []).filter(
    (r) => (r.gender === 'M' || r.gender === 'F') && validSalary(r, field),
  )
  if (norm.length < 2) return empty

  const avg = norm.reduce((s, r) => s + r[field], 0) / norm.length
  const quartileOf = quartileIndexByPerson(normalized, metric, options)

  const outliers = []
  for (const r of norm) {
    const v = r[field]
    const dev = ((v - avg) / avg) * 100
    if (Math.abs(dev) > 5) {
      const q = quartileOf.get(r.index) ?? 1
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

function rowGapStatus(gapPct, nM, nF, hasJustification = false) {
  const status = classifyGapStatus(gapPct, { hasJustification, nM, nF })
  return {
    status,
    insufficientSample: status === 'insufficient',
    sampleMsg:
      status === 'insufficient'
        ? `Campione insufficiente (min. ${MIN_GENDER_SAMPLE} per genere: M=${nM}, F=${nF})`
        : '',
  }
}

/**
 * @param {Array} normalized - output buildNormalizedData (M/F)
 * @param {Array} jobResults - output enrichWithDeviation(groupByLevel(...))
 * @param {string} metric - SALARY_METRICS.*
 * @param {{ fte?: boolean }} [options]
 */
export function computeEuGenderDashboard(normalized, jobResults, metric, options = {}) {
  const fte = options.fte !== false
  const field = salaryFieldForMode(metric, { fte })
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

  const varField = fte ? 'variableComponentsFte' : 'variableComponents'
  const mVar = males.filter((r) => Number.isFinite(r[varField])).map((r) => r[varField])
  const fVar = females.filter((r) => Number.isFinite(r[varField])).map((r) => r[varField])
  const gapVarMean =
    mVar.length && fVar.length ? pctGap(mean(mVar), mean(fVar)) : null
  const gapVarMedian =
    mVar.length && fVar.length ? pctGap(median(mVar), median(fVar)) : null

  const allM = norm.filter((r) => r.gender === 'M')
  const allF = norm.filter((r) => r.gender === 'F')
  const mWithVar = allM.filter((r) => Number.isFinite(r.variableComponents) && r.variableComponents > 0).length
  const fWithVar = allF.filter((r) => Number.isFinite(r.variableComponents) && r.variableComponents > 0).length
  const pctMenWithVar = allM.length > 0 ? (mWithVar / allM.length) * 100 : null
  const pctWomenWithVar = allF.length > 0 ? (fWithVar / allF.length) * 100 : null

  const qGroups = assignSalaryQuartiles(norm, metric, options)
  const quartiles = qGroups.map(({ quartile, people }) => {
    const maschile = people.filter((p) => p.gender === 'M').length
    const femminile = people.filter((p) => p.gender === 'F').length
    const mSalaries = people.filter((p) => p.gender === 'M').map((p) => p.salary)
    const fSalaries = people.filter((p) => p.gender === 'F').map((p) => p.salary)
    const avgMaschile = mSalaries.length ? mean(mSalaries) : null
    const avgFemminile = fSalaries.length ? mean(fSalaries) : null
    const maxAvg = Math.max(avgMaschile ?? 0, avgFemminile ?? 0)
    let gapPct = null
    if (
      avgMaschile != null &&
      avgFemminile != null &&
      Number.isFinite(avgMaschile) &&
      Number.isFinite(avgFemminile) &&
      avgMaschile > 0
    ) {
      gapPct = pctGap(avgMaschile, avgFemminile)
    }
    return {
      quartile,
      maschile,
      femminile,
      totale: people.length,
      avgMaschile,
      avgFemminile,
      barPctM: maxAvg > 0 && avgMaschile != null ? (avgMaschile / maxAvg) * 100 : 0,
      barPctF: maxAvg > 0 && avgFemminile != null ? (avgFemminile / maxAvg) * 100 : 0,
      gapPct,
    }
  })
  const totalM = allM.length
  const totalF = allF.length
  quartiles.forEach((q) => {
    q.pctOfTotalM = totalM > 0 ? (q.maschile / totalM) * 100 : null
    q.pctOfTotalF = totalF > 0 ? (q.femminile / totalF) * 100 : null
  })

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
    const base = {
      band: band.band,
      levelLabel: band.level,
      gap: null,
      segregation: false,
      segregationMsg: '',
      nM: mP.length,
      nF: fP.length,
      status: 'green',
      insufficientSample: false,
      sampleMsg: '',
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
    const gap = pctGap(mean(mP.map((r) => r[field])), mean(fP.map((r) => r[field])))
    const st = rowGapStatus(gap, mP.length, fP.length, false)
    levelRows.push({ ...base, gap, ...st })
  }

  const fasciaRows = []
  let bandsComparable = 0
  let bandsAboveThreshold = 0
  let bandsToVerify = 0
  let bandsToFix = 0
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
        status: 'green',
        insufficientSample: false,
        sampleMsg: '',
      }
      if (!mP.length || !fP.length) {
        row.segregation = true
        row.segregationMsg = !mP.length
          ? 'Solo donne in fascia: gap M/F non calcolabile'
          : 'Solo uomini in fascia: gap M/F non calcolabile'
        fasciaRows.push(row)
        continue
      }
      bandsComparable += 1
      const avgM = mean(mP.map((r) => r[field]))
      const avgF = mean(fP.map((r) => r[field]))
      row.gap = pctGap(avgM, avgF)
      const st = rowGapStatus(row.gap, mP.length, fP.length, false)
      Object.assign(row, st)
      if (row.status === 'yellow') bandsToVerify += 1
      if (row.status === 'red') bandsToFix += 1
      if (Math.abs(row.gap) > EU_GAP_THRESHOLD_PCT && gapSampleSufficient(mP.length, fP.length)) {
        bandsAboveThreshold += 1
        budgetEstimate += Math.max(0, avgM - avgF) * fP.length
      }
      fasciaRows.push(row)
    }
  }

  const pctFasceSopraSoglia =
    bandsComparable > 0 ? (bandsAboveThreshold / bandsComparable) * 100 : null

  const criticalAlerts = fasciaRows
    .filter((r) => !r.segregation && r.status === 'red')
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
    .slice(0, 3)

  const decomposition = computeGapDecomposition(norm, metric, { fte })

  return {
    metric,
    fte,
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
    budgetEstimate,
    nMaschi: males.length,
    nFemmine: females.length,
    nTotaleAnalizzati: males.length + females.length,
    quartiles,
    levelRows,
    fasciaRows,
    criticalAlerts,
    segregationWarnings: fasciaRows.filter((r) => r.segregation),
    decomposition,
  }
}
