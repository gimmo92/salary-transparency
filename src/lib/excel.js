import * as XLSX from 'xlsx'

/**
 * Legge un file Excel e restituisce la prima foglio come array di oggetti (prima riga = intestazioni).
 */
export function parseExcelFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result)
        resolve(parseExcelArrayBuffer(data))
      } catch (err) {
        reject(err)
      }
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
}

/**
 * Scarica un file Excel da un URL (link diretto) e restituisce righe e intestazioni.
 * L'URL deve essere un link di download diretto; il server deve inviare CORS headers consentendo l'origine.
 */
export async function parseExcelFromUrl(url) {
  const res = await fetch(url, { mode: 'cors' })
  if (!res.ok) throw new Error(`Errore di rete: ${res.status} ${res.statusText}`)
  const buffer = await res.arrayBuffer()
  const data = new Uint8Array(buffer)
  return parseExcelArrayBuffer(data)
}

function parseExcelArrayBuffer(data) {
  const workbook = XLSX.read(data, { type: 'array' })
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]]
  const json = XLSX.utils.sheet_to_json(firstSheet, { defval: '', raw: false })
  const headers = json.length ? Object.keys(json[0]) : []
  return { rows: json, headers }
}

/** Ruoli colonne che l’AI deve riconoscere */
export const COLUMN_ROLES = {
  gender: 'genere',
  baseSalary: 'retribuzione_base',
  variableComponents: 'componenti_variabili',
  totalSalary: 'retribuzione_totale',
  category: 'categoria_lavoratore',
}

const ROLE_LABELS = {
  [COLUMN_ROLES.gender]: 'Genere (M/F)',
  [COLUMN_ROLES.baseSalary]: 'Retribuzione base',
  [COLUMN_ROLES.variableComponents]: 'Componenti variabili / complementari',
  [COLUMN_ROLES.totalSalary]: 'Retribuzione totale',
  [COLUMN_ROLES.category]: 'Categoria lavoratore',
}

export function getRoleLabel(role) {
  return ROLE_LABELS[role] || role
}

/**
 * Riconoscimento euristico (tipo AI) delle colonne: intestazioni + campione valori.
 * Restituisce { [role]: columnIndex } (0-based).
 */
