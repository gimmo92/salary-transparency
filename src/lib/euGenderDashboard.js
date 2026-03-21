/**
 * Calcoli per la Global Gender Pay Transparency Dashboard
 * Riferimento: Direttiva UE 2023/970
 */
import { mean, median, pctGap } from './indicators.js'

export const EU_GAP_THRESHOLD_PCT = 5

export function salaryFieldForMode(mode) {
  return mode === 'base' ? 'baseSalary' : 'totalSalary'
}

/** Verde <4%, giallo 4–5%, rosso >5% (valore assoluto) */
export function gapSeverityClass(pct) {
  if (pct == null || !Number.isFinite(pct)) return 'gap-severity-na'
  const a = Math.abs(pct)
  if (a < 4) return 'gap-severity-green'
  if (a <= EU_GAP_THRESHOLD_PCT) return 'gap-severity-yellow'
  return 'gap-severity-red'
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
 * @param {'base'|'total'} salaryMode
 */
export function computeEuGenderDashboard(normalized, jobResults, salaryMode) {
  const field = salaryFieldForMode(salaryMode)
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

  // Quartili su popolazione con retribuzione valida nel campo scelto
  const quartiles = [1, 2, 3, 4].map((quartile) => ({
    quartile,
    maschile: 0,
    femminile: 0,
    totale: 0,
    maschilePct: 0,
    femminilePct: 0,
  }))

  const sortedForQ = norm.filter((r) => validSalary(r, field)).sort((a, b) => a[field] - b[field])
  const lenQ = sortedForQ.length
  if (lenQ > 0) {
    const qSize = Math.ceil(lenQ / 4) || 1
    sortedForQ.forEach((r, idx) => {
      const qIndex = Math.min(3, Math.floor(idx / qSize))
      const bucket = quartiles[qIndex]
      bucket.totale += 1
      if (r.gender === 'M') bucket.maschile += 1
      else if (r.gender === 'F') bucket.femminile += 1
    })
    quartiles.forEach((q) => {
      const t = q.totale || 1
      q.maschilePct = (q.maschile / t) * 100
      q.femminilePct = (q.femminile / t) * 100
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
    const base = {
      band: band.band,
      levelLabel: band.level,
      gap: null,
      segregation: false,
      segregationMsg: '',
      nM: mP.length,
      nF: fP.length,
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
    levelRows.push({
      ...base,
      gap: pctGap(mean(mP.map((r) => r[field])), mean(fP.map((r) => r[field]))),
    })
  }

  const fasciaRows = []
  let bandsComparable = 0
  let bandsAboveThreshold = 0
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
      if (Math.abs(row.gap) > EU_GAP_THRESHOLD_PCT) {
        bandsAboveThreshold += 1
        budgetEstimate += Math.max(0, avgM - avgF) * fP.length
      }
      fasciaRows.push(row)
    }
  }

  const pctFasceSopraSoglia =
    bandsComparable > 0 ? (bandsAboveThreshold / bandsComparable) * 100 : null

  const criticalAlerts = fasciaRows
    .filter((r) => !r.segregation && r.gap != null && Math.abs(r.gap) > EU_GAP_THRESHOLD_PCT)
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
    .slice(0, 3)

  return {
    gapMean,
    gapMedian,
    pctFasceSopraSoglia,
    bandsAboveThreshold,
    bandsComparable,
    budgetEstimate,
    nMaschi: males.length,
    nFemmine: females.length,
    nTotaleAnalizzati: males.length + females.length,
    quartiles,
    levelRows,
    fasciaRows,
    criticalAlerts,
    segregationWarnings: fasciaRows.filter((r) => r.segregation),
  }
}
