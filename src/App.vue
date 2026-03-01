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
import { suggestColumnMappingWithGemini, computeIndicatorsWithGemini } from './lib/gemini.js'

const activeSection = ref('dashboard')
const selectAll = ref(false)
const cards = ref([
  { id: 1, title: 'Gap retributivo di genere', date: '31/12/2025', value: 72, max: 100, selected: false },
  { id: 2, title: 'Conformità normativa D.Lgs. 198/2006', date: '30/06/2025', value: 95, max: 100, selected: false },
  { id: 3, title: 'Trasparenza bandi e posizioni', date: '31/03/2025', value: 58, max: 100, selected: false },
])

const sections = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'dati', label: 'Dati retributivi', icon: 'table' },
  { id: 'report', label: 'Report', icon: 'chart' },
  { id: 'confronti', label: 'Confronti', icon: 'compare' },
  { id: 'normativa', label: 'Normativa', icon: 'law' },
  { id: 'impostazioni', label: 'Impostazioni', icon: 'settings' },
]

// Flusso analisi Excel
const analisiStep = ref('idle') // idle | upload | mapping | results
const excelRows = ref([])
const excelHeaders = ref([])
const columnMapping = ref({})
const excelUrl = ref('')
const headerRowIndex = ref(1)
const uploadError = ref('')
const uploadLoading = ref(false)
const geminiLoading = ref(false)
const indicatorsResult = ref(null)
const indicatorsSource = ref('locale')

const googleApiKey = (import.meta.env.VITE_GOOGLE_AI_API_KEY || '').trim()

const roleKeys = [COLUMN_ROLES.gender, COLUMN_ROLES.baseSalary, COLUMN_ROLES.variableComponents, COLUMN_ROLES.totalSalary, COLUMN_ROLES.category]

const showAnalisiFlow = computed(() => activeSection.value === 'dati')

function startNuovaAnalisi() {
  activeSection.value = 'dati'
  analisiStep.value = 'upload'
  uploadError.value = ''
  indicatorsResult.value = null
}

function goToUpload() {
  analisiStep.value = 'upload'
  uploadError.value = ''
}

async function onLoadFromUrl() {
  const url = (excelUrl.value || '').trim()
  if (!url) {
    uploadError.value = 'Inserisci il collegamento al file Excel.'
    return
  }
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
        uploadError.value = 'Riconoscimento AI non riuscito: ' + (geminiErr.message || String(geminiErr)) + '. Verifica la chiave API o usa il mapping manuale.'
      } finally {
        geminiLoading.value = false
      }
    } else {
      uploadError.value = 'Gemini non attivo: manca VITE_GOOGLE_AI_API_KEY nel build environment di Vercel. Uso mapping euristico.'
    }
    columnMapping.value = suggested
    analisiStep.value = 'mapping'
  } catch (err) {
    uploadError.value = err.message || 'Impossibile leggere il file. Verifica che il link sia un URL di download diretto (.xlsx) e che il server consenta CORS.'
  } finally {
    uploadLoading.value = false
  }
}

