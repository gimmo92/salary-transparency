/** Categorie voce retributiva (Art. 3 — logica interna, no citazioni in UI) */
export const PAY_COMPONENT_CATEGORIES = {
  STRUCTURAL: 'STRUCTURAL_CONTINUOUS',
  INDIVIDUAL: 'INDIVIDUAL_NON_STRUCTURAL',
  NON_PAY: 'NON_COMPENSATION',
}

export const PAY_COMPONENT_LABELS = {
  [PAY_COMPONENT_CATEGORIES.STRUCTURAL]: 'Strutturale continuativa (livello retributivo)',
  [PAY_COMPONENT_CATEGORIES.INDIVIDUAL]: 'Individuale non strutturale',
  [PAY_COMPONENT_CATEGORIES.NON_PAY]: 'Non retribuzione (esclusa)',
}

/** Metriche retributive per reporting / analisi */
export const SALARY_METRICS = {
  base: 'base',
  level: 'level',
  total: 'total',
}

export const SALARY_METRIC_LABELS = {
  [SALARY_METRICS.base]: 'Retribuzione base',
  [SALARY_METRICS.level]: 'Livello retributivo',
  [SALARY_METRICS.total]: 'Retribuzione totale',
}

export const DEFAULT_CCNL_ANNUAL_HOURS = 1720
export const DEFAULT_PART_TIME_PCT = 100
export const MIN_GENDER_SAMPLE_PER_GROUP = 3

export const LEGAL_QUALIFICATIONS = ['operaio', 'impiegato', 'quadro', 'dirigente']

export function parseMoney(value) {
  if (value == null || value === '') return 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const cleaned = String(value)
    .replace(/\./g, '')
    .replace(/,/g, '.')
    .replace(/[^\d.-]/g, '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : 0
}

export function parsePartTimePct(value) {
  if (value == null || value === '') return DEFAULT_PART_TIME_PCT
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_PART_TIME_PCT
    return value <= 1 ? value * 100 : value
  }
  const s = String(value).trim().replace(',', '.').replace(/%/g, '')
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PART_TIME_PCT
  return n <= 1 ? n * 100 : n
}

export function parseHireDate(value) {
  if (value == null || value === '') return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === 'number' && value > 25569) {
    const d = new Date((value - 25569) * 86400 * 1000)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const s = String(value).trim()
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
  const it = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/)
  if (it) {
    let y = Number(it[3])
    if (y < 100) y += y > 50 ? 1900 : 2000
    return new Date(y, Number(it[2]) - 1, Number(it[1]))
  }
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

export function normalizeLegalQualification(raw) {
  if (raw == null || String(raw).trim() === '') return null
  const s = String(raw).trim().toLowerCase()
  if (/dirigent|manager|executive/.test(s)) return 'dirigente'
  if (/quadro|manager/.test(s)) return 'quadro'
  if (/impieg|office|clerk|admin/.test(s)) return 'impiegato'
  if (/operaio|worker|operai|manufact/.test(s)) return 'operaio'
  if (LEGAL_QUALIFICATIONS.includes(s)) return s
  return String(raw).trim()
}

/** Proposta categoria da intestazione colonna (sempre sovrascrivibile in mapping). */
export function suggestPayComponentCategory(header) {
  const h = String(header || '').trim().toLowerCase()
  if (!h) return null
  if (
    /\b(inps|inail|contribut|tfr|accanton|costo\s*(del\s*)?lavoro|costo\s*azienda|costo\s*totale|ctr\s*inps)\b/i.test(h)
  ) {
    return PAY_COMPONENT_CATEGORIES.NON_PAY
  }
  if (/\b(supass|assorb|assorbibile|individuale\s*discr|mbo|pdr|bonus|premio\s*una|tantum|presenze?)\b/i.test(h)) {
    return PAY_COMPONENT_CATEGORIES.INDIVIDUAL
  }
  if (/\b(14\s*ma|13\s*ma|superminimo|terzo\s*elem|indennit[aà]\s*(di\s*)?(ruolo|funz)|rml|produzione|turni|maggioraz)\b/i.test(h)) {
    return PAY_COMPONENT_CATEGORIES.STRUCTURAL
  }
  if (/\b(variabil|premio|incentiv|bonus|mbo)\b/i.test(h)) {
    return PAY_COMPONENT_CATEGORIES.INDIVIDUAL
  }
  if (/\b(comp\.?\s*variab|tot\s*comp)\b/i.test(h)) {
    return PAY_COMPONENT_CATEGORIES.INDIVIDUAL
  }
  return PAY_COMPONENT_CATEGORIES.STRUCTURAL
}