export function detectColumnRoles(headers, rows, sampleSize = 50) {
  const suggestions = {}
  const sample = rows.slice(0, Math.min(sampleSize, rows.length))
  const normalized = (s) => String(s).toLowerCase().trim().replace(/\s+/g, ' ')

  const genderKeywords = [
    'genere', 'sesso', 'gender', 'sex', 'm/f', 'maschio', 'femmina', 'uomo', 'donna',
    'male', 'female', 'f', 'm', 'uomo/donna'
  ]
  const baseKeywords = [
    'stipendio', 'retribuzione', 'base', 'salario', 'paga', 'salary', 'ordinario',
    'normale', 'fisso', 'lorda', 'lordo', 'ral', 'stipendio base', 'base '
  ]
  const variableKeywords = [
    'variabile', 'bonus', 'premio', 'incentivo', 'complementare', 'componente',
    'variable', 'incentive', 'premium', 'straordinari', 'overtime'
  ]
  const totalKeywords = [
    'totale', 'total', 'complessiva', 'retribuzione totale', 'totale lordo', 'complesso'
  ]
  const categoryKeywords = [
    'categoria', 'ruolo', 'livello', 'qualifica', 'area', 'dipartimento',
    'category', 'role', 'level', 'job', 'mansione'
  ]

  function scoreHeader(header, keywordList) {
    const h = normalized(header)
    for (const kw of keywordList) {
      if (h.includes(kw)) return 2
    }
    return 0
  }

  function looksLikeNumber(val) {
    if (val == null || val === '') return false
    const s = String(val).replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
    const n = parseFloat(s)
    return !Number.isNaN(n) && n >= 0
  }

  function looksLikeGender(val) {
    const v = normalized(String(val))
    return /^(m|f|maschio|femmina|uomo|donna|male|female|u|d)$/.test(v)
  }

  headers.forEach((header, index) => {
    const gScore = scoreHeader(header, genderKeywords)
    const baseScore = scoreHeader(header, baseKeywords)
    const varScore = scoreHeader(header, variableKeywords)
    const totScore = scoreHeader(header, totalKeywords)
    const catScore = scoreHeader(header, categoryKeywords)

    const genderMatch = sample.filter((r) => looksLikeGender(r[header])).length
    if (genderMatch > sample.length * 0.3 && (gScore > 0 || genderMatch > sample.length * 0.8))
      suggestions[COLUMN_ROLES.gender] = index

    const numMatch = sample.filter((r) => looksLikeNumber(r[header])).length
    if (numMatch > sample.length * 0.5) {
      if (baseScore >= varScore && baseScore >= totScore && suggestions[COLUMN_ROLES.baseSalary] === undefined)
        suggestions[COLUMN_ROLES.baseSalary] = index
      if (varScore > 0 && suggestions[COLUMN_ROLES.variableComponents] === undefined)
        suggestions[COLUMN_ROLES.variableComponents] = index
      if (totScore > 0 && suggestions[COLUMN_ROLES.totalSalary] === undefined)
        suggestions[COLUMN_ROLES.totalSalary] = index
    }
    if (baseScore > 0 && numMatch > sample.length * 0.3 && suggestions[COLUMN_ROLES.baseSalary] === undefined)
      suggestions[COLUMN_ROLES.baseSalary] = index
    if (varScore > 0 && numMatch > sample.length * 0.3 && suggestions[COLUMN_ROLES.variableComponents] === undefined)
      suggestions[COLUMN_ROLES.variableComponents] = index
    if (totScore > 0 && numMatch > sample.length * 0.3 && suggestions[COLUMN_ROLES.totalSalary] === undefined)
      suggestions[COLUMN_ROLES.totalSalary] = index

    if (catScore > 0 && suggestions[COLUMN_ROLES.category] === undefined)
      suggestions[COLUMN_ROLES.category] = index
  })

  return suggestions
}

/**
 * Dato mapping { role: columnIndex } e rows, restituisce array di record normalizzati.
 */
export function buildNormalizedData(rows, headers, mapping) {
  const roleToKey = {}
  Object.entries(mapping).forEach(([role, colIndex]) => {
    if (typeof colIndex === 'number' && colIndex >= 0 && headers[colIndex] != null)
      roleToKey[role] = headers[colIndex]
  })

  return rows
    .map((row) => {
      const num = (key) => {
        const v = row[key]
        if (v == null || v === '') return 0
        const s = String(v).replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
        const n = parseFloat(s)
        return Number.isNaN(n) ? 0 : n
      }
      const gender = roleToKey[COLUMN_ROLES.gender] ? row[roleToKey[COLUMN_ROLES.gender]] : null
      const g = normalizeGender(gender)

      return {
        gender: g,
        baseSalary: num(roleToKey[COLUMN_ROLES.baseSalary] ?? ''),
        variableComponents: num(roleToKey[COLUMN_ROLES.variableComponents] ?? ''),
        totalSalary: num(roleToKey[COLUMN_ROLES.totalSalary] ?? '') || null,
        category: roleToKey[COLUMN_ROLES.category] ? String(row[roleToKey[COLUMN_ROLES.category]] || '').trim() : '',
      }
    })
    .map((r) => ({
      ...r,
      totalSalary: r.totalSalary != null && r.totalSalary > 0 ? r.totalSalary : r.baseSalary + r.variableComponents,
    }))
    .filter((r) => r.gender !== null)
}

function normalizeGender(val) {
  const v = String(val ?? '').toLowerCase().trim()
  if (/^(m|maschio|male|uomo|u)$/.test(v)) return 'M'
  if (/^(f|femmina|female|donna|d)$/.test(v)) return 'F'
  return null
}
