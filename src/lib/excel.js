import * as XLSX from 'xlsx'

export const COLUMN_ROLES = {
  gender: 'gender',
  employeeName: 'employeeName',
  baseSalary: 'baseSalary',
  variableComponents: 'variableComponents',
  totalSalary: 'totalSalary',
  category: 'category',
  role: 'role',
  level: 'level',
  description: 'description',
  /** Anni di servizio, data ingresso o simile (utile come giustificativo oggettivo) */
  seniority: 'seniority',
}

export function getRoleLabel(role) {
  const labels = {
    [COLUMN_ROLES.gender]: 'Genere (M/F)',
    [COLUMN_ROLES.employeeName]: 'Nome dipendente',
    [COLUMN_ROLES.baseSalary]: 'Retribuzione base annua',
    [COLUMN_ROLES.variableComponents]: 'Componenti variabili',
    [COLUMN_ROLES.totalSalary]: 'Retribuzione totale annua',
    [COLUMN_ROLES.category]: 'Categoria / inquadramento',
    [COLUMN_ROLES.role]: 'Ruolo',
    [COLUMN_ROLES.level]: 'Livello contrattuale (es. Q, B1, C3)',
    [COLUMN_ROLES.description]: 'Descrizione ruolo',
    [COLUMN_ROLES.seniority]: 'Anzianità (anni, data ingresso o simile)',
  }
  return labels[role] ?? role
}

function detectHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = rows[i]
    if (!row || !Array.isArray(row)) continue
    const nonEmpty = row.filter((c) => c != null && String(c).trim() !== '')
    if (nonEmpty.length < 2) continue
    const strings = nonEmpty.filter((c) => typeof c === 'string' && isNaN(Number(c)))
    const textRatio = strings.length / nonEmpty.length
    const avgLen = strings.reduce((s, c) => s + String(c).length, 0) / (strings.length || 1)
    if (textRatio >= 0.5 && avgLen > 2) return i
  }
  return 0
}

function expandSheetRangeIfNeeded(sheet) {
  if (!sheet || typeof sheet !== 'object') return

  // Alcuni export hanno !ref troncato (es. A1:Z100) anche se esistono celle oltre.
  // In quel caso sheet_to_json legge solo il range !ref e sembra "fermarsi" a 100 righe.
  const cellKeys = Object.keys(sheet).filter((k) => !k.startsWith('!'))
  if (!cellKeys.length) return

  let minR = Number.POSITIVE_INFINITY
  let minC = Number.POSITIVE_INFINITY
  let maxR = -1
  let maxC = -1

  for (const key of cellKeys) {
    const cell = XLSX.utils.decode_cell(key)
    if (cell.r < minR) minR = cell.r
    if (cell.c < minC) minC = cell.c
    if (cell.r > maxR) maxR = cell.r
    if (cell.c > maxC) maxC = cell.c
  }

  if (maxR < 0 || maxC < 0) return
  const computedRef = XLSX.utils.encode_range({
    s: { r: Number.isFinite(minR) ? minR : 0, c: Number.isFinite(minC) ? minC : 0 },
    e: { r: maxR, c: maxC },
  })

  const existingRef = sheet['!ref']
  if (!existingRef) {
    sheet['!ref'] = computedRef
    return
  }

  try {
    const existing = XLSX.utils.decode_range(existingRef)
    // Aggiorna solo se il range dichiarato è più piccolo del range reale trovato.
    if (existing.e.r < maxR || existing.e.c < maxC) {
      sheet['!ref'] = computedRef
    }
  } catch {
    sheet['!ref'] = computedRef
  }
}

