export function mean(values) {
  const arr = values.filter((v) => Number.isFinite(v))
  if (!arr.length) return 0
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

export function median(values) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!arr.length) return 0
  const mid = Math.floor(arr.length / 2)
  return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid]
}

export function pctGap(male, female) {
  if (!Number.isFinite(male) || !Number.isFinite(female)) return null
  if (male === 0) return null
  return ((male - female) / male) * 100
}

import { metricFromMode, salaryFieldKey, computeGapDecomposition } from './compensation.js'

export function computeBandGenderGaps(normalizedGender, jobResults, options = {}) {
  if (!normalizedGender?.length || !jobResults?.length) return []

  const metric = metricFromMode(options.metric ?? 'level')
  const normalized = options.normalized !== false
  const levelField = salaryFieldKey(metric, normalized)
  const baseField = normalized ? 'baseSalaryFte' : 'baseSalary'
  const totalField = normalized ? 'totalSalaryFte' : 'totalSalary'

  const personBand = new Map()
  for (const jr of jobResults) {
    if (!jr.people) continue
    for (const p of jr.people) {
      personBand.set(p.index, jr.band)
    }
  }

  const bands = new Map()
  for (const r of normalizedGender) {
    const band = personBand.get(r.index) ?? null
    if (band == null) continue
    if (!bands.has(band)) bands.set(band, { mLevel: [], fLevel: [], mBase: [], fBase: [], mTot: [], fTot: [] })
    const b = bands.get(band)
    if (r.gender === 'M') {
      b.mLevel.push(r[levelField])
      b.mBase.push(r[baseField])
      b.mTot.push(r[totalField])
    } else if (r.gender === 'F') {
      b.fLevel.push(r[levelField])
      b.fBase.push(r[baseField])
      b.fTot.push(r[totalField])
    }
  }

  return Array.from(bands.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([band, d]) => ({
      band,
      nM: d.mLevel.length,
      nF: d.fLevel.length,
      gapMedia: pctGap(mean(d.mLevel), mean(d.fLevel)),
      gapMediana: pctGap(median(d.mLevel), median(d.fLevel)),
      gapBaseMedia: pctGap(mean(d.mBase), mean(d.fBase)),
      gapBaseMediana: pctGap(median(d.mBase), median(d.fBase)),
      gapTotMedia: pctGap(mean(d.mTot), mean(d.fTot)),
      gapTotMediana: pctGap(median(d.mTot), median(d.fTot)),
    }))
}

export function computeAdjustedGap(normalized, topPct = 5, options = {}) {
  if (!normalized?.length) return { gapMedia: 0, gapMediana: 0, excluded: 0, total: normalized?.length || 0 }
  const field = salaryFieldKey(metricFromMode(options.metric ?? 'level'), options.normalized !== false)
  const sorted = [...normalized].sort((a, b) => (b[field] || 0) - (a[field] || 0))
  const cutoff = Math.max(1, Math.ceil(sorted.length * topPct / 100))
  const filtered = sorted.slice(cutoff)
  const males = filtered.filter((r) => r.gender === 'M')
  const females = filtered.filter((r) => r.gender === 'F')
  return {
    gapMedia: pctGap(mean(males.map((r) => r[field])), mean(females.map((r) => r[field]))),
    gapMediana: pctGap(median(males.map((r) => r[field])), median(females.map((r) => r[field]))),
    excluded: cutoff,
    total: normalized.length,
  }
}

/**
 * @param {Array} normalized
 * @param {{ metric?: 'base'|'level'|'total', normalized?: boolean, primaryField?: string }} [options]
 */