export function detectPayComponentMapping(headers, usedIndices = new Set()) {
  const mapping = {}
  headers.forEach((h, i) => {
    if (usedIndices.has(i)) return
    const cat = suggestPayComponentCategory(h)
    if (cat && cat !== PAY_COMPONENT_CATEGORIES.NON_PAY) {
      mapping[i] = cat
    }
  })
  return mapping
}

function fteFactor(percPartTime) {
  const pct = parsePartTimePct(percPartTime)
  return pct > 0 ? 100 / pct : 1
}

/**
 * Calcola metriche retributive e versioni FTE/orarie su record parziale.
 * @param {{ baseSalary?: number, structuralSum?: number, individualSum?: number, percPartTime?: number, totalSalaryOverride?: number|null }} parts
 * @param {{ ccnlAnnualHours?: number }} [opts]
 */
export function computeCompensationMetrics(parts, opts = {}) {
  const hours = opts.ccnlAnnualHours ?? DEFAULT_CCNL_ANNUAL_HOURS
  const base = Number(parts.baseSalary) || 0
  const structural = Number(parts.structuralSum) || 0
  const individual = Number(parts.individualSum) || 0
  const levelRetributivo = base + structural
  const totalCompensation = levelRetributivo + individual
  const totalSalary =
    parts.totalSalaryOverride != null && Number.isFinite(Number(parts.totalSalaryOverride)) && Number(parts.totalSalaryOverride) > 0
      ? Number(parts.totalSalaryOverride)
      : totalCompensation

  const fte = fteFactor(parts.percPartTime)
  const baseSalaryFte = base * fte
  const levelRetributivoFte = levelRetributivo * fte
  const totalSalaryFte = totalSalary * fte
  const variableComponents = structural + individual

  return {
    baseSalary: base,
    structuralContinuous: structural,
    individualNonStructural: individual,
    levelRetributivo,
    totalSalary,
    variableComponents,
    baseSalaryFte,
    levelRetributivoFte,
    totalSalaryFte,
    hourlyBase: hours > 0 ? baseSalaryFte / hours : null,
    hourlyLevel: hours > 0 ? levelRetributivoFte / hours : null,
    hourlyTotal: hours > 0 ? totalSalaryFte / hours : null,
    percPartTime: parsePartTimePct(parts.percPartTime),
  }
}

/** Nome campo record per metrica + modalità grezzo/FTE */
export function salaryFieldKey(metric, normalized = true) {
  const m = metric === SALARY_METRICS.base ? SALARY_METRICS.base
    : metric === SALARY_METRICS.total ? SALARY_METRICS.total
      : SALARY_METRICS.level
  if (normalized) {
    if (m === SALARY_METRICS.base) return 'baseSalaryFte'
    if (m === SALARY_METRICS.total) return 'totalSalaryFte'
    return 'levelRetributivoFte'
  }
  if (m === SALARY_METRICS.base) return 'baseSalary'
  if (m === SALARY_METRICS.total) return 'totalSalary'
  return 'levelRetributivo'
}

/** Compat: mode string da UI ('base' | 'level' | 'total') */
export function metricFromMode(mode) {
  if (mode === SALARY_METRICS.base || mode === 'base') return SALARY_METRICS.base
  if (mode === SALARY_METRICS.total || mode === 'total') return SALARY_METRICS.total
  return SALARY_METRICS.level
}