function parseExcelArrayBuffer(arrayBuffer, contentType = '') {
  const bytes = new Uint8Array(arrayBuffer)
  const startsWithZip =
    bytes.length >= 2 &&
    bytes[0] === 0x50 && // P
    bytes[1] === 0x4b // K
  const asTextProbe = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 512)).trimStart().toLowerCase()
  const looksLikeHtml = asTextProbe.startsWith('<!doctype html') || asTextProbe.startsWith('<html')
  const looksLikeCsv = asTextProbe.includes(',') && (asTextProbe.includes('\n') || asTextProbe.includes('\r'))

  // Se l'URL restituisce una pagina HTML (preview/login) SheetJS può leggere solo una tabella parziale
  // (spesso 100 righe). In quel caso interrompiamo con messaggio esplicito.
  if (looksLikeHtml || (!startsWithZip && contentType.includes('text/html'))) {
    throw new Error(
      'Il link non punta al file Excel diretto (restituisce HTML/preview). Usa un URL di download diretto del .xlsx.'
    )
  }

  // Supporto CSV diretto (Google Sheets/BI export): evita il parsing "best effort" che può troncare dati.
  if (!startsWithZip && (contentType.includes('text/csv') || looksLikeCsv)) {
    const csvText = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    const workbookFromCsv = XLSX.read(csvText, { type: 'string' })
    const firstSheetName = workbookFromCsv.SheetNames[0]
    const firstSheet = workbookFromCsv.Sheets[firstSheetName]
    const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: null, raw: true })
    if (!rows.length) return { rows: [], headers: [] }
    const headerRowIndex = detectHeaderRow(rows)
    const headers = (rows[headerRowIndex] || []).map((h) => String(h ?? '').trim())
    const dataRows = rows.slice(headerRowIndex + 1)
    return { headers, rows: dataRows }
  }

  const workbook = XLSX.read(arrayBuffer, { type: 'array' })
  let best = { headers: [], rows: [], nonEmptyDataRows: -1 }

  // Alcuni file hanno il dataset "principale" in un foglio diverso dal primo.
  // Selezioniamo il foglio con più righe dati non vuote.
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) continue
    expandSheetRangeIfNeeded(sheet)

    // raw: true (default) → numeri come number JS. raw: false produce stringhe formattate (anche in formato US)
    // che rompono parseNumber italiano (punto decimale rimosso come migliaia) e gonfiano le retribuzioni.
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true })
    if (!rows.length) continue

    const headerRowIndex = detectHeaderRow(rows)
    const headers = (rows[headerRowIndex] || []).map((h) => String(h ?? '').trim())
    const dataRows = rows.slice(headerRowIndex + 1)
    const nonEmptyDataRows = dataRows.filter(
      (row) => Array.isArray(row) && row.some((c) => c != null && String(c).trim() !== '')
    ).length

    if (nonEmptyDataRows > best.nonEmptyDataRows) {
      best = { headers, rows: dataRows, nonEmptyDataRows }
    }
  }

  return {
    headers: best.headers,
    rows: best.rows,
  }
}

