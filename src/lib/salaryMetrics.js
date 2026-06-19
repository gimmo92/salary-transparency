/**
 * Metriche retributive, normalizzazione part-time e campi di confronto gap.
 * Riferimento normativo in commenti (Dir. UE 2023/970 / D.Lgs.) — non esporre in UI.
 */
import { mean, pctGap } from './indicators.js'

export const SALARY_METRICS = {
  base: 'base',
  livello: 'livello',
  totale: 'totale',
}

export const DEFAULT_ANNUAL_HOURS = 1720
export const MIN_GENDER_SAMPLE = 3
export const EU_GAP_THRESHOLD_PCT = 5

export function parsePartTimePct(value) {
  if (value == null || value === '') return 100
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 100
    if (value <= 1) return Math.round(value * 100)
    return Math.min(100, value)
  }
  const s = String(value).trim().replace('%', '').replace(',', '.')
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0) return 100
  if (n <= 1) return Math.round(n * 100)
  return Math.min(100, n)
}

/** Importo positivo o 0 se assente/non valido. */
export function parseSalaryAmount(value) {
  if (value == null || value === '') return 0
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0
  const cleaned = String(value)
    .replace(/\./g, '')
    .replace(/,/g, '.')
    .replace(/[^\d.-]/g, '')
  const n = Number(cleaned)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Retribuzione base netta: esclude superminimo e superminimo ass.le dal valore grezzo. */
export function effectiveBaseSalary(rawBase, superminimo = 0, superminimoAssoluto = 0) {
  const raw = Number.isFinite(rawBase) ? rawBase : 0
  const sm = parseSalaryAmount(superminimo)
  const sma = parseSalaryAmount(superminimoAssoluto)
  return Math.max(0, raw - sm - sma)
}

/**
 * Risolve le tre metriche da input grezzi (retrocompatibile con solo base + variabile).
 */
export function resolveSalaryComponents({
  base = 0,
  structural = null,
  individual = null,
  variableLegacy = 0,
  totalMapped = null,
}) {
  let structuralComponents = structural != null ? structural : 0
  let individualComponents = individual != null ? individual : 0
  if (structural == null && individual == null && variableLegacy > 0) {
    structuralComponents = variableLegacy
  }
  const livelloRetributivo = base + structuralComponents
  const totalSalary =
    totalMapped != null && totalMapped > 0
      ? totalMapped
      : livelloRetributivo + individualComponents
  const variableComponents = structuralComponents + individualComponents
  return { structuralComponents, individualComponents, livelloRetributivo, totalSalary, variableComponents }
}

/** Aggiunge metriche FTE e orarie a un record dipendente già parsato. */
export function enrichEmployeeSalaries(r, annualHours = DEFAULT_ANNUAL_HOURS) {
  const baseSalaryRaw = r.baseSalary ?? 0
  const superminimo = r.superminimo ?? 0
  const superminimoAssoluto = r.superminimoAssoluto ?? 0
  const baseSalary = effectiveBaseSalary(baseSalaryRaw, superminimo, superminimoAssoluto)

  const resolved = resolveSalaryComponents({
    base: baseSalary,
    structural: r.structuralComponents,
    individual: r.individualComponents,
    variableLegacy: r.variableComponents ?? 0,
    totalMapped: r.totalSalary,
  })

  const partTimePct = r.partTimePct > 0 ? r.partTimePct : 100
  const fteFactor = partTimePct / 100
  const toFte = (v) => (Number.isFinite(v) && v > 0 ? v / fteFactor : 0)
  const toHourly = (fteVal) => (fteVal > 0 ? fteVal / annualHours : 0)

  const { structuralComponents, individualComponents, livelloRetributivo, totalSalary, variableComponents } =
    resolved

  const baseSalaryFte = toFte(baseSalary)
  const livelloRetributivoFte = toFte(livelloRetributivo)
  const totalSalaryFte = toFte(totalSalary)

  const structuralComponentsFte = toFte(structuralComponents)
  const individualComponentsFte = toFte(individualComponents)
  const variableComponentsFte = toFte(variableComponents)

  return {
    ...r,
    partTimePct,
    baseSalaryRaw,
    superminimo: parseSalaryAmount(superminimo),
    superminimoAssoluto: parseSalaryAmount(superminimoAssoluto),
    baseSalary,
    structuralComponents,
    individualComponents,
    livelloRetributivo,
    totalSalary,
    variableComponents,
    structuralComponentsFte,
    individualComponentsFte,
    variableComponentsFte,
    baseSalaryFte,
    livelloRetributivoFte,
    totalSalaryFte,
    baseSalaryHourly: toHourly(baseSalaryFte),
    livelloRetributivoHourly: toHourly(livelloRetributivoFte),
    totalSalaryHourly: toHourly(totalSalaryFte),
  }
}

export function getSalaryFieldName(metric, { fte = true, hourly = false } = {}) {
  const core =
    {
      [SALARY_METRICS.base]: 'baseSalary',
      [SALARY_METRICS.livello]: 'livelloRetributivo',
      [SALARY_METRICS.totale]: 'totalSalary',
    }[metric] || 'livelloRetributivo'

  if (hourly) {
    return `${core}Hourly`
  }
  if (fte) {
    const fteMap = {
      baseSalary: 'baseSalaryFte',
      livelloRetributivo: 'livelloRetributivoFte',
      totalSalary: 'totalSalaryFte',
    }
    return fteMap[core]
  }
  return core
}

export function getMetricLabel(metric, { short = false } = {}) {
  if (short) {
    return (
      {
        [SALARY_METRICS.base]: 'Base',
        [SALARY_METRICS.livello]: 'Livello retrib.',
        [SALARY_METRICS.totale]: 'Totale',
      }[metric] || 'Livello retrib.'
    )
  }
  return (
    {
      [SALARY_METRICS.base]: 'Retribuzione base annua',
      [SALARY_METRICS.livello]: 'Livello retributivo (continuità fissa)',
      [SALARY_METRICS.totale]: 'Retribuzione totale annua',
    }[metric] || 'Livello retributivo'
  )
}

export function getComparisonValue(r, metric, { fte = true, hourly = false } = {}) {
  if (!r) return null
  const field = getSalaryFieldName(metric, { fte, hourly })
  const v = r[field]
  return Number.isFinite(v) && v > 0 ? v : null
}

export function validComparisonSalary(r, metric, options) {
  return getComparisonValue(r, metric, options) != null
}

export function gapSampleSufficient(nM, nF, min = MIN_GENDER_SAMPLE) {
  return nM >= min && nF >= min
}

/**
 * Stato gap: verde / giallo (da verificare) / rosso (da correggere) / campione insufficiente.
 */
export function classifyGapStatus(gapPct, { hasJustification = false, nM = 0, nF = 0 } = {}) {
  if (!gapSampleSufficient(nM, nF)) return 'insufficient'
  if (gapPct == null || !Number.isFinite(gapPct) || Math.abs(gapPct) <= EU_GAP_THRESHOLD_PCT) {
    return 'green'
  }
  if (hasJustification) return 'yellow'
  return 'red'
}

function seniorityYearsApprox(r) {
  if (r?.seniorityYears != null && Number.isFinite(r.seniorityYears)) return r.seniorityYears
  const raw = r?.seniority
  if (raw == null || raw === '') return null
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  const s = String(raw).trim()
  const n = Number(s.replace(',', '.'))
  if (Number.isFinite(n) && n >= 0 && n < 80) return n
  return null
}

function levelIndex(level) {
  const s = String(level || '').trim()
  if (!s) return 0
  return s.charCodeAt(0) + s.length
}

/**
 * Decomposizione semplificata: quota spiegata da anzianità, % part-time e livello vs residuo.
 */
export function computeGapDecomposition(normalized, metric, { fte = true } = {}) {
  const rows = (normalized || []).filter(
    (r) => (r.gender === 'M' || r.gender === 'F') && validComparisonSalary(r, metric, { fte }),
  )
  const men = rows.filter((r) => r.gender === 'M')
  const women = rows.filter((r) => r.gender === 'F')
  if (!men.length || !women.length) return null

  const val = (r) => getComparisonValue(r, metric, { fte })
  const meanM = mean(men.map(val))
  const meanF = mean(women.map(val))
  const rawGapPct = pctGap(meanM, meanF)
  if (rawGapPct == null) return null

  const pooled = rows.map((r) => ({
    y: val(r),
    sen: seniorityYearsApprox(r) ?? mean(rows.map(seniorityYearsApprox).filter(Number.isFinite)) ?? 0,
    pt: (r.partTimePct ?? 100) / 100,
    lvl: levelIndex(r.level),
  }))

  const meanY = mean(pooled.map((p) => p.y))
  const meanSen = mean(pooled.map((p) => p.sen))
  const meanPt = mean(pooled.map((p) => p.pt))
  const meanLvl = mean(pooled.map((p) => p.lvl))

  let varSen = 0
  let covSenY = 0
  let varPt = 0
  let covPtY = 0
  let varLvl = 0
  let covLvlY = 0
  for (const p of pooled) {
    const ds = p.sen - meanSen
    const dpt = p.pt - meanPt
    const dl = p.lvl - meanLvl
    varSen += ds * ds
    covSenY += ds * (p.y - meanY)
    varPt += dpt * dpt
    covPtY += dpt * (p.y - meanY)
    varLvl += dl * dl
    covLvlY += dl * (p.y - meanY)
  }
  const n = pooled.length || 1
  const slopeSen = varSen > 0 ? covSenY / varSen : 0
  const slopePt = varPt > 0 ? covPtY / varPt : 0
  const slopeLvl = varLvl > 0 ? covLvlY / varLvl : 0

  const meanSenM = mean(men.map((r) => seniorityYearsApprox(r) ?? meanSen))
  const meanSenF = mean(women.map((r) => seniorityYearsApprox(r) ?? meanSen))
  const meanPtM = mean(men.map((r) => (r.partTimePct ?? 100) / 100))
  const meanPtF = mean(women.map((r) => (r.partTimePct ?? 100) / 100))
  const meanLvlM = mean(men.map((r) => levelIndex(r.level)))
  const meanLvlF = mean(women.map((r) => levelIndex(r.level)))

  const explainedDiff =
    slopeSen * (meanSenM - meanSenF) + slopePt * (meanPtM - meanPtF) + slopeLvl * (meanLvlM - meanLvlF)
  const explainedGapPct = meanM > 0 ? (explainedDiff / meanM) * 100 : 0
  const residualGapPct =
    rawGapPct != null && explainedGapPct != null ? rawGapPct - explainedGapPct : rawGapPct

  return {
    metric,
    fte,
    rawGapPct,
    explainedGapPct: Math.round(explainedGapPct * 100) / 100,
    residualGapPct: Math.round(residualGapPct * 100) / 100,
    factors: {
      seniority: Math.round(slopeSen * (meanSenM - meanSenF) * 100) / 100,
      partTime: Math.round(slopePt * (meanPtM - meanPtF) * 100) / 100,
      level: Math.round(slopeLvl * (meanLvlM - meanLvlF) * 100) / 100,
    },
    nMaschi: men.length,
    nFemmine: women.length,
  }
}
