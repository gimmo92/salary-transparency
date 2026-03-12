function mean(values) {
  const arr = values.filter((v) => Number.isFinite(v))
  if (!arr.length) return 0
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

function median(values) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!arr.length) return 0
  const mid = Math.floor(arr.length / 2)
  return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid]
}

function pctGap(male, female) {
  if (!Number.isFinite(male) || male === 0) return 0
  return ((male - female) / male) * 100
}

export function computeIndicators(normalized) {
  const males = normalized.filter((r) => r.gender === 'M')
  const females = normalized.filter((r) => r.gender === 'F')

  const mBase = males.map((r) => r.baseSalary)
  const fBase = females.map((r) => r.baseSalary)
  const mVar = males.map((r) => r.variableComponents)
  const fVar = females.map((r) => r.variableComponents)
  const mTot = males.map((r) => r.totalSalary)
  const fTot = females.map((r) => r.totalSalary)

  const baseMale = mean(mBase)
  const baseFemale = mean(fBase)
  const varMale = mean(mVar)
  const varFemale = mean(fVar)
  const totMale = mean(mTot)
  const totFemale = mean(fTot)

  const baseMedM = median(mBase)
  const baseMedF = median(fBase)
  const varMedM = median(mVar)
  const varMedF = median(fVar)

  // (a) gap retributivo su totale
  const aGap = pctGap(totMale, totFemale)

  // (b) gap componenti variabili
  const bGap = pctGap(varMale, varFemale)

  // (h) gap retribuzione base
  const hGap = pctGap(baseMale, baseFemale)

  // (c) gap mediano totale
  const cGap = pctGap(median(mTot), median(fTot))

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
    const sorted = [...normalized].sort((a, b) => a.totalSalary - b.totalSalary)
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

  return {
    a_divarioRetributivoGenere: {
      descrizione: 'Divario retributivo medio complessivo tra uomini e donne.',
      percentuale: aGap,
      mediaMaschile: totMale,
      mediaFemminile: totFemale,
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
      medianaMaschile: median(mTot),
      medianaFemminile: median(fTot),
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