export async function parseExcelFromUrl(url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Download non riuscito (${response.status})`)
  }
  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  const arrayBuffer = await response.arrayBuffer()
  return parseExcelArrayBuffer(arrayBuffer, contentType)
}

export async function parseExcelFromFile(file) {
  if (!file) throw new Error('Nessun file selezionato.')
  const arrayBuffer = await file.arrayBuffer()
  const contentType = String(file.type || '').toLowerCase()
  return parseExcelArrayBuffer(arrayBuffer, contentType)
}

export function detectColumnRoles(headers, rows) {
  const result = {}
  const lower = headers.map((h) => String(h || '').toLowerCase())

  const find = (...candidates) =>
    lower.findIndex((h) => candidates.some((c) => h.includes(c))) ?? -1

  const genderIdx = find('genere', 'gender', 'sesso', 'sex', 'm/f', 'f/m')
  if (genderIdx >= 0) result[COLUMN_ROLES.gender] = genderIdx

  const nameIdx = find('nome', 'cognome', 'employee')
  if (nameIdx >= 0) result[COLUMN_ROLES.employeeName] = nameIdx

  const baseIdx = find('base', 'ral', 'retribuzione base')
  if (baseIdx >= 0) result[COLUMN_ROLES.baseSalary] = baseIdx

  const varIdx = find('variabil', 'bonus', 'premio')
  if (varIdx >= 0) result[COLUMN_ROLES.variableComponents] = varIdx

  const totIdx = find('totale', 'total')
  if (totIdx >= 0) result[COLUMN_ROLES.totalSalary] = totIdx

  const catIdx = find('categoria', 'inquadramento')
  if (catIdx >= 0) result[COLUMN_ROLES.category] = catIdx

  const roleIdx = find('ruolo', 'job title', 'posizione')
  if (roleIdx >= 0) result[COLUMN_ROLES.role] = roleIdx

  const levelIdx = find('livello', 'grade', 'band')
  if (levelIdx >= 0) result[COLUMN_ROLES.level] = levelIdx

  const descIdx = find('descrizione', 'description', 'mansione')
  if (descIdx >= 0) result[COLUMN_ROLES.description] = descIdx

  const senIdx = find('anzian', 'anzianit', 'seniority', 'anz. servizio', 'data assunzione', 'data ingresso', 'anni servizio')
  if (senIdx >= 0) result[COLUMN_ROLES.seniority] = senIdx

  return result
}

export function buildNormalizedData(rows, headers, mapping) {
  if (!rows?.length || !headers?.length || !mapping) return []

  const idx = (key) =>
    Object.prototype.hasOwnProperty.call(mapping, key) ? mapping[key] : undefined

  const genderIdx = idx(COLUMN_ROLES.gender)
  const nameIdx = idx(COLUMN_ROLES.employeeName)
  const baseIdx = idx(COLUMN_ROLES.baseSalary)
  const varIdx = idx(COLUMN_ROLES.variableComponents)
  const totalIdx = idx(COLUMN_ROLES.totalSalary)
  const catIdx = idx(COLUMN_ROLES.category)
  const roleIdx = idx(COLUMN_ROLES.role)
  const levelIdx = idx(COLUMN_ROLES.level)
  const descIdx = idx(COLUMN_ROLES.description)

  const parseNumber = (value) => {
    if (value == null || value === '') return 0
    if (typeof value === 'number') return value
    const cleaned = String(value)
      .replace(/\./g, '')
      .replace(/,/g, '.')
      .replace(/[^\d.-]/g, '')
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : 0
  }

  function normalizeGender(raw) {
    if (raw == null || raw === '') return null
    const s = String(raw).trim().toLowerCase()
    if (s === 'm' || s === 'maschio' || s === 'male' || s === 'uomo' || s === 'u' || s === 'h' || s === 'homme') return 'M'
    if (s === 'f' || s === 'femmina' || s === 'female' || s === 'donna' || s === 'd' || s === 'femme') return 'F'
    const first = s.charAt(0)
    if (first === 'm' || first === 'u' || first === 'h') return 'M'
    if (first === 'f' || first === 'd') return 'F'
    return null
  }

  return rows
    .map((row, idx) => {
      const genderRaw = genderIdx != null ? row[genderIdx] : null
      const gender = normalizeGender(genderRaw)

      return {
        index: idx + 1,
        gender,
        name: nameIdx != null ? row[nameIdx] : null,
        baseSalary: baseIdx != null ? parseNumber(row[baseIdx]) : 0,
        variableComponents: varIdx != null ? parseNumber(row[varIdx]) : 0,
        totalSalary:
          totalIdx != null
            ? parseNumber(row[totalIdx])
            : parseNumber(row[baseIdx]) + parseNumber(row[varIdx]),
        category: catIdx != null ? row[catIdx] : null,
        role: roleIdx != null ? row[roleIdx] : null,
        level: levelIdx != null ? row[levelIdx] : null,
        description: descIdx != null ? row[descIdx] : null,
      }
    })
    .filter((r) => r.gender === 'M' || r.gender === 'F')
}

