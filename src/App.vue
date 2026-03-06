<script setup>
import { ref, computed } from 'vue'
import {
  parseExcelFromUrl,
  detectColumnRoles,
  buildNormalizedData,
  COLUMN_ROLES,
  getRoleLabel,
} from './lib/excel.js'
import { computeIndicators } from './lib/indicators.js'
import {
  suggestColumnMappingWithGemini,
  computeIndicatorsWithGemini,
  scoreJobRolesWithGemini,
} from './lib/gemini.js'
import {
  buildNormalizedJobGradingData,
  aggregateRolesForGrading,
  enrichWithBandsAndDeviation,
} from './lib/jobGrading.js'
import { saveAnalysis, fetchAnalyses, deleteAnalysisById } from './lib/persistence.js'

const activeSection = ref('dashboard')
const selectAll = ref(false)
const cards = ref([
  { id: 1, title: 'Gap retributivo di genere', date: '31/12/2025', value: 72, max: 100, selected: false },
  { id: 2, title: 'Conformità normativa D.Lgs. 198/2006', date: '30/06/2025', value: 95, max: 100, selected: false },
  { id: 3, title: 'Trasparenza bandi e posizioni', date: '31/03/2025', value: 58, max: 100, selected: false },
])

const sections = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'analisi', label: 'Analisi', icon: 'table' },
  { id: 'storico', label: 'Storico', icon: 'history' },
  { id: 'report', label: 'Report', icon: 'chart' },
  { id: 'confronti', label: 'Confronti', icon: 'compare' },
  { id: 'normativa', label: 'Normativa', icon: 'law' },
  { id: 'impostazioni', label: 'Impostazioni', icon: 'settings' },
]

// Flusso unificato
const analisiStep = ref('idle') // idle | upload | mapping | results
const excelRows = ref([])
const excelHeaders = ref([])
const columnMapping = ref({})
const excelUrl = ref('')
const headerRowIndex = ref(1)
const uploadError = ref('')
const uploadLoading = ref(false)
const geminiLoading = ref(false)
const analysisLoading = ref(false)
const saveStatus = ref('')

const indicatorsResult = ref(null)
const indicatorsSource = ref('locale')

const jobResults = ref([])
const jobSource = ref('locale')

const resultsTab = ref('genere') // 'genere' | 'pari_valore'

const googleApiKey = (import.meta.env.VITE_GOOGLE_AI_API_KEY || '').trim()

const allRoleKeys = [
  COLUMN_ROLES.gender,
  COLUMN_ROLES.employeeName,
  COLUMN_ROLES.baseSalary,
  COLUMN_ROLES.variableComponents,
  COLUMN_ROLES.totalSalary,
  COLUMN_ROLES.category,
  COLUMN_ROLES.role,
  COLUMN_ROLES.level,
  COLUMN_ROLES.description,
]

const showAnalisiFlow = computed(() => activeSection.value === 'analisi')
const showStorico = computed(() => activeSection.value === 'storico')

// Storico
const storicoList = ref([])
const storicoLoading = ref(false)
const storicoError = ref('')
const storicoDeleting = ref(null)

async function loadStorico() {
  storicoLoading.value = true
  storicoError.value = ''
  try {
    storicoList.value = await fetchAnalyses()
  } catch (err) {
    storicoError.value = err.message || 'Impossibile caricare lo storico.'
  } finally {
    storicoLoading.value = false
  }
}

async function removeAnalysis(id) {
  if (!confirm('Eliminare questa analisi?')) return
  storicoDeleting.value = id
  try {
    await deleteAnalysisById(id)
    storicoList.value = storicoList.value.filter((a) => a.id !== id)
  } catch (err) {
    storicoError.value = 'Eliminazione non riuscita: ' + (err.message || String(err))
  } finally {
    storicoDeleting.value = null
  }
}