export function computeIndicators(normalized, options = {}) {
  const primaryField = options.primaryField
    || salaryFieldKey(metricFromMode(options.metric ?? 'level'), options.normalized !== false)

  const males = normalized.filter((r) => r.gender === 'M')
  const females = normalized.filter((r) => r.gender === 'F')

  const mBase = males.map((r) => r.baseSalary)
  const fBase = females.map((r) => r.baseSalary)
  const mVar = males.map((r) => r.variableComponents)
  const fVar = females.map((r) => r.variableComponents)
  const mPrimary = males.map((r) => r[primaryField])
  const fPrimary = females.map((r) => r[primaryField])

  const baseMale = mean(mBase)
  const baseFemale = mean(fBase)
  const varMale = mean(mVar)
  const varFemale = mean(fVar)
  const primMale = mean(mPrimary)
  const primFemale = mean(fPrimary)
  const varMedM = median(mVar)
  const varMedF = median(fVar)

  // (a) gap retributivo sulla retribuzione principale (totale o base)
  const aGap = pctGap(primMale, primFemale)

  // (b) gap componenti variabili
  const bGap = pctGap(varMale, varFemale)

  // (h) gap retribuzione base
  const hGap = pctGap(baseMale, baseFemale)

  // (c) gap mediano sulla retribuzione principale
  const cGap = pctGap(median(mPrimary), median(fPrimary))

  // (d) gap mediano variabile
  const dGap = pctGap(varMedM, varMedF)

  const totalCount = normalized.length || 1
  const quartiles = [0, 0, 0, 0].map((_, i) => ({
    quartile: i + 1,
    femminile: 0,
    maschile: 0,
    totale: 0,
  }))

  if (normalized.length) {
    const sorted = [...normalized].sort((a, b) => (a[primaryField] || 0) - (b[primaryField] || 0))
    const qSize = Math.ceil(sorted.length / 4)
    sorted.forEach((r, idx) => {
      const qIndex = Math.min(3, Math.floor(idx / qSize))
      const bucket = quartiles[qIndex]
      bucket.totale += 1
      if (r.gender === 'F') bucket.femminile += 1
      else if (r.gender === 'M') bucket.maschile += 1
    })
    quartiles.forEach((q) => {
      q.femminile = (q.femminile / totalCount) * 100
      q.maschile = (q.maschile / totalCount) * 100
    })
  }

  const categories = new Map()
  for (const r of normalized) {
    const key = r.category || 'N/D'
    if (!categories.has(key)) {
      categories.set(key, { n: 0, mBase: [], fBase: [], mVar: [], fVar: [] })
    }
    const c = categories.get(key)
    c.n += 1
    if (r.gender === 'M') {
      c.mBase.push(r.baseSalary)
      c.mVar.push(r.variableComponents)
    } else if (r.gender === 'F') {
      c.fBase.push(r.baseSalary)
      c.fVar.push(r.variableComponents)
    }
  }

  const perCategoria = Array.from(categories.entries()).map(([categoria, c]) => {
    const catBaseMale = mean(c.mBase)
    const catBaseFemale = mean(c.fBase)
    const catVarMale = mean(c.mVar)
    const catVarFemale = mean(c.fVar)
    return {
      categoria,
      n: c.n,
      divarioBase: pctGap(catBaseMale, catBaseFemale),
      divarioVariabile: pctGap(catVarMale, catVarFemale),
    }
  })

  const gapDecomposition = computeGapDecomposition(
    males.filter((r) => Number.isFinite(r[primaryField]) && r[primaryField] > 0),
    females.filter((r) => Number.isFinite(r[primaryField]) && r[primaryField] > 0),
    primaryField,
  )

  return {
    gapDecomposition,
    a_divarioRetributivoGenere: {
      descrizione: 'Divario retributivo medio complessivo tra uomini e donne.',
      percentuale: aGap,
      mediaMaschile: primMale,
      mediaFemminile: primFemale,
      nMaschi: males.length,
      nFemmine: females.length,
    },
    b_divarioComponentiVariabili: {
      descrizione: 'Divario medio sulle componenti variabili della retribuzione.',
      percentuale: bGap,
      mediaMaschile: varMale,
      mediaFemminile: varFemale,
    },
    c_divarioMedianoGenere: {
      descrizione: 'Divario mediano complessivo tra uomini e donne.',
      percentuale: cGap,
      medianaMaschile: median(mPrimary),
      medianaFemminile: median(fPrimary),
    },
    d_divarioMedianoComponentiVariabili: {
      descrizione: 'Divario mediano sulle componenti variabili.',
      percentuale: dGap,
      medianaMaschile: varMedM,
      medianaFemminile: varMedF,
    },
    e_percentualeConComponentiVariabili: {
      descrizione: 'Quota di lavoratori che percepiscono componenti variabili.',
      femminile:
        (females.filter((r) => r.variableComponents > 0).length / (females.length || 1)) *
        100,
      maschile:
        (males.filter((r) => r.variableComponents > 0).length / (males.length || 1)) *
        100,
      nFemmine: females.length,
      nMaschi: males.length,
    },
    f_percentualePerQuartile: {
      descrizione: 'Distribuzione di uomini e donne per quartile retributivo.',
      quartili: quartiles,
    },
    g_divarioPerCategoria: {
      descrizione: 'Divario retributivo per categoria/inquadramento.',
      perCategoria,
    },
    h_divarioRetribuzioneBase: {
      descrizione: 'Divario retributivo di genere sulla retribuzione base.',
      percentuale: hGap,
      mediaMaschile: baseMale,
      mediaFemminile: baseFemale,
    },
  }
}