/** Valore numerico per metrica + modalità grezzo/FTE */
export function salaryFieldForMetric(record, metric, normalized = true) {
  const m = metric === SALARY_METRICS.base ? SALARY_METRICS.base
    : metric === SALARY_METRICS.total ? SALARY_METRICS.total
      : SALARY_METRICS.level
  const map = normalized
    ? {
        [SALARY_METRICS.base]: 'baseSalaryFte',
        [SALARY_METRICS.level]: 'levelRetributivoFte',
        [SALARY_METRICS.total]: 'totalSalaryFte',
      }
    : {
        [SALARY_METRICS.base]: 'baseSalary',
        [SALARY_METRICS.level]: 'levelRetributivo',
        [SALARY_METRICS.total]: 'totalSalary',
      }
  const key = map[m]
  const v = record?.[key]
  if (Number.isFinite(v) && v > 0) return v
  if (m === SALARY_METRICS.total && Number.isFinite(record?.totalSalary)) return record.totalSalary
  if (m === SALARY_METRICS.base && Number.isFinite(record?.baseSalary)) return record.baseSalary
  return null
}

export function hasInsufficientGenderSample(nM, nF, min = MIN_GENDER_SAMPLE_PER_GROUP) {
  return nM < min || nF < min
}

/** Stato gap fascia/livello: green | yellow | red | insufficient */
export function gapVerificationStatus(gapPct, hasJustification, nM, nF) {
  if (hasInsufficientGenderSample(nM, nF)) return 'insufficient'
  if (gapPct == null || !Number.isFinite(gapPct)) return 'insufficient'
  if (Math.abs(gapPct) <= 5) return 'green'
  if (hasJustification) return 'yellow'
  return 'red'
}

/**
 * Decomposizione semplificata gap: quota spiegata da anzianità e part-time vs residuo.
 * @returns {{ explainedPct: number|null, residualPct: number|null, factors: object }}
 */
export function computeGapDecomposition(males, females, salaryField = 'levelRetributivoFte') {
  if (!males?.length || !females?.length) return { explainedPct: null, residualPct: null, factors: {} }
  const mSal = males.map((r) => r[salaryField]).filter((v) => Number.isFinite(v) && v > 0)
  const fSal = females.map((r) => r[salaryField]).filter((v) => Number.isFinite(v) && v > 0)
  if (!mSal.length || !fSal.length) return { explainedPct: null, residualPct: null, factors: {} }

  const rawGap = ((mSal.reduce((a, b) => a + b, 0) / mSal.length - fSal.reduce((a, b) => a + b, 0) / fSal.length)
    / (mSal.reduce((a, b) => a + b, 0) / mSal.length)) * 100

  const avg = (arr, fn) => arr.reduce((s, r) => s + fn(r), 0) / arr.length
  const mPt = avg(males, (r) => parsePartTimePct(r.percPartTime))
  const fPt = avg(females, (r) => parsePartTimePct(r.percPartTime))
  const ptEffect = mPt !== fPt ? ((100 / fPt - 100 / mPt) / (100 / mPt)) * 100 * 0.5 : 0

  const mSen = avg(males, (r) => Number(r.seniorityYears) || 0)
  const fSen = avg(females, (r) => Number(r.seniorityYears) || 0)
  const senEffect = mSen !== fSen ? (mSen - fSen) * 0.3 : 0

  const explained = Math.min(Math.abs(rawGap), Math.abs(ptEffect) + Math.abs(senEffect))
  const explainedPct = rawGap !== 0 ? (Math.sign(rawGap) * explained) : 0
  const residualPct = rawGap - explainedPct

  return {
    explainedPct: Math.round(explainedPct * 100) / 100,
    residualPct: Math.round(residualPct * 100) / 100,
    factors: { partTimeEffect: ptEffect, seniorityEffect: senEffect, rawGap },
  }
}