function formatDate(iso) {
  if (!iso) return '–'
  const d = new Date(iso)
  return d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function analysisTypeLabel(t) {
  if (t === 'pay_transparency') return 'Trasparenza salariale'
  if (t === 'job_grading') return 'Job Grading'
  if (t === 'combined') return 'Analisi completa'
  return t || '–'
}

function isGapAlert(pct) {
  return pct != null && Math.abs(pct) > 5
}

// Job grading helpers
const expandedRoles = ref(new Set())

function toggleRoleExpand(role) {
  if (expandedRoles.value.has(role)) expandedRoles.value.delete(role)
  else expandedRoles.value.add(role)
  expandedRoles.value = new Set(expandedRoles.value)
}

function onScoreEdit(r) {
  r.totalScore = (Number(r.competenze_richieste) || 0)
    + (Number(r.responsabilita) || 0)
    + (Number(r.sforzo_mentale) || 0)
    + (Number(r.condizioni_lavorative) || 0)
  recalcBandsAndDeviation()
}

function recalcBandsAndDeviation() {
  const sorted = [...jobResults.value].sort((a, b) => b.totalScore - a.totalScore)
  const n = sorted.length
  const bandSize = Math.ceil(n / 5)
  sorted.forEach((r, i) => { r.band = Math.min(5, Math.floor(i / bandSize) + 1) })
  for (let b = 1; b <= 5; b++) {
    const inBand = sorted.filter((x) => x.band === b)
    const avg = inBand.length ? inBand.reduce((s, x) => s + (Number(x.avgTotalSalary) || 0), 0) / inBand.length : 0
    inBand.forEach((r) => {
      r.deviationFromBandAvgPct = avg ? (((Number(r.avgTotalSalary) || 0) - avg) / avg) * 100 : 0
    })
  }
  jobResults.value = sorted
}

function fallbackLocalJobScores(roles) {
  return roles.map((r) => {
    const text = `${r.role || ''} ${r.level || ''} ${r.description || ''}`.toLowerCase()
    const clamp = (x) => Math.max(0, Math.min(100, Math.round(x)))
    const kw = (list) => list.reduce((c, w) => c + (text.includes(w) ? 1 : 0), 0)
    const competenze = clamp(35 + kw(['specialist', 'tecnico', 'engineer', 'analyst', 'senior']) * 10 + text.length / 50)
    const responsabilita = clamp(30 + kw(['manager', 'responsabile', 'head', 'direttore', 'lead']) * 14 + (r.level?.length || 0) * 2)
    const sforzo = clamp(30 + kw(['controllo', 'strateg', 'analisi', 'progett', 'decision']) * 9 + text.length / 70)
    const condizioni = clamp(25 + kw(['turno', 'notte', 'impianto', 'produzione', 'stabilimento']) * 12)
    const totalScore = competenze + responsabilita + sforzo + condizioni
    return { role: r.role, competenze_richieste: competenze, responsabilita, sforzo_mentale: sforzo, condizioni_lavorative: condizioni, totalScore }
  })
}

// Flusso unificato
function startNuovaAnalisi() {
  activeSection.value = 'analisi'
  analisiStep.value = 'upload'
  uploadError.value = ''
  indicatorsResult.value = null
  jobResults.value = []
  saveStatus.value = ''
  resultsTab.value = 'genere'
}

function goToUpload() {
  analisiStep.value = 'upload'
  uploadError.value = ''
}

async function onLoadFromUrl() {
  const url = (excelUrl.value || '').trim()
  if (!url) { uploadError.value = 'Inserisci il collegamento al file Excel.'; return }
  uploadError.value = ''
  uploadLoading.value = true
  geminiLoading.value = false
  try {
    const { rows, headers } = await parseExcelFromUrl(url, { headerRowIndex: headerRowIndex.value })
    excelRows.value = rows
    excelHeaders.value = headers
    const heuristic = detectColumnRoles(headers, rows)
    let suggested = { ...heuristic }
    if (googleApiKey) {
      geminiLoading.value = true
      try {
        const geminiMapping = await suggestColumnMappingWithGemini(googleApiKey, headers, rows)
        if (geminiMapping && Object.keys(geminiMapping).length > 0)
          suggested = { ...heuristic, ...geminiMapping }
      } catch (geminiErr) {
        uploadError.value = 'Riconoscimento AI non riuscito: ' + (geminiErr.message || String(geminiErr)) + '. Usa il mapping manuale.'
      } finally { geminiLoading.value = false }
    } else {
      uploadError.value = 'Gemini non attivo: manca VITE_GOOGLE_AI_API_KEY. Uso mapping euristico.'
    }
    columnMapping.value = suggested
    analisiStep.value = 'mapping'
  } catch (err) {
    uploadError.value = err.message || 'Impossibile leggere il file.'
  } finally { uploadLoading.value = false }
}

async function confirmMapping() {
  if (analysisLoading.value) return
  analysisLoading.value = true
  uploadError.value = ''
  try {
    // --- Analisi di genere ---
    const normalizedGender = buildNormalizedData(excelRows.value, excelHeaders.value, columnMapping.value)
    if (normalizedGender.length > 0) {
      const localIndicators = computeIndicators(normalizedGender)
      if (googleApiKey) {
        geminiLoading.value = true
        try {
          const aiIndicators = await computeIndicatorsWithGemini(googleApiKey, normalizedGender)
          const aiGap = aiIndicators?.b_divarioComponentiVariabili?.percentuale
          const localGap = localIndicators?.b_divarioComponentiVariabili?.percentuale
          const comparable = Number.isFinite(aiGap) && Number.isFinite(localGap)
          const delta = comparable ? Math.abs(aiGap - localGap) : 0
          if (comparable && delta > 10) {
            indicatorsResult.value = localIndicators
            indicatorsSource.value = 'locale'
            uploadError.value = `Calcolo AI scartato per incoerenza (delta ${delta.toFixed(2)} punti). Uso motore locale.`
          } else {
            indicatorsResult.value = {
              ...aiIndicators,
              h_divarioRetribuzioneBase: aiIndicators?.h_divarioRetribuzioneBase ?? localIndicators.h_divarioRetribuzioneBase,
            }
            indicatorsSource.value = 'ai'
          }
        } catch (aiErr) {
          indicatorsResult.value = localIndicators
          indicatorsSource.value = 'locale'
          uploadError.value = 'Calcolo AI non riuscito, uso fallback locale: ' + (aiErr.message || String(aiErr))
        } finally { geminiLoading.value = false }
      } else {
        indicatorsResult.value = localIndicators
        indicatorsSource.value = 'locale'
      }
    } else {
      indicatorsResult.value = null
    }

    // --- Job grading (lavori di pari valore) ---
    const normalizedJob = buildNormalizedJobGradingData(excelRows.value, excelHeaders.value, columnMapping.value)
    if (normalizedJob.length > 0) {
      const aggregated = aggregateRolesForGrading(normalizedJob)
      let scored = fallbackLocalJobScores(aggregated)
      jobSource.value = 'locale'

      if (googleApiKey) {
        geminiLoading.value = true
        try {
          const aiInput = aggregated.map((r) => ({ role: r.role, level: r.level, job_description: r.description }))
          const aiScores = await scoreJobRolesWithGemini(googleApiKey, aiInput)
          const mapAi = new Map(aiScores.map((x) => [String(x.role || '').toLowerCase().trim(), x]))
          scored = aggregated.map((r) => {
            const ai = mapAi.get(String(r.role || '').toLowerCase().trim())
            if (!ai) return { ...fallbackLocalJobScores([r])[0], role: r.role }
            const c = Number(ai.competenze_richieste ?? 0), resp = Number(ai.responsabilita ?? 0)
            const s = Number(ai.sforzo_mentale ?? 0), cond = Number(ai.condizioni_lavorative ?? 0)
            return { role: r.role, competenze_richieste: c, responsabilita: resp, sforzo_mentale: s, condizioni_lavorative: cond, totalScore: Number(ai.totalScore ?? (c + resp + s + cond)) }
          })
          jobSource.value = 'ai'
        } catch (err) {
          uploadError.value += (uploadError.value ? ' | ' : '') + 'Job Grading AI fallback locale: ' + (err.message || String(err))
        } finally { geminiLoading.value = false }
      }

      const merged = aggregated.map((r) => ({ ...r, ...(scored.find((x) => x.role === r.role) || {}) }))
      jobResults.value = enrichWithBandsAndDeviation(merged)
    } else {
      jobResults.value = []
    }

    if (!indicatorsResult.value && jobResults.value.length === 0) {
      uploadError.value = 'Nessun dato valido. Verifica il mapping delle colonne (Genere per analisi di genere, Ruolo per job grading).'
      return
    }

    // Salvataggio DB
    try {
      const saved = await saveAnalysis({
        analysisType: 'combined',
        sourceUrl: excelUrl.value,
        headerRowIndex: headerRowIndex.value,
        headers: excelHeaders.value,
        mapping: columnMapping.value,
        rows: excelRows.value.slice(0, 500),
        results: { gender: indicatorsResult.value, jobGrading: jobResults.value },
        calculationSource: `gender:${indicatorsSource.value},job:${jobSource.value}`,
      })
      saveStatus.value = `Analisi salvata nel database (ID: ${saved.id})`
    } catch (saveErr) {
      saveStatus.value = `Analisi non salvata: ${saveErr.message || String(saveErr)}`
    }

    resultsTab.value = indicatorsResult.value ? 'genere' : 'pari_valore'
    analisiStep.value = 'results'
  } finally { analysisLoading.value = false }
}

function toggleSelectAll() {
  selectAll.value = !selectAll.value
  cards.value = cards.value.map(c => ({ ...c, selected: selectAll.value }))
}

function toggleCard(id) {
  const card = cards.value.find(c => c.id === id)
  if (card) card.selected = !card.selected
  selectAll.value = cards.value.every(c => c.selected)
}

function formatPct(n) { return n == null ? '–' : n.toFixed(2) + '%' }
function formatNum(n) { return n == null ? '–' : Number(n).toLocaleString('it-IT', { maximumFractionDigits: 2 }) }
function scoreBadgeClass(band) { return `band-${band}` }
</script>

<template>
  <div class="app-layout">
    <header class="tab-bar">
      <div class="tab-bar-brand">
        <svg class="logo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
        <span class="logo-text">Analisi TS</span>
      </div>
      <nav class="tabs">
        <button
          v-for="s in sections"
          :key="s.id"
          class="tab"
          :class="{ active: activeSection === s.id }"
          @click="activeSection = s.id; if (s.id === 'analisi' && analisiStep === 'idle') analisiStep = 'upload'; if (s.id === 'storico') loadStorico()"
        >
          <span class="tab-icon">
            <svg v-if="s.icon === 'dashboard'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
            <svg v-else-if="s.icon === 'table'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18"/></svg>
            <svg v-else-if="s.icon === 'chart'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
            <svg v-else-if="s.icon === 'history'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <svg v-else-if="s.icon === 'compare'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 3h5v5M8 21H3v-5M21 3l-9 9M3 21l9-9"/></svg>
            <svg v-else-if="s.icon === 'law'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
          </span>
          <span class="tab-label">{{ s.label }}</span>
        </button>
      </nav>
    </header>

    <div class="main-wrap">
    <header class="main-header">
      <button class="btn-primary" @click="startNuovaAnalisi">
        <span>NUOVA ANALISI</span>
      </button>
      <button class="btn-icon" aria-label="Impostazioni">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
      </button>
    </header>

    <!-- Flusso unificato: Upload → Mapping → Risultati (2 sub-tab) -->
    <template v-if="showAnalisiFlow">
      <!-- Step 1: Link Excel -->
      <div v-if="analisiStep === 'upload'" class="analisi-content">
        <h2 class="analisi-title">Collegamento al file Excel</h2>
        <p class="analisi-desc">Incolla il link a un file Excel (.xlsx) in cloud. L'app mapperà automaticamente le colonne per l'analisi di genere e la valutazione dei lavori di pari valore (job grading).</p>
        <div class="url-input-wrap">
          <input v-model="excelUrl" type="url" class="url-input" placeholder="https://... file.xlsx" :disabled="uploadLoading || geminiLoading" @keydown.enter="onLoadFromUrl" />
          <button type="button" class="btn-primary" :disabled="uploadLoading || geminiLoading || !excelUrl.trim()" @click="onLoadFromUrl">
            <span v-if="uploadLoading">Scaricamento…</span>
            <span v-else-if="geminiLoading">Riconoscimento colonne…</span>
            <span v-else>Carica e mappa colonne</span>
          </button>
        </div>
        <div class="header-row-option">
          <label>Intestazioni colonne nella riga:</label>
          <select v-model.number="headerRowIndex" class="header-row-select">
            <option :value="0">1 (prima riga)</option>
            <option :value="1">2 (seconda riga)</option>
          </select>
          <span class="header-row-hint">Usa «2» se la prima riga è vuota o contiene numeri.</span>
        </div>
        <p class="api-key-warn">Stato Gemini: <strong>{{ googleApiKey ? 'attivo' : 'non attivo' }}</strong></p>
        <p class="url-hint">Puoi incollare un link Google Sheets: verrà convertito in download .xlsx.</p>
        <p v-if="uploadError" class="upload-error">{{ uploadError }}</p>
      </div>

      <!-- Step 2: Mapping colonne unificato -->
      <div v-else-if="analisiStep === 'mapping'" class="analisi-content">
        <h2 class="analisi-title">Verifica assegnazione colonne</h2>
        <p class="analisi-desc">Associa ogni dato richiesto alla colonna corrispondente del file. I campi servono sia per l'analisi di genere sia per il job grading.</p>
        <div class="mapping-table">
          <div class="mapping-row header">
            <span>Dato richiesto</span>
            <span>Colonna nel file</span>
          </div>
          <div v-for="role in allRoleKeys" :key="role" class="mapping-row">
            <span>{{ getRoleLabel(role) }}</span>
            <select v-model.number="columnMapping[role]" class="mapping-select" :disabled="analysisLoading">
              <option :value="undefined">– Nessuna –</option>
              <option v-for="(h, i) in excelHeaders" :key="i" :value="i">{{ h }}</option>
            </select>
          </div>
        </div>
        <p v-if="uploadError" class="upload-error">{{ uploadError }}</p>
        <div class="mapping-actions">
          <button class="btn-secondary" :disabled="analysisLoading" @click="goToUpload">Indietro</button>
          <button class="btn-primary" :disabled="analysisLoading" @click="confirmMapping">
            <span v-if="analysisLoading">Generazione analisi...</span>
            <span v-else>Esegui analisi completa</span>
          </button>
        </div>
        <div v-if="analysisLoading" class="analysis-loader">
          <span class="spinner" aria-hidden="true"></span>
          <span>Elaboro analisi di genere e job grading...</span>
        </div>
      </div>

      <!-- Step 3: Risultati con sub-tab -->
      <div v-else-if="analisiStep === 'results'" class="analisi-content results">
        <h2 class="analisi-title">Risultati analisi</h2>
        <p v-if="saveStatus" class="save-status">{{ saveStatus }}</p>
        <p v-if="uploadError" class="upload-error">{{ uploadError }}</p>

        <div class="results-subtabs">
          <button class="subtab" :class="{ active: resultsTab === 'genere' }" :disabled="!indicatorsResult" @click="resultsTab = 'genere'">Analisi di genere</button>
          <button class="subtab" :class="{ active: resultsTab === 'pari_valore' }" :disabled="jobResults.length === 0" @click="resultsTab = 'pari_valore'">Lavori di pari valore</button>
        </div>

        <!-- Sub-tab: Analisi di genere -->
        <div v-if="resultsTab === 'genere' && indicatorsResult">
          <p class="result-source">Calcolo: <strong>{{ indicatorsSource === 'ai' ? 'Gemini (AI)' : 'Motore locale' }}</strong></p>
          <div class="indicator-cards">
            <section class="indicator-card">
              <h3>(a) Divario retributivo di genere</h3>
              <p class="indicator-desc">{{ indicatorsResult.a_divarioRetributivoGenere.descrizione }}</p>
              <div class="indicator-value" :class="{ 'gap-alert': isGapAlert(indicatorsResult.a_divarioRetributivoGenere.percentuale) }">{{ formatPct(indicatorsResult.a_divarioRetributivoGenere.percentuale) }}</div>
              <p class="indicator-detail">Media M: {{ formatNum(indicatorsResult.a_divarioRetributivoGenere.mediaMaschile) }} · Media F: {{ formatNum(indicatorsResult.a_divarioRetributivoGenere.mediaFemminile) }}</p>
              <p class="indicator-detail">N maschi: {{ indicatorsResult.a_divarioRetributivoGenere.nMaschi }} · N femmine: {{ indicatorsResult.a_divarioRetributivoGenere.nFemmine }}</p>
            </section>
            <section class="indicator-card">
              <h3>(b) Divario nelle componenti variabili</h3>
              <p class="indicator-desc">{{ indicatorsResult.b_divarioComponentiVariabili.descrizione }}</p>
              <div class="indicator-value" :class="{ 'gap-alert': isGapAlert(indicatorsResult.b_divarioComponentiVariabili.percentuale) }">{{ formatPct(indicatorsResult.b_divarioComponentiVariabili.percentuale) }}</div>
              <p class="indicator-detail">Media M: {{ formatNum(indicatorsResult.b_divarioComponentiVariabili.mediaMaschile) }} · Media F: {{ formatNum(indicatorsResult.b_divarioComponentiVariabili.mediaFemminile) }}</p>
            </section>
            <section class="indicator-card">
              <h3>Divario retribuzione base</h3>
              <p class="indicator-desc">{{ indicatorsResult.h_divarioRetribuzioneBase?.descrizione || 'Divario retributivo di genere sulla retribuzione base' }}</p>
              <div class="indicator-value" :class="{ 'gap-alert': isGapAlert(indicatorsResult.h_divarioRetribuzioneBase?.percentuale) }">{{ formatPct(indicatorsResult.h_divarioRetribuzioneBase?.percentuale) }}</div>
              <p class="indicator-detail">Media M: {{ formatNum(indicatorsResult.h_divarioRetribuzioneBase?.mediaMaschile) }} · Media F: {{ formatNum(indicatorsResult.h_divarioRetribuzioneBase?.mediaFemminile) }}</p>
            </section>
            <section class="indicator-card">
              <h3>(c) Divario mediano di genere</h3>
              <p class="indicator-desc">{{ indicatorsResult.c_divarioMedianoGenere.descrizione }}</p>
              <div class="indicator-value" :class="{ 'gap-alert': isGapAlert(indicatorsResult.c_divarioMedianoGenere.percentuale) }">{{ formatPct(indicatorsResult.c_divarioMedianoGenere.percentuale) }}</div>
              <p class="indicator-detail">Mediana M: {{ formatNum(indicatorsResult.c_divarioMedianoGenere.medianaMaschile) }} · Mediana F: {{ formatNum(indicatorsResult.c_divarioMedianoGenere.medianaFemminile) }}</p>
            </section>
            <section class="indicator-card">
              <h3>(d) Divario mediano nelle componenti variabili</h3>
              <p class="indicator-desc">{{ indicatorsResult.d_divarioMedianoComponentiVariabili.descrizione }}</p>
              <div class="indicator-value" :class="{ 'gap-alert': isGapAlert(indicatorsResult.d_divarioMedianoComponentiVariabili.percentuale) }">{{ formatPct(indicatorsResult.d_divarioMedianoComponentiVariabili.percentuale) }}</div>
              <p class="indicator-detail">Mediana M: {{ formatNum(indicatorsResult.d_divarioMedianoComponentiVariabili.medianaMaschile) }} · Mediana F: {{ formatNum(indicatorsResult.d_divarioMedianoComponentiVariabili.medianaFemminile) }}</p>
            </section>
            <section class="indicator-card wide">
              <h3>(e) Percentuale lavoratori con componenti variabili</h3>
              <p class="indicator-desc">{{ indicatorsResult.e_percentualeConComponentiVariabili.descrizione }}</p>
              <div class="indicator-row">
                <div><strong>Femminile:</strong> {{ formatPct(indicatorsResult.e_percentualeConComponentiVariabili.femminile) }} <span class="muted">(n={{ indicatorsResult.e_percentualeConComponentiVariabili.nFemmine }})</span></div>
                <div><strong>Maschile:</strong> {{ formatPct(indicatorsResult.e_percentualeConComponentiVariabili.maschile) }} <span class="muted">(n={{ indicatorsResult.e_percentualeConComponentiVariabili.nMaschi }})</span></div>
              </div>
            </section>
            <section class="indicator-card wide">
              <h3>(f) Percentuale per quartile retributivo</h3>
              <p class="indicator-desc">{{ indicatorsResult.f_percentualePerQuartile.descrizione }}</p>
              <div class="quartile-table">
                <div class="quartile-row header"><span>Quartile</span><span>% Femminile</span><span>% Maschile</span><span>Totale</span></div>
                <div v-for="q in indicatorsResult.f_percentualePerQuartile.quartili" :key="q.quartile" class="quartile-row">
                  <span>Q{{ q.quartile }}</span><span>{{ formatPct(q.femminile) }}</span><span>{{ formatPct(q.maschile) }}</span><span>{{ q.totale }}</span>
                </div>
              </div>
            </section>
            <section class="indicator-card wide">
              <h3>(g) Divario per categoria (base e variabile)</h3>
              <p class="indicator-desc">{{ indicatorsResult.g_divarioPerCategoria.descrizione }}</p>
              <div class="category-table">
                <div class="category-row header"><span>Categoria</span><span>N</span><span>Divario base %</span><span>Divario variabile %</span></div>
                <div v-for="cat in indicatorsResult.g_divarioPerCategoria.perCategoria" :key="cat.categoria" class="category-row">
                  <span>{{ cat.categoria }}</span><span>{{ cat.n }}</span>
                  <span :class="{ 'gap-alert': isGapAlert(cat.divarioBase) }">{{ formatPct(cat.divarioBase) }}</span>
                  <span :class="{ 'gap-alert': isGapAlert(cat.divarioVariabile) }">{{ formatPct(cat.divarioVariabile) }}</span>
                </div>
              </div>
            </section>
          </div>
        </div>
        <div v-else-if="resultsTab === 'genere' && !indicatorsResult" class="no-data-msg">
          Dati di genere non disponibili. Verifica che la colonna Genere (M/F) sia mappata correttamente.
        </div>

        <!-- Sub-tab: Lavori di pari valore -->
        <div v-if="resultsTab === 'pari_valore' && jobResults.length > 0">
          <p class="result-source">Valutazione: <strong>{{ jobSource === 'ai' ? 'Gemini NLP' : 'Fallback locale' }}</strong></p>
          <div v-for="band in [1,2,3,4,5]" :key="band" class="band-section" v-show="jobResults.some(r => r.band === band)">
            <h3 class="band-title" :class="scoreBadgeClass(band)">Fascia {{ band }}</h3>
            <div class="job-table">
              <div class="job-row header">
                <span>Ruolo</span><span>Competenze</span><span>Responsabilità</span><span>Sforzo mentale</span><span>Condizioni</span><span>Totale</span><span>Retrib. media</span><span>Scost. fascia</span><span>N</span>
              </div>
              <template v-for="r in jobResults.filter(x => x.band === band)" :key="`${band}-${r.role}`">
                <div class="job-row clickable" @click="r.n > 1 ? toggleRoleExpand(r.role) : null" :class="{ expanded: expandedRoles.has(r.role) }">
                  <span>
                    <span v-if="r.n > 1" class="expand-icon">{{ expandedRoles.has(r.role) ? '▾' : '▸' }}</span>
                    {{ r.role }} <small v-if="r.level">({{ r.level }})</small>
                  </span>
                  <span><input type="number" class="score-input" v-model.number="r.competenze_richieste" @input="onScoreEdit(r)" @click.stop min="0" max="100" /></span>
                  <span><input type="number" class="score-input" v-model.number="r.responsabilita" @input="onScoreEdit(r)" @click.stop min="0" max="100" /></span>
                  <span><input type="number" class="score-input" v-model.number="r.sforzo_mentale" @input="onScoreEdit(r)" @click.stop min="0" max="100" /></span>
                  <span><input type="number" class="score-input" v-model.number="r.condizioni_lavorative" @input="onScoreEdit(r)" @click.stop min="0" max="100" /></span>
                  <span><strong>{{ formatNum(r.totalScore) }}</strong></span>
                  <span>{{ formatNum(r.avgTotalSalary) }}</span>
                  <span :class="{ 'gap-alert': isGapAlert(r.deviationFromBandAvgPct) }">{{ formatPct(r.deviationFromBandAvgPct) }}</span>
                  <span>{{ r.n }}</span>
                </div>
                <div v-if="expandedRoles.has(r.role) && r.people && r.people.length > 1" class="people-detail">
                  <div class="people-header"><span>#</span><span>Dipendente</span><span>Retr. base</span><span>Comp. variabile</span><span>Retr. totale</span><span>Scost. da media ruolo</span></div>
                  <div v-for="p in r.people" :key="p.index" class="people-row">
                    <span>{{ p.index }}</span><span>{{ p.name || '–' }}</span><span>{{ formatNum(p.baseSalary) }}</span><span>{{ formatNum(p.variableComponents) }}</span><span>{{ formatNum(p.totalSalary) }}</span>
                    <span :class="{ 'gap-alert': isGapAlert(p.deviationFromRoleAvgPct) }">{{ formatPct(p.deviationFromRoleAvgPct) }}</span>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>
        <div v-else-if="resultsTab === 'pari_valore' && jobResults.length === 0" class="no-data-msg">
          Dati job grading non disponibili. Verifica che le colonne Ruolo, Livello e Job Description siano mappate.
        </div>

        <div class="mapping-actions">
          <button class="btn-secondary" @click="analisiStep = 'mapping'">Modifica mapping</button>
          <button class="btn-primary" @click="startNuovaAnalisi">Nuova analisi</button>
        </div>
      </div>
    </template>

    <!-- Storico analisi -->
    <template v-else-if="showStorico">
      <div class="analisi-content">
        <h2 class="analisi-title">Storico analisi</h2>
        <p v-if="storicoLoading" class="storico-status">Caricamento storico…</p>
        <p v-if="storicoError" class="upload-error">{{ storicoError }}</p>
        <div v-if="!storicoLoading && storicoList.length === 0 && !storicoError" class="storico-empty">
          Nessuna analisi salvata.
        </div>
        <div v-if="storicoList.length > 0" class="storico-table-wrap">
          <table class="storico-table">
            <thead>
              <tr>
                <th>Data</th>
                <th>Tipo</th>
                <th>Sorgente</th>
                <th>Calcolo</th>
                <th>ID</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in storicoList" :key="a.id">
                <td>{{ formatDate(a.created_at) }}</td>
                <td>{{ analysisTypeLabel(a.analysis_type) }}</td>
                <td class="storico-url">{{ a.source_url || '–' }}</td>
                <td>{{ a.calculation_source || '–' }}</td>
                <td class="storico-id">{{ a.id.slice(0, 8) }}…</td>
                <td>
                  <button
                    class="btn-delete"
                    :disabled="storicoDeleting === a.id"
                    @click="removeAnalysis(a.id)"
                  >
                    {{ storicoDeleting === a.id ? '…' : 'Elimina' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="mapping-actions">
          <button class="btn-secondary" @click="loadStorico">Aggiorna</button>
        </div>
      </div>
    </template>

    <!-- Dashboard classica -->
    <template v-else>
      <div class="filters">
        <div class="filter-card">
          <label>Ordina per</label>
          <div class="filter-value">Titolo</div>
        </div>
        <div class="filter-card">
          <label>Tipo ordinamento</label>
          <div class="filter-value">Crescente</div>
        </div>
        <div class="filter-card">
          <label>Stato analisi</label>
          <div class="filter-value">In corso</div>
        </div>
        <div class="filter-card">
          <label>Ambito</label>
          <div class="filter-value">Aziendale <span class="arrow">▼</span></div>
        </div>
        <div class="filter-card">
          <label>Tipo analisi</label>
          <div class="filter-value">Tutti <span class="arrow">▼</span></div>
        </div>
      </div>
      <label class="select-all">
        <input type="checkbox" :checked="selectAll" @change="toggleSelectAll" />
        <span>Seleziona tutti</span>
      </label>
      <div class="cards">
        <article v-for="card in cards" :key="card.id" class="card">
          <div class="card-header">
            <label class="card-checkbox">
              <input type="checkbox" :checked="card.selected" @change="toggleCard(card.id)" />
            </label>
            <h3 class="card-title">{{ card.title }}</h3>
            <button class="card-close" type="button" aria-label="Chiudi">×</button>
          </div>
          <p class="card-date">Entro il: {{ card.date }}</p>
          <p class="card-value">Ultimo valore: {{ card.value }} / {{ card.max }}</p>
          <div class="progress-wrap">
            <div class="progress-bar" :style="{ width: (card.value / card.max * 100) + '%' }"></div>
          </div>
          <div class="card-actions">
            <button class="btn-outline">MODIFICA INFORMAZIONI</button>
            <button class="btn-secondary">AGGIORNA MISURAZIONI</button>
          </div>
        </article>
      </div>
    </template>
    </div>
  </div>

  <div class="help-widget">
    <div class="help-bubble">
      <span class="help-icon">?</span>
      <span>Serve aiuto?</span>
    </div>
    <button class="help-chat" aria-label="Chat">
        <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/></svg>
      </button>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.tab-bar {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  padding: 0 1.5rem;
  min-height: 56px;
  background: var(--bg-card);
  box-shadow: var(--shadow-soft);
  border-bottom: 1px solid var(--border-light);
}

.tab-bar-brand {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-right: 0.5rem;
}

.logo-icon {
  width: 24px;
  height: 24px;
  color: var(--accent-blue);
}

.logo-text {
  font-weight: 700;
  font-size: 1.125rem;
  color: var(--text-primary);
}

.tabs {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex: 1;
  overflow-x: auto;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 0.875rem;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  border-bottom: 3px solid transparent;
  margin-bottom: -1px;
}

.tab:hover {
  background: rgba(43, 134, 237, 0.06);
  color: var(--accent-blue);
}

.tab.active {
  color: var(--accent-blue);
  font-weight: 600;
  border-bottom-color: var(--accent-blue);
}

.tab-icon {
  display: flex;
  flex-shrink: 0;
}

.tab-icon svg {
  width: 18px;
  height: 18px;
}

.tab-label {
  flex: 0 1 auto;
}

.main-wrap {
  flex: 1;
  min-width: 0;
  padding: 1.5rem 2rem 2rem;
  overflow-y: auto;
}

.main-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}

.btn-primary {
  padding: 0.75rem 1.5rem;
  border: none;
  border-radius: var(--radius-lg);
  background: linear-gradient(90deg, var(--accent-blue-light) 0%, var(--accent-blue) 100%);
  color: white;
  font-size: 0.8125rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  cursor: pointer;
  box-shadow: var(--shadow-soft);
  transition: transform 0.15s, box-shadow 0.15s;
}

.btn-primary:hover {
  box-shadow: 0 4px 12px rgba(43, 134, 237, 0.35);
  transform: translateY(-1px);
}

.btn-icon {
  width: 40px;
  height: 40px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--accent-blue);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}

.btn-icon:hover {
  background: rgba(43, 134, 237, 0.08);
}

.btn-icon svg {
  width: 22px;
  height: 22px;
}

.filters {
  display: flex;
  gap: 1rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}

.filter-card {
  background: var(--bg-card);
  border-radius: var(--radius-sm);
  padding: 0.75rem 1rem;
  min-width: 140px;
  box-shadow: var(--shadow-soft);
}

.filter-card label {
  display: block;
  font-size: 0.75rem;
  color: var(--text-secondary);
  margin-bottom: 0.35rem;
}

.filter-value {
  font-size: 0.875rem;
  color: var(--text-primary);
}

.filter-value .arrow {
  font-size: 0.65rem;
  color: var(--text-muted);
  margin-left: 0.25rem;
}

.select-all {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: var(--text-primary);
  margin-bottom: 1rem;
  cursor: pointer;
}

.select-all input {
  width: 18px;
  height: 18px;
  accent-color: var(--accent-blue);
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 1.25rem;
}

.card {
  background: var(--bg-card);
  border-radius: var(--radius-md);
  padding: 1.25rem;
  box-shadow: var(--shadow-card);
  transition: box-shadow 0.15s;
}

.card:hover {
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.1);
}

