const hasWindow = typeof window !== 'undefined'
const STORAGE_KEY_ANALYSES = 'salary-transparency-analyses'
const STORAGE_KEY_RULES = 'salary-transparency-rules'

function loadFromStorage(key) {
  if (!hasWindow) return []
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveToStorage(key, value) {
  if (!hasWindow) return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore
  }
}

function randomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// Analisi Excel ----------------------------------------------------------------

export async function saveAnalysis(payload) {
  const list = loadFromStorage(STORAGE_KEY_ANALYSES)
  const record = {
    id: randomId(),
    created_at: new Date().toISOString(),
    analysis_type: payload.analysisType,
    source_url: payload.sourceUrl,
    header_row_index: payload.headerRowIndex,
    headers_json: payload.headers,
    mapping_json: payload.mapping,
    rows_json: payload.rows,
    results_json: payload.results,
    calculation_source: payload.calculationSource,
  }
  list.unshift(record)
  saveToStorage(STORAGE_KEY_ANALYSES, list)
  return record
}

export async function fetchAnalyses() {
  return loadFromStorage(STORAGE_KEY_ANALYSES)
}

export async function fetchAnalysisById(id) {
  const list = loadFromStorage(STORAGE_KEY_ANALYSES)
  const found = list.find((r) => r.id === id)
  if (!found) throw new Error('Analisi non trovata.')
  return found
}

export async function deleteAnalysisById(id) {
  const list = loadFromStorage(STORAGE_KEY_ANALYSES)
  const next = list.filter((r) => r.id !== id)
  saveToStorage(STORAGE_KEY_ANALYSES, next)
}

// Regole salary review ---------------------------------------------------------

export async function fetchRules() {
  return loadFromStorage(STORAGE_KEY_RULES)
}

export async function saveRule({ name, rule }) {
  const list = loadFromStorage(STORAGE_KEY_RULES)
  const record = {
    id: randomId(),
    name,
    rule_json: rule,
  }
  list.push(record)
  saveToStorage(STORAGE_KEY_RULES, list)
  return record
}

export async function updateRuleById({ id, name, rule }) {
  const list = loadFromStorage(STORAGE_KEY_RULES)
  const idx = list.findIndex((r) => r.id === id)
  if (idx === -1) throw new Error('Regola non trovata.')
  list[idx] = { ...list[idx], name, rule_json: rule }
  saveToStorage(STORAGE_KEY_RULES, list)
}

export async function deleteRuleById(id) {
  const list = loadFromStorage(STORAGE_KEY_RULES)
  const next = list.filter((r) => r.id !== id)
  saveToStorage(STORAGE_KEY_RULES, next)
}