async function confirmMapping() {
  const normalized = buildNormalizedData(excelRows.value, excelHeaders.value, columnMapping.value)
  if (normalized.length === 0) {
    uploadError.value = 'Nessun dato valido dopo il mapping. Verifica la colonna Genere (M/F).'
    return
  }
  uploadError.value = ''
  if (googleApiKey) {
    geminiLoading.value = true
    try {
      indicatorsResult.value = await computeIndicatorsWithGemini(googleApiKey, normalized)
      indicatorsSource.value = 'ai'
    } catch (aiErr) {
      indicatorsResult.value = computeIndicators(normalized)
      indicatorsSource.value = 'locale'
      uploadError.value = 'Calcolo AI non riuscito, uso fallback locale: ' + (aiErr.message || String(aiErr))
    } finally {
      geminiLoading.value = false
    }
  } else {
    indicatorsResult.value = computeIndicators(normalized)
    indicatorsSource.value = 'locale'
  }
  analisiStep.value = 'results'
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

function formatPct(n) {
  return n == null ? '–' : n.toFixed(2) + '%'
}
function formatNum(n) {
  return n == null ? '–' : Number(n).toLocaleString('it-IT', { maximumFractionDigits: 2 })
}
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
          @click="activeSection = s.id; if (s.id === 'dati' && analisiStep === 'idle') analisiStep = 'upload'"
        >
          <span class="tab-icon">
            <svg v-if="s.icon === 'dashboard'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
            <svg v-else-if="s.icon === 'table'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18"/></svg>
            <svg v-else-if="s.icon === 'chart'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
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

    <!-- Flusso Analisi Excel: Upload → Mapping → Risultati -->
    <template v-if="showAnalisiFlow">
      <!-- Step 1: Link Excel in cloud -->
      <div v-if="analisiStep === 'upload'" class="analisi-content">
        <h2 class="analisi-title">Collegamento al file Excel</h2>
        <p class="analisi-desc">Incolla il link a un file Excel (.xlsx) in cloud (es. OneDrive, Google Drive, SharePoint, URL pubblico). L'app lo scaricherà e mapperà automaticamente le colonne (genere, retribuzione base, componenti variabili, ecc.).</p>
        <div class="url-input-wrap">
          <input
            v-model="excelUrl"
            type="url"
            class="url-input"
            placeholder="https://... file.xlsx"
            :disabled="uploadLoading || geminiLoading"
            @keydown.enter="onLoadFromUrl"
          />
          <button
            type="button"
            class="btn-primary"
            :disabled="uploadLoading || geminiLoading || !excelUrl.trim()"
            @click="onLoadFromUrl"
          >
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
          <span class="header-row-hint">Usa «2» per fogli Google/Excel dove la prima riga è vuota o contiene numeri (es. il tuo file con CODICE, DIPENDENTE, SESSO…).</span>
        </div>
        <p class="api-key-warn">
          Stato Gemini: <strong>{{ googleApiKey ? 'attivo (VITE_GOOGLE_AI_API_KEY presente nel build)' : 'non attivo (VITE_GOOGLE_AI_API_KEY mancante nel build)' }}</strong>.
        </p>
        <p class="url-hint">Puoi incollare direttamente un link Google Sheets (es. docs.google.com/spreadsheets/…): verrà convertito in download .xlsx. Per altri servizi serve un URL di download diretto.</p>
        <p v-if="uploadError" class="upload-error">{{ uploadError }}</p>
      </div>

      <!-- Step 2: Mapping colonne -->
      <div v-else-if="analisiStep === 'mapping'" class="analisi-content">
        <h2 class="analisi-title">Verifica assegnazione colonne</h2>
        <p class="analisi-desc">Controlla quale colonna del file è stata associata a ogni dato. Puoi modificare le scelte prima di calcolare gli indicatori.</p>
        <div class="mapping-table">
          <div class="mapping-row header">
            <span>Dato richiesto</span>
            <span>Colonna nel file</span>
          </div>
          <div v-for="role in roleKeys" :key="role" class="mapping-row">
            <span>{{ getRoleLabel(role) }}</span>
            <select v-model.number="columnMapping[role]" class="mapping-select">
              <option :value="undefined">– Nessuna –</option>
              <option v-for="(h, i) in excelHeaders" :key="i" :value="i">{{ h }}</option>
            </select>
          </div>
        </div>
        <p v-if="uploadError" class="upload-error">{{ uploadError }}</p>
        <div class="mapping-actions">
          <button class="btn-secondary" @click="goToUpload">Indietro</button>
          <button class="btn-primary" @click="confirmMapping">Calcola indicatori</button>
        </div>
      </div>

      <!-- Step 3: Risultati indicatori (a)–(g) -->
      <div v-else-if="analisiStep === 'results' && indicatorsResult" class="analisi-content results">
        <h2 class="analisi-title">Risultati analisi trasparenza salariale</h2>
        <p class="result-source">Calcolo: <strong>{{ indicatorsSource === 'ai' ? 'Gemini (AI)' : 'Motore locale' }}</strong></p>
        <div class="indicator-cards">
          <section class="indicator-card">
            <h3>(a) Divario retributivo di genere</h3>
            <p class="indicator-desc">{{ indicatorsResult.a_divarioRetributivoGenere.descrizione }}</p>
            <div class="indicator-value">{{ formatPct(indicatorsResult.a_divarioRetributivoGenere.percentuale) }}</div>
            <p class="indicator-detail">Media M: {{ formatNum(indicatorsResult.a_divarioRetributivoGenere.mediaMaschile) }} · Media F: {{ formatNum(indicatorsResult.a_divarioRetributivoGenere.mediaFemminile) }}</p>
            <p class="indicator-detail">N maschi: {{ indicatorsResult.a_divarioRetributivoGenere.nMaschi }} · N femmine: {{ indicatorsResult.a_divarioRetributivoGenere.nFemmine }}</p>
          </section>
          <section class="indicator-card">
            <h3>(b) Divario nelle componenti variabili</h3>
            <p class="indicator-desc">{{ indicatorsResult.b_divarioComponentiVariabili.descrizione }}</p>
            <div class="indicator-value">{{ formatPct(indicatorsResult.b_divarioComponentiVariabili.percentuale) }}</div>
            <p class="indicator-detail">Media M: {{ formatNum(indicatorsResult.b_divarioComponentiVariabili.mediaMaschile) }} · Media F: {{ formatNum(indicatorsResult.b_divarioComponentiVariabili.mediaFemminile) }}</p>
          </section>
          <section class="indicator-card">
            <h3>(c) Divario mediano di genere</h3>
            <p class="indicator-desc">{{ indicatorsResult.c_divarioMedianoGenere.descrizione }}</p>
            <div class="indicator-value">{{ formatPct(indicatorsResult.c_divarioMedianoGenere.percentuale) }}</div>
            <p class="indicator-detail">Mediana M: {{ formatNum(indicatorsResult.c_divarioMedianoGenere.medianaMaschile) }} · Mediana F: {{ formatNum(indicatorsResult.c_divarioMedianoGenere.medianaFemminile) }}</p>
          </section>
          <section class="indicator-card">
            <h3>(d) Divario mediano nelle componenti variabili</h3>
            <p class="indicator-desc">{{ indicatorsResult.d_divarioMedianoComponentiVariabili.descrizione }}</p>
            <div class="indicator-value">{{ formatPct(indicatorsResult.d_divarioMedianoComponentiVariabili.percentuale) }}</div>
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
              <div class="quartile-row header">
                <span>Quartile</span>
                <span>% Femminile</span>
                <span>% Maschile</span>
                <span>Totale</span>
              </div>
              <div v-for="q in indicatorsResult.f_percentualePerQuartile.quartili" :key="q.quartile" class="quartile-row">
                <span>Q{{ q.quartile }}</span>
                <span>{{ formatPct(q.femminile) }}</span>
                <span>{{ formatPct(q.maschile) }}</span>
                <span>{{ q.totale }}</span>
              </div>
            </div>
          </section>
          <section class="indicator-card wide">
            <h3>(g) Divario per categoria (base e variabile)</h3>
            <p class="indicator-desc">{{ indicatorsResult.g_divarioPerCategoria.descrizione }}</p>
            <div class="category-table">
              <div class="category-row header">
                <span>Categoria</span>
                <span>N</span>
                <span>Divario base %</span>
                <span>Divario variabile %</span>
              </div>
              <div v-for="cat in indicatorsResult.g_divarioPerCategoria.perCategoria" :key="cat.categoria" class="category-row">
                <span>{{ cat.categoria }}</span>
                <span>{{ cat.n }}</span>
                <span>{{ formatPct(cat.divarioBase) }}</span>
                <span>{{ formatPct(cat.divarioVariabile) }}</span>
              </div>
            </div>
          </section>
        </div>
        <div class="mapping-actions">
          <button class="btn-secondary" @click="analisiStep = 'mapping'">Modifica mapping</button>
          <button class="btn-primary" @click="goToUpload">Nuova analisi</button>
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

.result-source {
  margin: 0 0 1rem;
  font-size: 0.875rem;
  color: var(--text-secondary);
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