.card-header {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}

.card-checkbox input {
  width: 18px;
  height: 18px;
  margin-top: 0.2rem;
  accent-color: var(--accent-blue);
  cursor: pointer;
}

.card-title {
  flex: 1;
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.35;
}

.card-close {
  width: 24px;
  height: 24px;
  border: none;
  background: none;
  color: var(--text-secondary);
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
  padding: 0;
  border-radius: 4px;
  transition: color 0.15s, background 0.15s;
}

.card-close:hover {
  color: var(--text-primary);
  background: var(--border-light);
}

.card-date {
  margin: 0 0 0.35rem;
  font-size: 0.8125rem;
  color: var(--text-secondary);
}

.card-value {
  margin: 0 0 0.75rem;
  font-size: 0.875rem;
  color: var(--text-primary);
}

.progress-wrap {
  height: 8px;
  background: var(--border-light);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 1rem;
}

.progress-bar {
  height: 100%;
  background: linear-gradient(90deg, var(--accent-blue-light), var(--accent-blue));
  border-radius: 4px;
  transition: width 0.3s ease;
}

.card-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.btn-outline {
  padding: 0.5rem 0.875rem;
  border: 1px solid var(--accent-blue);
  border-radius: var(--radius-sm);
  background: white;
  color: var(--accent-blue);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.btn-outline:hover {
  background: rgba(43, 134, 237, 0.08);
}

.btn-secondary {
  padding: 0.5rem 0.875rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: white;
  color: var(--text-primary);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.btn-secondary:hover {
  background: var(--bg-page);
  border-color: var(--text-muted);
}

.help-widget {
  position: fixed;
  bottom: 1.5rem;
  right: 1.5rem;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.5rem;
  z-index: 100;
}

.help-bubble {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.875rem;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  font-size: 0.8125rem;
  color: var(--text-primary);
}

.help-icon {
  width: 24px;
  height: 24px;
  background: #f0c14b;
  color: #333;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 0.875rem;
}

.help-chat {
  width: 48px;
  height: 48px;
  border: none;
  border-radius: 50%;
  background: var(--accent-blue);
  color: white;
  cursor: pointer;
  box-shadow: var(--shadow-card);
  transition: transform 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.help-chat svg {
  width: 24px;
  height: 24px;
}

.help-chat:hover {
  transform: scale(1.05);
}

/* Flusso analisi Excel */
.analisi-content {
  max-width: 56rem;
}

.analisi-content.results {
  max-width: 100%;
}

.analisi-title {
  margin: 0 0 0.5rem;
  font-size: 1.35rem;
  font-weight: 700;
  color: var(--text-primary);
}

.analisi-desc {
  margin: 0 0 1.5rem;
  font-size: 0.9375rem;
  color: var(--text-secondary);
  line-height: 1.5;
}

.results-subtabs {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1.25rem;
}

.subtab {
  padding: 0.6rem 1.25rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.subtab:hover:not(:disabled) {
  border-color: var(--accent-blue);
  color: var(--accent-blue);
}

.subtab.active {
  background: linear-gradient(90deg, var(--accent-blue-light) 0%, var(--accent-blue) 100%);
  color: white;
  border-color: transparent;
}

.subtab:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.no-data-msg {
  padding: 2rem 0;
  text-align: center;
  color: var(--text-secondary);
  font-size: 0.95rem;
}

.result-source {
  margin: 0 0 1rem;
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.save-status {
  margin: 0 0 1rem;
  font-size: 0.8125rem;
  color: var(--text-secondary);
}

.storico-status {
  color: var(--text-secondary);
  font-size: 0.9rem;
}

.storico-empty {
  color: var(--text-secondary);
  font-size: 0.95rem;
  padding: 2rem 0;
  text-align: center;
}

.storico-table-wrap {
  overflow-x: auto;
  margin-bottom: 1.5rem;
}

.storico-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.storico-table th,
.storico-table td {
  padding: 0.65rem 0.75rem;
  text-align: left;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

.storico-table th {
  font-weight: 600;
  color: var(--text-secondary);
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.storico-table tbody tr:hover {
  background: rgba(99, 102, 241, 0.04);
}

.storico-url {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.storico-id {
  font-family: monospace;
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.btn-delete {
  background: none;
  border: 1px solid #ef4444;
  color: #ef4444;
  padding: 0.3rem 0.7rem;
  border-radius: 6px;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-delete:hover:not(:disabled) {
  background: #ef4444;
  color: #fff;
}

.btn-delete:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.band-section {
  margin-bottom: 1.25rem;
}

.band-title {
  margin: 0 0 0.5rem;
  font-size: 1rem;
  font-weight: 700;
}

.band-1 { color: #1f7a8c; }
.band-2 { color: #2b86ed; }
.band-3 { color: #4a7c59; }
.band-4 { color: #8a6d3b; }
.band-5 { color: #8b3a3a; }

.job-table {
  width: 100%;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-soft);
  overflow-x: auto;
}

.job-row {
  display: grid;
  grid-template-columns: 2fr repeat(5, 1fr) 1fr 1fr 0.5fr;
  gap: 0.5rem;
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border-light);
  align-items: center;
  font-size: 0.82rem;
}

.job-row.clickable {
  cursor: pointer;
  transition: background 0.12s;
}

.job-row.clickable:hover {
  background: rgba(99, 102, 241, 0.04);
}

.job-row.expanded {
  background: rgba(99, 102, 241, 0.06);
  border-bottom-color: transparent;
}

.expand-icon {
  display: inline-block;
  width: 1em;
  font-size: 0.75rem;
  color: var(--text-secondary);
  margin-right: 0.25rem;
}

.people-detail {
  background: var(--bg-page);
  border-bottom: 1px solid var(--border-light);
  padding: 0.25rem 0.85rem 0.5rem 2.5rem;
}

.people-header,
.people-row {
  display: grid;
  grid-template-columns: 0.3fr 1.5fr 1fr 1fr 1fr 1.2fr;
  gap: 0.5rem;
  padding: 0.35rem 0;
  font-size: 0.78rem;
  align-items: center;
}

.people-header {
  color: var(--text-secondary);
  font-weight: 600;
  border-bottom: 1px solid var(--border-light);
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.people-row {
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
}

.people-row:last-child {
  border-bottom: none;
}

.score-input {
  width: 100%;
  max-width: 72px;
  padding: 0.3rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 0.82rem;
  text-align: center;
  color: var(--text-primary);
  background: var(--bg-card);
  transition: border-color 0.15s;
}

.score-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}

.gap-alert {
  color: #dc2626;
  font-weight: 700;
}

.indicator-value.gap-alert {
  background: rgba(220, 38, 38, 0.08);
  border-radius: var(--radius-sm);
  padding: 0.15rem 0.4rem;
}

.job-row.header {
  background: var(--bg-page);
  color: var(--text-secondary);
  font-weight: 600;
}

.url-input-wrap {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 0.5rem;
}

.url-input {
  flex: 1;
  min-width: 280px;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 0.9375rem;
  color: var(--text-primary);
  background: var(--bg-card);
}

.url-input:focus {
  outline: none;
  border-color: var(--accent-blue);
  box-shadow: 0 0 0 2px rgba(43, 134, 237, 0.2);
}

.url-input::placeholder {
  color: var(--text-muted);
}

.url-input:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.header-row-option {
  margin-bottom: 1rem;
}

.header-row-option label {
  display: block;
  font-size: 0.875rem;
  color: var(--text-primary);
  margin-bottom: 0.35rem;
}

.header-row-select {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
  background: var(--bg-card);
  color: var(--text-primary);
  margin-right: 0.5rem;
}

.header-row-hint {
  font-size: 0.8125rem;
  color: var(--text-muted);
  line-height: 1.4;
}

.api-key-warn {
  margin: 0 0 0.75rem;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  line-height: 1.4;
}

.url-hint {
  margin: 0 0 1rem;
  font-size: 0.8125rem;
  color: var(--text-muted);
  line-height: 1.4;
}

.upload-zone {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
  padding: 2rem;
  background: var(--bg-card);
  border: 2px dashed var(--border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
  color: var(--text-secondary);
  font-size: 0.9375rem;
}

.upload-zone:hover {
  border-color: var(--accent-blue);
  background: rgba(43, 134, 237, 0.04);
  color: var(--accent-blue);
}

.upload-zone.loading {
  pointer-events: none;
  opacity: 0.8;
}

.upload-error {
  margin: 1rem 0 0;
  color: #c53030;
  font-size: 0.875rem;
}

.mapping-table {
  background: var(--bg-card);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-soft);
  overflow: hidden;
  margin-bottom: 1rem;
}

.mapping-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
  align-items: center;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-light);
}

.mapping-row:last-child {
  border-bottom: none;
}

.mapping-row.header {
  background: var(--bg-page);
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--text-secondary);
}

.mapping-select {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
  background: white;
  color: var(--text-primary);
}

.mapping-actions {
  display: flex;
  gap: 0.75rem;
  margin-top: 1.25rem;
}

.analysis-loader {
  margin-top: 1rem;
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border);
  border-top-color: var(--accent-blue);
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.results .indicator-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 1.25rem;
  margin-bottom: 1.5rem;
}

.indicator-card {
  background: var(--bg-card);
  border-radius: var(--radius-md);
  padding: 1.25rem;
  box-shadow: var(--shadow-card);
}

.indicator-card.wide {
  grid-column: 1 / -1;
}

.indicator-card h3 {
  margin: 0 0 0.35rem;
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-primary);
}

.indicator-desc {
  margin: 0 0 0.75rem;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  line-height: 1.4;
}

.indicator-value {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--accent-blue);
  margin-bottom: 0.5rem;
}

.indicator-detail {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  color: var(--text-secondary);
}

.indicator-row {
  display: flex;
  gap: 2rem;
  flex-wrap: wrap;
}

.indicator-row .muted {
  color: var(--text-muted);
  font-size: 0.8125rem;
}

.quartile-table,
.category-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.quartile-row,
.category-row {
  display: grid;
  grid-template-columns: 80px 1fr 1fr 1fr;
  gap: 0.5rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border-light);
}

.category-row {
  grid-template-columns: 1fr 60px 1fr 1fr;
}

.quartile-row.header,
.category-row.header {
  font-weight: 600;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
}
</style>
