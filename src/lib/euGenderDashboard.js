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
 * Outlier per quartile retributivo (stessa suddivisione della dashboard):
 * dentro ogni quartile si applica la regola box-plot IQR (1.5×) sulle retribuzioni.
 * @returns {Array<{ index: number, name: unknown, gender: string, salary: number, quartile: number, reason: string }>}
 */
export function computeQuartileOutliers(normalized, salaryMode) {
  const field = salaryFieldForMode(salaryMode)
  const norm = (normalized || []).filter(
    (r) => (r.gender === 'M' || r.gender === 'F') && validSalary(r, field),
  )
  if (norm.length < 2) return []

  const sorted = [...norm].sort((a, b) => a[field] - b[field])
  const len = sorted.length
  const qSize = Math.ceil(len / 4) || 1
  const outliers = []

  for (let qi = 0; qi < 4; qi++) {
    const start = qi * qSize
    const end = Math.min(len, (qi + 1) * qSize)
    const chunk = sorted.slice(start, end)
    if (chunk.length < 2) continue

    const vals = chunk.map((r) => r[field]).sort((a, b) => a - b)
    const q1 = percentileSorted(vals, 0.25)
    const q3 = percentileSorted(vals, 0.75)
    const iqr = q3 - q1
    const low = q1 - 1.5 * iqr
    const high = q3 + 1.5 * iqr

    for (const r of chunk) {
      const v = r[field]
      if (v < low || v > high) {
        outliers.push({
          index: r.index,
          name: r.name,
          gender: r.gender,
          salary: v,
          quartile: qi + 1,
          reason: v < low
            ? `Q${qi + 1}: sotto soglia inferiore (IQR: ${Math.round(low).toLocaleString('it-IT')} – ${Math.round(high).toLocaleString('it-IT')})`
            : `Q${qi + 1}: sopra soglia superiore (IQR: ${Math.round(low).toLocaleString('it-IT')} – ${Math.round(high).toLocaleString('it-IT')})`,
        })
      }
    }
  }

  return outliers.sort((a, b) => a.quartile - b.quartile || b.salary - a.salary)
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

  // Quartili su popolazione con retribuzione valida nel campo scelto:
  // per ogni quartile: conteggi + media retributiva M e F (non % composizione di genere)
  const quartiles = [1, 2, 3, 4].map((quartile) => ({
    quartile,
    maschile: 0,
    femminile: 0,
    totale: 0,
    /** Media retribuzione (campo scelto) uomini nel quartile; null se nessun uomo */
    avgMaschile: null,
    /** Media retribuzione (campo scelto) donne nel quartile; null se nessuna donna */
    avgFemminile: null,
    /** Altezza barra 0–100 per confronto visivo M vs F nello stesso quartile */
    barPctM: 0,
    barPctF: 0,
    /** Gap % tra media M e media F: (M−F)/M×100 come resto dashboard; null se non calcolabile */
    gapPct: null,
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
      const maxAvg = Math.max(q.avgMaschile ?? 0, q.avgFemminile ?? 0)
      if (maxAvg > 0) {
        q.barPctM = q.avgMaschile != null ? (q.avgMaschile / maxAvg) * 100 : 0
        q.barPctF = q.avgFemminile != null ? (q.avgFemminile / maxAvg) * 100 : 0
      }
      if (
        q.avgMaschile != null &&
        q.avgFemminile != null &&
        Number.isFinite(q.avgMaschile) &&
        Number.isFinite(q.avgFemminile) &&
        q.avgMaschile > 0
      ) {
        q.gapPct = pctGap(q.avgMaschile, q.avgFemminile)
      } else {
        q.gapPct = null
      }
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
