/**
 * Dati normalizzati: { gender, baseSalary, variableComponents, totalSalary, category }[]
 * Calcola tutti gli indicatori (a)-(g) per la trasparenza retributiva.
 */
export function computeIndicators(normalizedData) {
  const M = normalizedData.filter((r) => r.gender === 'M')
  const F = normalizedData.filter((r) => r.gender === 'F')
  const n = normalizedData.length

  const avg = (arr, key) => {
    if (!arr.length) return 0
    const sum = arr.reduce((s, r) => s + (r[key] ?? 0), 0)
    return sum / arr.length
  }
  const median = (arr, key) => {
    if (!arr.length) return 0
    const sorted = [...arr].map((r) => r[key] ?? 0).sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  }

  const totalKey = 'totalSalary'
  const baseKey = 'baseSalary'
  const varKey = 'variableComponents'

  const avgM = avg(M, totalKey)
  const avgF = avg(F, totalKey)
  const gapPct = (avgM - avgF) / (avgM || 1) * 100

  const avgVarM = avg(M, varKey)
  const avgVarF = avg(F, varKey)
  const gapVarPct = (avgVarM - avgVarF) / (avgVarM || 1) * 100

  const medM = median(M, totalKey)
  const medF = median(F, totalKey)
  const gapMedPct = (medM - medF) / (medM || 1) * 100

  const medVarM = median(M, varKey)
  const medVarF = median(F, varKey)
  const gapMedVarPct = (medVarM - medVarF) / (medVarM || 1) * 100

  const pctWithVariable = (arr) => {
    if (!arr.length) return 0
    const withVar = arr.filter((r) => (r[varKey] ?? 0) > 0).length
    return (withVar / arr.length) * 100
  }

  const sortedAll = [...normalizedData].sort((a, b) => (a[totalKey] ?? 0) - (b[totalKey] ?? 0))
  const q = Math.ceil(sortedAll.length / 4) || 1
  const quartiles = [
    sortedAll.slice(0, q),
    sortedAll.slice(q, q * 2),
    sortedAll.slice(q * 2, q * 3),
    sortedAll.slice(q * 3),
  ]
  const quartilePct = quartiles.map((qArr) => {
    const f = qArr.filter((r) => r.gender === 'F').length
    const m = qArr.filter((r) => r.gender === 'M').length
    const tot = qArr.length
    return {
      femminile: tot ? (f / tot) * 100 : 0,
      maschile: tot ? (m / tot) * 100 : 0,
      totale: tot,
    }
  })

  const categories = [...new Set(normalizedData.map((r) => r.category || 'Non specificata').filter(Boolean))]
  if (!categories.includes('Non specificata') && normalizedData.some((r) => !r.category))
    categories.push('Non specificata')
  const byCategory = categories.map((cat) => {
    const inCat = normalizedData.filter((r) => (r.category || 'Non specificata') === cat)
    const mM = inCat.filter((r) => r.gender === 'M')
    const fF = inCat.filter((r) => r.gender === 'F')
    const avgBaseM = avg(mM, baseKey)
    const avgBaseF = avg(fF, baseKey)
    const avgVarM = avg(mM, varKey)
    const avgVarF = avg(fF, varKey)
    const gapBase = (avgBaseM - avgBaseF) / (avgBaseM || 1) * 100
    const gapVar = (avgVarM - avgVarF) / (avgVarM || 1) * 100
    return {
      categoria: cat,
      n: inCat.length,
      divarioBase: gapBase,
      divarioVariabile: gapVar,
    }
  })

  return {
    a_divarioRetributivoGenere: {
      descrizione: 'Divario retributivo di genere (media)',
      percentuale: gapPct,
      mediaMaschile: avgM,
      mediaFemminile: avgF,
      nMaschi: M.length,
      nFemmine: F.length,
    },
    b_divarioComponentiVariabili: {
      descrizione: 'Divario retributivo di genere nelle componenti complementari o variabili',
      percentuale: gapVarPct,
      mediaMaschile: avgVarM,
      mediaFemminile: avgVarF,
    },
    c_divarioMedianoGenere: {
      descrizione: 'Divario retributivo mediano di genere',
      percentuale: gapMedPct,
      medianaMaschile: medM,
      medianaFemminile: medF,
    },
    d_divarioMedianoComponentiVariabili: {
      descrizione: 'Divario retributivo mediano di genere nelle componenti complementari o variabili',
      percentuale: gapMedVarPct,
      medianaMaschile: medVarM,
      medianaFemminile: medVarF,
    },
    e_percentualeConComponentiVariabili: {
      descrizione: 'Percentuale di lavoratori che ricevono componenti complementari o variabili',
      femminile: pctWithVariable(F),
      maschile: pctWithVariable(M),
      nFemmine: F.length,
      nMaschi: M.length,
    },
    f_percentualePerQuartile: {
      descrizione: 'Percentuale di lavoratori per sesso in ogni quartile retributivo',
      quartili: quartilePct.map((q, i) => ({ quartile: i + 1, ...q })),
    },
    g_divarioPerCategoria: {
      descrizione: 'Divario retributivo di genere per categoria (base e componenti variabili)',
      perCategoria: byCategory,
    },
  }
}
