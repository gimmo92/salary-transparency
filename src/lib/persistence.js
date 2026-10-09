const hasWindow = typeof window !== 'undefined'
const STORAGE_KEY_ANALYSES = 'salary-transparency-analyses'
const STORAGE_KEY_RULES = 'salary-transparency-rules'
const MIGRATED_FLAG = 'salary-transparency-analyses-idb-v1'
const DB_NAME = 'salary-transparency'
const DB_VERSION = 1
const STORE = 'analyses'

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
  } catch (err) {
    const quota = err && (err.name === 'QuotaExceededError' || err.code === 22)
    if (quota) {
      throw new Error(
        'Spazio del browser esaurito: lo storico non è stato salvato. I dati restano solo in questa sessione finché non si libera spazio.',
      )
    }
    throw err
  }
}

function randomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function plain(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

let dbPromise = null

function openDb() {
  if (!hasWindow || !window.indexedDB) {
    return Promise.reject(new Error('Archivio locale non disponibile in questo browser.'))
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = window.indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => {
        dbPromise = null
        reject(req.error || new Error('Impossibile aprire lo storico.'))
      }
    })
  }
  return dbPromise
}

async function idbGetAll() {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error || new Error('Lettura dello storico non riuscita.'))
    tx.onerror = () => reject(tx.error || new Error('Lettura dello storico non riuscita.'))
  })
}

async function idbPut(record) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('Scrittura dello storico non riuscita.'))
    tx.onabort = () => reject(tx.error || new Error('Scrittura dello storico annullata.'))
    tx.objectStore(STORE).put(record)
  })
}

async function idbDelete(id) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('Eliminazione dallo storico non riuscita.'))
    tx.onabort = () => reject(tx.error || new Error('Eliminazione dallo storico annullata.'))
    tx.objectStore(STORE).delete(id)
  })
}

function idbGet(id) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly')
        const req = tx.objectStore(STORE).get(id)
        req.onsuccess = () => resolve(req.result || null)
        req.onerror = () => reject(req.error || new Error('Lettura dello storico non riuscita.'))
      }),
  )
}

async function migrateLegacyAnalyses() {
  if (!hasWindow) return
  if (window.localStorage.getItem(MIGRATED_FLAG) === '1') return
  const legacy = loadFromStorage(STORAGE_KEY_ANALYSES)
  if (legacy.length) {
    const existing = await idbGetAll()
    const ids = new Set(existing.map((r) => r.id))
    for (const rec of legacy) {
      if (!rec?.id || ids.has(rec.id)) continue
      await idbPut(rec)
    }
  }
  window.localStorage.setItem(MIGRATED_FLAG, '1')
  window.localStorage.removeItem(STORAGE_KEY_ANALYSES)
}

function toSummary(record) {
  if (!record) return null
  const rows = record.rows_json
  const { rows_json, ...rest } = record
  return {
    ...rest,
    row_count: Array.isArray(rows) ? rows.length : record.snapshot_json?.n ?? null,
  }
}

function sortNewest(list) {
  return [...list].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
}

// Analisi Excel ----------------------------------------------------------------

export async function saveAnalysis(payload) {
  await migrateLegacyAnalyses()
  const record = {
    id: randomId(),
    created_at: new Date().toISOString(),
    analysis_type: payload.analysisType,
    source_url: payload.sourceUrl || '',
    header_row_index: payload.headerRowIndex ?? null,
    headers_json: plain(payload.headers || []),
    mapping_json: plain(payload.mapping || {}),
    rows_json: plain(payload.rows || []),
    snapshot_json: plain(payload.snapshot || null),
    overrides_json: plain(payload.overrides || {}),
    results_json: payload.results || null,
    calculation_source: payload.calculationSource || '',
  }
  await idbPut(record)
  return record
}

export async function fetchAnalyses() {
  await migrateLegacyAnalyses()
  const all = await idbGetAll()
  return sortNewest(all.map(toSummary))
}

export async function fetchAnalysisById(id) {
  await migrateLegacyAnalyses()
  const found = await idbGet(id)
  if (!found) throw new Error('Analisi non trovata.')
  return found
}

export async function updateAnalysisSnapshot(id, snapshot) {
  const found = await fetchAnalysisById(id)
  found.snapshot_json = snapshot
  await idbPut(found)
  return found
}

export async function deleteAnalysisById(id) {
  await migrateLegacyAnalyses()
  await idbDelete(id)
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
