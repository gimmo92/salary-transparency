<script setup>
import { ref, computed, onMounted } from 'vue'
import {
  parseExcelFromUrl,
  detectColumnRoles,
  buildNormalizedData,
  COLUMN_ROLES,
  getRoleLabel,
} from './lib/excel.js'
import { computeIndicators, computeBandGenderGaps, computeAdjustedGap } from './lib/indicators.js'
import {
  suggestColumnMappingWithGemini,
  computeIndicatorsWithGemini,
  checkGeminiAvailable,
} from './lib/gemini.js'
import {
  buildNormalizedJobGradingData,
  groupByLevel,
  enrichWithDeviation,
} from './lib/jobGrading.js'
import { saveAnalysis, fetchAnalyses, fetchAnalysisById, deleteAnalysisById, fetchRules, saveRule, updateRuleById, deleteRuleById } from './lib/persistence.js'
import { jsPDF } from 'jspdf'
import 'jspdf-autotable'

const activeSection = ref('salaryReview')

const sections = [
  { id: 'salaryReview', label: 'Revisione Salariale', icon: 'salary' },
  { id: 'analisi', label: 'Analisi', icon: 'table' },
  { id: 'storico', label: 'Storico', icon: 'history' },
]

// Flusso unificato
const analisiStep = ref('idle') // idle | upload | mapping | results
const excelRows = ref([])
const excelHeaders = ref([])
const columnMapping = ref({})
const excelUrl = ref('')
const uploadError = ref('')
const uploadLoading = ref(false)
const geminiLoading = ref(false)
const analysisLoading = ref(false)
const saveStatus = ref('')

const indicatorsResult = ref(null)
const indicatorsSource = ref('locale')

const jobResults = ref([])

const resultsTab = ref('genere') // 'genere' | 'pari_valore'

const geminiEnabled = ref(false)


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

const storicoViewing = ref(null)

async function viewAnalysis(id) {
  storicoViewing.value = id
  storicoError.value = ''
  try {
    const record = await fetchAnalysisById(id)
    const results = record.results_json || {}
    indicatorsResult.value = results.gender || null
    indicatorsSource.value = (record.calculation_source || '').includes('gender:ai') ? 'ai' : 'locale'

    const jg = results.jobGrading || []
    jobResults.value = jg
    justifications.value = {}

    excelUrl.value = record.source_url || ''
    columnMapping.value = record.mapping_json || {}
    excelHeaders.value = record.headers_json || []
    excelRows.value = record.rows_json || []
    saveStatus.value = `Analisi caricata dallo storico (ID: ${record.id})`

    const normalizedGender = buildNormalizedData(excelRows.value, excelHeaders.value, columnMapping.value)
    genderNormalizedCache.value = normalizedGender
    bandGenderJustifications.value = {}
    recomputeBandGenderGaps()
    recomputeAdjustedGap()

    resultsTab.value = indicatorsResult.value ? 'genere' : 'pari_valore'
    analisiStep.value = 'results'
    activeSection.value = 'analisi'
  } catch (err) {
    storicoError.value = 'Impossibile caricare l\'analisi: ' + (err.message || String(err))
  } finally {
    storicoViewing.value = null
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

const expandedHayBands = ref(new Set())

function hayBandKey(level, label) {
  return `${level}::${label}`
}

function toggleHayBand(level, label) {
  const key = hayBandKey(level, label)
  if (expandedHayBands.value.has(key)) expandedHayBands.value.delete(key)
  else expandedHayBands.value.add(key)
  expandedHayBands.value = new Set(expandedHayBands.value)
}

function isHayBandExpanded(level, label) {
  return expandedHayBands.value.has(hayBandKey(level, label))
}

function roleBreakdown(people = []) {
  const map = new Map()
  for (const p of people) {
    const role = p.role || 'N/D'
    if (!map.has(role)) {
      map.set(role, {
        role,
        n: 0,
        salaries: [],
        men: [],
        women: [],
      })
    }
    const row = map.get(role)
    row.n += 1
    row.salaries.push(Number(p.totalSalary) || 0)
    if (p.gender === 'M') row.men.push(Number(p.totalSalary) || 0)
    if (p.gender === 'F') row.women.push(Number(p.totalSalary) || 0)
  }
  const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
  return Array.from(map.values())
    .map((r) => {
      const avgSalary = mean(r.salaries)
      const avgMen = mean(r.men)
      const avgWomen = mean(r.women)
      return {
        role: r.role,
        n: r.n,
        avgSalary,
        avgMen,
        avgWomen,
        gapPct: r.men.length && avgMen ? ((avgMen - avgWomen) / avgMen) * 100 : 0,
        nMen: r.men.length,
        nWomen: r.women.length,
      }
    })
    .sort((a, b) => b.avgSalary - a.avgSalary)
}

function runJobGrading() {
  const normalizedJob = buildNormalizedJobGradingData(excelRows.value, excelHeaders.value, columnMapping.value)
  const normalizedGender = buildNormalizedData(excelRows.value, excelHeaders.value, columnMapping.value)
  const genderByIndex = new Map(normalizedGender.map((x) => [x.index, x.gender]))
  const enrichedJob = normalizedJob.map((p) => ({
    ...p,
    gender: p.gender || genderByIndex.get(p.index) || null,
  }))
  if (normalizedJob.length > 0) {
    const grouped = groupByLevel(enrichedJob)
    jobResults.value = enrichWithDeviation(grouped)
  } else {
    jobResults.value = []
  }
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
  justifications.value = {}
  justifyingLevel.value = null
  genderViewMode.value = 'media'
  bandGenderGaps.value = []
  adjustedGapResult.value = null
  genderNormalizedCache.value = []
  bandGenderJustifications.value = {}
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
    const { rows, headers } = await parseExcelFromUrl(url)
    excelRows.value = rows
    excelHeaders.value = headers
    const heuristic = detectColumnRoles(headers, rows)
    let suggested = { ...heuristic }
    if (geminiEnabled.value) {
      geminiLoading.value = true
      try {
        const geminiMapping = await suggestColumnMappingWithGemini(headers, rows)
        if (geminiMapping && Object.keys(geminiMapping).length > 0)
          suggested = { ...heuristic, ...geminiMapping }
      } catch (geminiErr) {
        uploadError.value = 'Riconoscimento AI non riuscito: ' + (geminiErr.message || String(geminiErr)) + '. Usa il mapping manuale.'
      } finally { geminiLoading.value = false }
    } else {
      uploadError.value = 'Gemini non attivo: API non configurata sul server. Uso mapping euristico.'
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
      if (geminiEnabled.value) {
        geminiLoading.value = true
        try {
          const aiIndicators = await computeIndicatorsWithGemini(normalizedGender)
          indicatorsResult.value = {
            ...localIndicators,
            ...aiIndicators,
            a_divarioRetributivoGenere: {
              ...localIndicators.a_divarioRetributivoGenere,
              ...(aiIndicators?.a_divarioRetributivoGenere || {}),
            },
            b_divarioComponentiVariabili: {
              ...localIndicators.b_divarioComponentiVariabili,
              ...(aiIndicators?.b_divarioComponentiVariabili || {}),
            },
            c_divarioMedianoGenere: {
              ...localIndicators.c_divarioMedianoGenere,
              ...(aiIndicators?.c_divarioMedianoGenere || {}),
            },
            d_divarioMedianoComponentiVariabili: {
              ...localIndicators.d_divarioMedianoComponentiVariabili,
              ...(aiIndicators?.d_divarioMedianoComponentiVariabili || {}),
            },
            e_percentualeConComponentiVariabili: {
              ...localIndicators.e_percentualeConComponentiVariabili,
              ...(aiIndicators?.e_percentualeConComponentiVariabili || {}),
            },
            f_percentualePerQuartile: {
              ...localIndicators.f_percentualePerQuartile,
              ...(aiIndicators?.f_percentualePerQuartile || {}),
              quartili: aiIndicators?.f_percentualePerQuartile?.quartili || localIndicators.f_percentualePerQuartile.quartili,
            },
            g_divarioPerCategoria: {
              ...localIndicators.g_divarioPerCategoria,
              ...(aiIndicators?.g_divarioPerCategoria || {}),
              perCategoria: aiIndicators?.g_divarioPerCategoria?.perCategoria || localIndicators.g_divarioPerCategoria.perCategoria,
            },
            h_divarioRetribuzioneBase: {
              ...localIndicators.h_divarioRetribuzioneBase,
              ...(aiIndicators?.h_divarioRetribuzioneBase || {}),
            },
          }
          indicatorsSource.value = 'ai'
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
    runJobGrading()

    if (!indicatorsResult.value && jobResults.value.length === 0) {
      uploadError.value = 'Nessun dato valido. Verifica il mapping delle colonne (Genere per analisi di genere, Ruolo per job grading).'
      return
    }

    // Gender gap per band & gap rettificato
    genderNormalizedCache.value = normalizedGender
    bandGenderJustifications.value = {}
    recomputeBandGenderGaps()
    recomputeAdjustedGap()

    // Salvataggio DB
    try {
      const saved = await saveAnalysis({
        analysisType: 'combined',
        sourceUrl: excelUrl.value,
        headers: excelHeaders.value,
        mapping: columnMapping.value,
        rows: excelRows.value.slice(0, 500),
        results: { gender: indicatorsResult.value, jobGrading: jobResults.value },
        calculationSource: `gender:${indicatorsSource.value},job:locale`,
      })
      saveStatus.value = `Analisi salvata nel database (ID: ${saved.id})`
    } catch (saveErr) {
      saveStatus.value = `Analisi non salvata: ${saveErr.message || String(saveErr)}`
    }

    resultsTab.value = indicatorsResult.value ? 'genere' : 'pari_valore'
    analisiStep.value = 'results'
  } finally { analysisLoading.value = false }
}

function formatPct(n) { return n == null ? '–' : n.toFixed(2) + '%' }
function formatNum(n) { return n == null ? '–' : Number(n).toLocaleString('it-IT', { maximumFractionDigits: 2 }) }
// Giustificativi per livelli fuori soglia
const justifications = ref({})
const justifyingLevel = ref(null)
const justifyText = ref('')

function openJustify(level) {
  justifyingLevel.value = level
  justifyText.value = justifications.value[level] || ''
}

function saveJustify() {
  if (justifyingLevel.value != null) {
    justifications.value[justifyingLevel.value] = justifyText.value
  }
  justifyingLevel.value = null
  justifyText.value = ''
}

function cancelJustify() {
  justifyingLevel.value = null
  justifyText.value = ''
}

// Gender gap dashboard
const genderViewMode = ref('media') // 'media' | 'mediana'
const bandGenderGaps = ref([])
const adjustedGapResult = ref(null)
const genderNormalizedCache = ref([])
const bandGenderJustifications = ref({})
const expandedJustifyBand = ref(null)

const BAND_JUSTIFY_REASONS = [
  { id: 'seniority', label: 'Anzianità di servizio', icon: '⏳', desc: 'Differenza significativa nell\'anzianità media tra i generi nella band' },
  { id: 'performance', label: 'Performance e Merito', icon: '🏆', desc: 'Differenze retributive legate a valutazioni di performance documentate' },
  { id: 'market', label: 'Scarsità di Mercato', icon: '📈', desc: 'Market premium applicato per ruoli con alta domanda/bassa offerta' },
  { id: 'training', label: 'Formazione d\'Eccellenza', icon: '🎓', desc: 'Possesso di certificazioni, master o percorsi formativi rilevanti' },
  { id: 'flexibility', label: 'Flessibilità Oraria / Turnazione', icon: '🔄', desc: 'Indennità legate a turni notturni, festivi o condizioni speciali' },
]

function getOrCreateJustification(band) {
  if (!bandGenderJustifications.value[band]) {
    bandGenderJustifications.value = {
      ...bandGenderJustifications.value,
      [band]: { reasons: [], note: '', files: [] },
    }
  }
  return bandGenderJustifications.value[band]
}

function toggleJustifyBand(band) {
  if (expandedJustifyBand.value === band) {
    expandedJustifyBand.value = null
  } else {
    getOrCreateJustification(band)
    expandedJustifyBand.value = band
  }
}

function toggleBandReason(band, reasonId) {
  const j = getOrCreateJustification(band)
  const idx = j.reasons.indexOf(reasonId)
  if (idx >= 0) j.reasons.splice(idx, 1)
  else j.reasons.push(reasonId)
  bandGenderJustifications.value = { ...bandGenderJustifications.value }
}

function updateBandNote(band, text) {
  const j = getOrCreateJustification(band)
  j.note = text
  bandGenderJustifications.value = { ...bandGenderJustifications.value }
}

function onBandFileUpload(band, event) {
  const files = event.target.files
  if (!files?.length) return
  const j = getOrCreateJustification(band)
  for (const f of files) {
    j.files.push({ name: f.name, size: f.size, file: f })
  }
  bandGenderJustifications.value = { ...bandGenderJustifications.value }
  event.target.value = ''
}

function removeBandFile(band, index) {
  const j = getOrCreateJustification(band)
  j.files.splice(index, 1)
  bandGenderJustifications.value = { ...bandGenderJustifications.value }
}

function clearBandJustification(band) {
  const copy = { ...bandGenderJustifications.value }
  delete copy[band]
  bandGenderJustifications.value = copy
  if (expandedJustifyBand.value === band) expandedJustifyBand.value = null
}

function hasBandJustification(band) {
  const j = bandGenderJustifications.value[band]
  return j && (j.reasons.length > 0 || j.note || j.files.length > 0)
}

function bandJustifySummary(band) {
  const j = bandGenderJustifications.value[band]
  if (!j) return ''
  const labels = j.reasons.map((id) => BAND_JUSTIFY_REASONS.find((r) => r.id === id)?.label || id)
  const parts = []
  if (labels.length) parts.push(labels.join(', '))
  if (j.note) parts.push('+ nota')
  if (j.files.length) parts.push(`${j.files.length} doc`)
  return parts.join(' · ')
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function recomputeBandGenderGaps() {
  bandGenderGaps.value = computeBandGenderGaps(genderNormalizedCache.value, jobResults.value)
}

function recomputeAdjustedGap() {
  adjustedGapResult.value = computeAdjustedGap(genderNormalizedCache.value, 5)
}

// Salary Review
const showSalaryReview = computed(() => activeSection.value === 'salaryReview')
const srView = ref('list') // 'list' | 'editRule' | 'newIncrease'
const srRules = ref([])
const srCurrentRule = ref(null)
const srIncreases = ref([])
const srCurrentIncrease = ref(null)
const srPillInput = ref('')
const srObjInput = ref('')
const srApprovalUserInput = ref({})
const srRulesLoading = ref(false)
const srRulesError = ref('')
const srSaving = ref(false)
const srSubTab = ref('reviews') // 'reviews' | 'rules'

const sampleUsers = [
  'Mario Rossi', 'Paolo Neri', 'Giulia Bianchi', 'Luca Verdi',
  'Anna Ferrari', 'Marco Esposito', 'Sara Romano', 'Andrea Colombo',
  'Francesca Ricci', 'Alessandro Marino',
]

const sampleUserData = {
  'Mario Rossi': { role: 'Software Engineer', performanceScore: 85, objectives: ['Delivery Q1', 'Riduzione bug 30%', 'Mentoring junior'], objectivesReached: ['Delivery Q1', 'Riduzione bug 30%'] },
  'Paolo Neri': { role: 'Product Manager', performanceScore: 72, objectives: ['Lancio prodotto X', 'NPS +10'], objectivesReached: ['Lancio prodotto X'] },
  'Giulia Bianchi': { role: 'UX Designer', performanceScore: 91, objectives: ['Design system v2', 'User testing 50 utenti'], objectivesReached: ['Design system v2', 'User testing 50 utenti'] },
  'Luca Verdi': { role: 'Data Analyst', performanceScore: 65, objectives: ['Dashboard analytics', 'Report mensili'], objectivesReached: ['Report mensili'] },
  'Anna Ferrari': { role: 'HR Manager', performanceScore: 88, objectives: ['Onboarding revamp', 'Retention +5%', 'Survey clima'], objectivesReached: ['Onboarding revamp', 'Retention +5%', 'Survey clima'] },
  'Marco Esposito': { role: 'Backend Developer', performanceScore: 78, objectives: ['Migrazione API', 'Copertura test 80%'], objectivesReached: ['Migrazione API'] },
  'Sara Romano': { role: 'Marketing Specialist', performanceScore: 82, objectives: ['Campagna brand', 'Lead gen +20%'], objectivesReached: ['Campagna brand', 'Lead gen +20%'] },
  'Andrea Colombo': { role: 'DevOps Engineer', performanceScore: 90, objectives: ['CI/CD pipeline', 'Infra cost -15%'], objectivesReached: ['CI/CD pipeline', 'Infra cost -15%'] },
  'Francesca Ricci': { role: 'Sales Account', performanceScore: 60, objectives: ['Target fatturato', 'Nuovi clienti 10'], objectivesReached: [] },
  'Alessandro Marino': { role: 'Finance Controller', performanceScore: 75, objectives: ['Chiusura bilancio', 'Forecast trimestrale'], objectivesReached: ['Chiusura bilancio', 'Forecast trimestrale'] },
}

const srReviewStatuses = ref({})
const srViewingReview = ref(null)

const eligibleReviews = computed(() => {
  const reviews = []
  const seen = new Set()
  for (const rule of srRules.value) {
    const users = rule.applyToAll ? sampleUsers : (rule.eligibleUsers || [])
    for (const userName of users) {
      if (seen.has(userName)) continue
      const ud = sampleUserData[userName]
      if (!ud) continue
      let eligible = false
      if (rule.triggerType === 'performance') {
        eligible = ud.performanceScore >= (rule.performanceScore || 0)
      } else {
        const ruleObjs = rule.objectives || []
        eligible = ruleObjs.length === 0 || ruleObjs.some((o) => (ud.objectivesReached || []).includes(o))
      }
      if (eligible) {
        seen.add(userName)
        reviews.push({
          name: userName,
          role: ud.role,
          performanceScore: ud.performanceScore,
          objectives: ud.objectives,
          objectivesReached: ud.objectivesReached,
          proposedRalPct: rule.defaultRalPct,
          proposedVariablePct: rule.defaultVariablePct,
          ruleName: rule.name,
          ruleId: rule.id,
        })
      }
    }
  }
  return reviews
})

function viewReview(review) {
  srViewingReview.value = { ...review }
  srView.value = 'viewReview'
}

function approveReview(name) {
  srReviewStatuses.value[name] = 'approved'
  srView.value = 'list'
  srViewingReview.value = null
}

function rejectReview(name) {
  srReviewStatuses.value[name] = 'rejected'
  srView.value = 'list'
  srViewingReview.value = null
}

function removeReview(name) {
  srReviewStatuses.value[name] = 'removed'
}

function reviewStatus(name) {
  return srReviewStatuses.value[name] || 'pending'
}

function backToReviewsList() {
  srViewingReview.value = null
  srView.value = 'list'
}

const srEligibilityDropdownOpen = ref(false)
const srApprovalDropdownOpen = ref({})

function toggleUserSelection(arr, user) {
  const idx = arr.indexOf(user)
  if (idx >= 0) arr.splice(idx, 1)
  else arr.push(user)
}

function eligibleUsersFiltered() {
  return sampleUsers.filter((u) => !srCurrentRule.value?.eligibleUsers?.includes(u))
}

function approvalUsersFiltered(stepUsers) {
  return sampleUsers.filter((u) => !stepUsers.includes(u))
}

function ruleFromDb(row) {
  const r = row.rule_json || {}
  return { ...r, id: row.id, name: row.name || r.name || '' }
}

function newRuleTemplate() {
  return {
    id: null,
    name: '',
    applyToAll: false,
    eligibleUsers: [],
    year: new Date().getFullYear(),
    triggerType: 'performance',
    performanceScore: 70,
    objectives: [],
    approvalSteps: [{ type: 'manager', users: [] }],
    defaultRalPct: 5,
    defaultVariablePct: 0,
  }
}

async function loadRules() {
  srRulesLoading.value = true
  srRulesError.value = ''
  try {
    const rows = await fetchRules()
    srRules.value = rows.map(ruleFromDb)
  } catch (err) {
    srRulesError.value = err.message || 'Impossibile caricare le regole.'
  } finally {
    srRulesLoading.value = false
  }
}

function startCreateRule() {
  srCurrentRule.value = newRuleTemplate()
  srView.value = 'editRule'
}

function editRule(rule) {
  srCurrentRule.value = JSON.parse(JSON.stringify(rule))
  srView.value = 'editRule'
}

function duplicateRule(rule) {
  const copy = JSON.parse(JSON.stringify(rule))
  copy.id = null
  copy.name = (copy.name || 'Regola') + ' (copia)'
  srCurrentRule.value = copy
  srView.value = 'editRule'
}

async function saveCurrentRule() {
  const r = srCurrentRule.value
  if (!r || srSaving.value) return
  if (!r.name.trim()) { r.name = 'Regola ' + (srRules.value.length + 1) }
  srSaving.value = true
  srRulesError.value = ''
  try {
    const { id: _id, ...ruleData } = r
    const isExisting = r.id && srRules.value.some((x) => x.id === r.id)
    if (isExisting) {
      await updateRuleById({ id: r.id, name: r.name, rule: ruleData })
    } else {
      const { id: newId } = await saveRule({ name: r.name, rule: ruleData })
      r.id = newId
    }
    await loadRules()
    srCurrentRule.value = null
    srView.value = 'list'
  } catch (err) {
    srRulesError.value = 'Salvataggio non riuscito: ' + (err.message || String(err))
  } finally {
    srSaving.value = false
  }
}

async function removeRule(id) {
  if (!confirm('Eliminare questa regola?')) return
  srRulesError.value = ''
  try {
    await deleteRuleById(id)
    srRules.value = srRules.value.filter((x) => x.id !== id)
  } catch (err) {
    srRulesError.value = 'Eliminazione non riuscita: ' + (err.message || String(err))
  }
}

function cancelRuleEdit() {
  srCurrentRule.value = null
  srView.value = 'list'
}

function addPill(arr, val) {
  const v = (typeof val === 'string' ? val : val?.value || '').trim()
  if (v && !arr.includes(v)) arr.push(v)
}

function removePill(arr, idx) {
  arr.splice(idx, 1)
}

function addApprovalStep() {
  srCurrentRule.value.approvalSteps.push({ type: 'manager', users: [] })
}

function removeApprovalStep(idx) {
  srCurrentRule.value.approvalSteps.splice(idx, 1)
}

function startCreateIncrease() {
  srCurrentIncrease.value = {
    id: Date.now(),
    employee: '',
    ralPct: 0,
    variablePct: 0,
    notes: '',
  }
  srView.value = 'newIncrease'
}

function saveCurrentIncrease() {
  const inc = srCurrentIncrease.value
  if (!inc) return
  srIncreases.value.push({ ...inc })
  srCurrentIncrease.value = null
  srView.value = 'list'
}

function cancelIncreaseEdit() {
  srCurrentIncrease.value = null
  srView.value = 'list'
}

onMounted(async () => {
  loadRules()
  geminiEnabled.value = await checkGeminiAvailable()
})

// PDF export job grading
function exportJobGradingPdf() {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  let y = 18

  doc.setFontSize(16)
  doc.setFont('helvetica', 'bold')
  doc.text('Valutazione dei Lavori di Pari Valore – Job Grading', pageWidth / 2, y, { align: 'center' })
  y += 8
  doc.setFontSize(9)
  doc.setFont('helvetica', 'normal')
  doc.text(`Data: ${new Date().toLocaleDateString('it-IT')}`, pageWidth / 2, y, { align: 'center' })
  y += 10

  doc.setFontSize(11)
  doc.setFont('helvetica', 'bold')
  doc.text('Metodologia di Valutazione', 14, y)
  y += 6

  doc.setFontSize(9)
  doc.setFont('helvetica', 'normal')
  const regText = [
    'I dipendenti sono raggruppati per livello di inquadramento CCNL.',
    'All interno di ogni livello vengono create sotto-fasce Hay con ampiezza 20 punti.',
    'I punteggi Hay sono basati su: responsabilita, problem solving, competenze richieste e condizioni di lavoro.',
    'La deviazione e calcolata sulla media salariale complessiva per livello.',
    'Scostamenti superiori al +/-5% richiedono un giustificativo documentato.',
  ]
  regText.forEach((line) => {
    doc.text(line, 14, y)
    y += 4.2
  })
  y += 4

  const head = [['Fascia', 'Livello', 'Sotto-fascia Hay', 'Resp.', 'Prob.', 'Comp.', 'Cond.', 'Totale', 'N', 'Media Retrib.', 'Media U', 'Media D', 'Gap U-D']]
  const body = jobResults.value.flatMap((b) =>
    (b.hayBands || []).map((sub) => [
      b.band,
      b.level || '–',
      sub.label,
      formatNum(sub.avgHayResponsibility),
      formatNum(sub.avgHayProblemSolving),
      formatNum(sub.avgHayRequiredSkills),
      formatNum(sub.avgHayWorkingConditions),
      formatNum(sub.avgHayTotalScore),
      sub.n,
      formatNum(sub.avgTotalSalary),
      formatNum(sub.avgSalaryMen),
      formatNum(sub.avgSalaryWomen),
      formatPct(sub.genderPayGapPct),
    ]),
  )

  doc.autoTable({
    startY: y,
    head,
    body,
    theme: 'grid',
    headStyles: { fillColor: [10, 108, 210], fontSize: 7.5, halign: 'center' },
    bodyStyles: { fontSize: 7.5 },
    columnStyles: {
      0: { halign: 'center', cellWidth: 14 },
      1: { halign: 'center', cellWidth: 18 },
      2: { halign: 'center', cellWidth: 18 },
      3: { halign: 'center' },
      4: { halign: 'center' },
      5: { halign: 'center' },
      6: { halign: 'center' },
      7: { halign: 'center' },
      8: { halign: 'center' },
      9: { halign: 'right' },
      10: { halign: 'right' },
      11: { halign: 'right' },
      12: { halign: 'center' },
    },
    didParseCell(data) {
      if (data.section === 'body' && data.column.index === 12) {
        const raw = data.cell.raw
        const num = typeof raw === 'string' ? parseFloat(raw) : raw
        if (Number.isFinite(num) && Math.abs(num) > 5) {
          data.cell.styles.textColor = [220, 38, 38]
          data.cell.styles.fontStyle = 'bold'
        }
      }
    },
    margin: { left: 14, right: 14 },
  })

  doc.save('job-grading-report.pdf')
}
</script>

<template>
  <div class="app-layout">
    <header class="tab-bar">
      <nav class="tabs">
        <button
          v-for="s in sections"
          :key="s.id"
          class="tab"
          :class="{ active: activeSection === s.id }"
          @click="activeSection = s.id; if (s.id === 'analisi' && analisiStep === 'idle') analisiStep = 'upload'; if (s.id === 'storico') loadStorico(); if (s.id === 'salaryReview') loadRules()"
        >
          <span class="tab-icon">
            <svg v-if="s.icon === 'salary'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
            <svg v-else-if="s.icon === 'table'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18"/></svg>
            <svg v-else-if="s.icon === 'history'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </span>
          <span class="tab-label">{{ s.label }}</span>
        </button>
      </nav>
    </header>

    <div class="main-wrap">
    <header v-if="!showSalaryReview" class="main-header">
      <button class="btn-primary" @click="startNuovaAnalisi">
        <span>NUOVA ANALISI</span>
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
        <p class="api-key-warn">Stato Gemini: <strong>{{ geminiEnabled ? 'attivo' : 'non attivo' }}</strong></p>
        <p class="url-hint">Puoi incollare un link Google Sheets: verrà convertito in download .xlsx.</p>
        <p v-if="uploadError" class="upload-error">{{ uploadError }}</p>
      </div>

      <!-- Step 2: Mapping colonne unificato -->
      <div v-else-if="analisiStep === 'mapping'" class="analisi-content">
        <h2 class="analisi-title">Verifica assegnazione colonne</h2>
        <p class="analisi-desc">Associa ogni dato richiesto alla colonna corrispondente del file.</p>
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
        <div class="settings-panel">
          <h3 class="settings-title">Metodo di analisi</h3>
          <p class="settings-hint">Il job grading raggruppa i dipendenti per livello di inquadramento CCNL. Ogni livello forma una fascia e ne viene calcolata la retribuzione media e la deviazione.</p>
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
          <span>Elaboro analisi...</span>
        </div>
      </div>

      <!-- Step 3: Risultati con sub-tab -->
      <div v-else-if="analisiStep === 'results'" class="analisi-content results">
        <h2 class="analisi-title">Risultati analisi</h2>
        <p v-if="saveStatus" class="save-status">{{ saveStatus }}</p>
        <p v-if="uploadError" class="upload-error">{{ uploadError }}</p>

        <div class="results-subtabs">
          <button class="subtab" :class="{ active: resultsTab === 'genere' }" @click="resultsTab = 'genere'">Analisi di genere</button>
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

          <!-- Toggle Media / Mediana -->
          <div class="gender-dashboard-toggle">
            <span class="toggle-label">Visualizzazione divario:</span>
            <button :class="['toggle-btn', { active: genderViewMode === 'media' }]" @click="genderViewMode = 'media'">Media</button>
            <button :class="['toggle-btn', { active: genderViewMode === 'mediana' }]" @click="genderViewMode = 'mediana'">Mediana</button>
            <span v-if="genderViewMode === 'mediana' && indicatorsResult && Math.abs(indicatorsResult.c_divarioMedianoGenere.percentuale) < 5" class="eu-compliant-msg">
              Il divario mediano è conforme ai limiti della Direttiva UE (&lt; 5%)
            </span>
          </div>

          <!-- Divario di genere per Band (Equal Value Gap) -->
          <section v-if="bandGenderGaps.length > 0" class="indicator-card wide band-gender-section">
            <h3>Divario di genere per Band (Equal Value Gap)</h3>
            <p class="indicator-desc">Gender Pay Gap calcolato per ogni Band di Job Grading.</p>
            <div class="band-gender-table">
              <div class="band-gender-row header">
                <span>Band</span>
                <span>N Uomini</span>
                <span>N Donne</span>
                <span>Gap {{ genderViewMode === 'media' ? 'Media' : 'Mediana' }}</span>
                <span>Stato</span>
                <span>Giustificazione</span>
              </div>
              <template v-for="bg in bandGenderGaps" :key="bg.band">
                <div class="band-gender-row" :class="{ 'gap-over': Math.abs(genderViewMode === 'media' ? bg.gapMedia : bg.gapMediana) > 5, 'gap-ok': Math.abs(genderViewMode === 'media' ? bg.gapMedia : bg.gapMediana) <= 5 }">
                  <span>{{ bg.band }}</span>
                  <span>{{ bg.nM }}</span>
                  <span>{{ bg.nF }}</span>
                  <span class="gap-value" :class="{ 'gap-alert': Math.abs(genderViewMode === 'media' ? bg.gapMedia : bg.gapMediana) > 5 }">
                    {{ formatPct(genderViewMode === 'media' ? bg.gapMedia : bg.gapMediana) }}
                  </span>
                  <span>
                    <span v-if="Math.abs(genderViewMode === 'media' ? bg.gapMedia : bg.gapMediana) <= 5" class="status-badge compliant">Conforme</span>
                    <span v-else class="status-badge non-compliant">Gap &gt; 5%</span>
                  </span>
                  <span>
                    <template v-if="Math.abs(genderViewMode === 'media' ? bg.gapMedia : bg.gapMediana) > 5">
                      <button v-if="!hasBandJustification(bg.band)" class="btn-justify-open" @click="toggleJustifyBand(bg.band)">
                        {{ expandedJustifyBand === bg.band ? '▾ Chiudi' : '+ Inserisci Giustificazione' }}
                      </button>
                      <span v-else class="band-justify-summary" @click="toggleJustifyBand(bg.band)">
                        {{ bandJustifySummary(bg.band) }}
                        <button class="btn-link-sm" @click.stop="clearBandJustification(bg.band)">✕</button>
                      </span>
                    </template>
                    <span v-else class="muted">—</span>
                  </span>
                </div>
                <!-- Pannello giustificativi espanso -->
                <div v-if="expandedJustifyBand === bg.band && Math.abs(genderViewMode === 'media' ? bg.gapMedia : bg.gapMediana) > 5" class="band-justify-panel">
                  <div class="bjp-header">
                    <strong>Giustificativi per Band {{ bg.band }}</strong>
                    <span class="muted">Seleziona uno o più motivi oggettivi</span>
                  </div>
                  <div class="bjp-reasons">
                    <button
                      v-for="reason in BAND_JUSTIFY_REASONS"
                      :key="reason.id"
                      :class="['bjp-reason-btn', { active: bandGenderJustifications[bg.band]?.reasons?.includes(reason.id) }]"
                      @click="toggleBandReason(bg.band, reason.id)"
                    >
                      <span class="bjp-reason-icon">{{ reason.icon }}</span>
                      <span class="bjp-reason-label">{{ reason.label }}</span>
                      <span class="bjp-reason-desc">{{ reason.desc }}</span>
                      <span class="bjp-reason-check">{{ bandGenderJustifications[bg.band]?.reasons?.includes(reason.id) ? '✓' : '' }}</span>
                    </button>
                  </div>
                  <div class="bjp-note">
                    <label class="bjp-note-label">Note aggiuntive</label>
                    <textarea
                      class="bjp-note-input"
                      rows="2"
                      placeholder="Aggiungi dettagli a supporto della giustificazione..."
                      :value="bandGenderJustifications[bg.band]?.note || ''"
                      @input="updateBandNote(bg.band, $event.target.value)"
                    ></textarea>
                  </div>
                  <div class="bjp-files">
                    <label class="bjp-note-label">Documenti allegati</label>
                    <div class="bjp-file-list" v-if="bandGenderJustifications[bg.band]?.files?.length">
                      <div v-for="(f, fi) in bandGenderJustifications[bg.band].files" :key="fi" class="bjp-file-item">
                        <span class="bjp-file-icon">📄</span>
                        <span class="bjp-file-name">{{ f.name }}</span>
                        <span class="bjp-file-size">{{ formatFileSize(f.size) }}</span>
                        <button class="btn-link-sm" @click="removeBandFile(bg.band, fi)">✕</button>
                      </div>
                    </div>
                    <label class="bjp-upload-btn">
                      📎 Carica documento
                      <input type="file" multiple hidden @change="onBandFileUpload(bg.band, $event)" accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.txt,.csv" />
                    </label>
                  </div>
                  <div class="bjp-actions">
                    <button class="btn-primary btn-sm" @click="expandedJustifyBand = null">Conferma</button>
                  </div>
                </div>
              </template>
            </div>
          </section>

          <!-- Gap Rettificato (escludendo Top Earners) -->
          <section v-if="adjustedGapResult" class="indicator-card wide adjusted-gap-section">
            <h3>Divario Rettificato (escl. Top 5% stipendi)</h3>
            <p class="indicator-desc">Ricalcolo del divario globale escludendo i "Top Earners" (top 5% degli stipendi) per mostrare quanto i ruoli apicali pesano sul risultato.</p>
            <div class="adjusted-gap-grid">
              <div class="adjusted-gap-box">
                <div class="adjusted-gap-label">Gap Rettificato (Media)</div>
                <div class="indicator-value" :class="{ 'gap-alert': isGapAlert(adjustedGapResult.gapMedia) }">{{ formatPct(adjustedGapResult.gapMedia) }}</div>
              </div>
              <div class="adjusted-gap-box">
                <div class="adjusted-gap-label">Gap Rettificato (Mediana)</div>
                <div class="indicator-value" :class="{ 'gap-alert': isGapAlert(adjustedGapResult.gapMediana) }">{{ formatPct(adjustedGapResult.gapMediana) }}</div>
              </div>
              <div class="adjusted-gap-box">
                <div class="adjusted-gap-label">Gap Originale ({{ genderViewMode === 'media' ? 'Media' : 'Mediana' }})</div>
                <div class="indicator-value" :class="{ 'gap-alert': isGapAlert(genderViewMode === 'media' ? indicatorsResult.a_divarioRetributivoGenere.percentuale : indicatorsResult.c_divarioMedianoGenere.percentuale) }">
                  {{ formatPct(genderViewMode === 'media' ? indicatorsResult.a_divarioRetributivoGenere.percentuale : indicatorsResult.c_divarioMedianoGenere.percentuale) }}
                </div>
              </div>
              <div class="adjusted-gap-box">
                <div class="adjusted-gap-label">Esclusi</div>
                <div class="indicator-value plain">{{ adjustedGapResult.excluded }} / {{ adjustedGapResult.total }}</div>
              </div>
            </div>
            <p v-if="adjustedGapResult && indicatorsResult" class="adjusted-gap-note">
              <template v-if="Math.abs(adjustedGapResult.gapMedia) < Math.abs(indicatorsResult.a_divarioRetributivoGenere.percentuale)">
                Escludendo i top earners il divario si riduce di {{ formatPct(Math.abs(indicatorsResult.a_divarioRetributivoGenere.percentuale) - Math.abs(adjustedGapResult.gapMedia)) }}, indicando un impatto significativo dei ruoli apicali sul gap complessivo.
              </template>
              <template v-else>
                Il gap rettificato è pari o superiore a quello originale: i ruoli apicali non incidono significativamente sul divario.
              </template>
            </p>
          </section>

        </div>
        <div v-else-if="resultsTab === 'genere' && !indicatorsResult" class="no-data-msg">
          <strong>Analisi di genere non disponibile.</strong><br/>
          Per attivarla, verifica che nel file Excel sia presente una colonna <strong>Genere</strong> (con valori M/F, Maschio/Femmina, Uomo/Donna)
          e che sia mappata correttamente nel passo "Verifica assegnazione colonne".
          <br/><br/>
          <button class="btn-secondary" @click="analisiStep = 'mapping'">Torna al mapping colonne</button>
        </div>

        <!-- Sub-tab: Lavori di pari valore -->
        <div v-if="resultsTab === 'pari_valore' && jobResults.length > 0">
          <p class="result-source">Raggruppamento per <strong>Livello CCNL</strong></p>

          <div v-for="band in jobResults" :key="band.band" class="band-section">
            <h3 class="band-title">Fascia {{ band.band }} – {{ band.level }}</h3>
            <div class="band-summary">
              <span><strong>{{ band.n }}</strong> dipendenti ({{ band.nValid }} validi)</span>
              <span>Media retrib.: <strong>{{ formatNum(band.avgTotalSalary) }}</strong></span>
              <span>Media RAL: <strong>{{ formatNum(band.avgBaseSalary) }}</strong></span>
              <span :class="{ 'gap-alert': isGapAlert(band.deviationFromOverallMeanPct) }">
                Dev. dalla media globale: <strong>{{ formatPct(band.deviationFromOverallMeanPct) }}</strong>
                <button
                  v-if="isGapAlert(band.deviationFromOverallMeanPct)"
                  class="btn-justify"
                  :class="{ 'has-note': justifications[band.level] }"
                  title="Aggiungi giustificativo"
                  @click.stop="openJustify(band.level)"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>
                </button>
              </span>
              <span v-if="band.roles.length">Ruoli: {{ band.roles.join(', ') }}</span>
            </div>
            <div class="job-table" v-if="band.hayBands && band.hayBands.length">
              <div class="job-row header hay-row">
                <span>Sotto-fascia</span><span>Range score</span><span>Resp.</span><span>Problem solving</span><span>Competenze</span><span>Condizioni</span><span>Totale Hay</span><span>N</span><span>Media retrib.</span><span>Media U</span><span>Media D</span><span>Gap U-D</span>
              </div>
              <div
                v-for="sub in band.hayBands"
                :key="`${band.level}-${sub.label}`"
                class="job-row hay-row clickable"
                @click="toggleHayBand(band.level, sub.label)"
              >
                <span><strong>{{ isHayBandExpanded(band.level, sub.label) ? '▾' : '▸' }} {{ sub.id }}</strong></span>
                <span>{{ sub.label }}</span>
                <span>{{ formatNum(sub.avgHayResponsibility) }}</span>
                <span>{{ formatNum(sub.avgHayProblemSolving) }}</span>
                <span>{{ formatNum(sub.avgHayRequiredSkills) }}</span>
                <span>{{ formatNum(sub.avgHayWorkingConditions) }}</span>
                <span><strong>{{ formatNum(sub.avgHayTotalScore) }}</strong></span>
                <span>{{ sub.n }}</span>
                <span>{{ formatNum(sub.avgTotalSalary) }}</span>
                <span>{{ formatNum(sub.avgSalaryMen) }} <small class="muted">(n={{ sub.nMen }})</small></span>
                <span>{{ formatNum(sub.avgSalaryWomen) }} <small class="muted">(n={{ sub.nWomen }})</small></span>
                <span :class="{ 'gap-alert': isGapAlert(sub.genderPayGapPct) }">{{ formatPct(sub.genderPayGapPct) }}</span>
              </div>
              <template v-for="sub in band.hayBands" :key="`${band.level}-${sub.label}-roles-wrap`">
                <div
                  v-if="isHayBandExpanded(band.level, sub.label)"
                  :key="`${band.level}-${sub.label}-roles`"
                  class="people-detail"
                >
                  <div class="people-header"><span>Ruolo</span><span>N</span><span>Media retrib.</span><span>Media U</span><span>Media D</span><span>Gap U-D</span></div>
                  <div v-for="rb in roleBreakdown(sub.people)" :key="`${band.level}-${sub.label}-${rb.role}`" class="people-row">
                    <span>{{ rb.role }}</span>
                    <span>{{ rb.n }}</span>
                    <span>{{ formatNum(rb.avgSalary) }}</span>
                    <span>{{ formatNum(rb.avgMen) }} <small class="muted">(n={{ rb.nMen }})</small></span>
                    <span>{{ formatNum(rb.avgWomen) }} <small class="muted">(n={{ rb.nWomen }})</small></span>
                    <span :class="{ 'gap-alert': isGapAlert(rb.gapPct) }">{{ formatPct(rb.gapPct) }}</span>
                  </div>
                </div>
              </template>
            </div>
          </div>
          <div class="mapping-actions" style="margin-top: 1.5rem;">
            <button class="btn-primary" @click="exportJobGradingPdf">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="vertical-align: -3px; margin-right: 0.35rem;"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M12 18v-6M9 15l3 3 3-3"/></svg>
              Esporta PDF
            </button>
          </div>
        </div>
        <div v-else-if="resultsTab === 'pari_valore' && jobResults.length === 0" class="no-data-msg">
          Dati job grading non disponibili. Verifica che la colonna <strong>Livello</strong> sia mappata correttamente.
        </div>

        <div class="mapping-actions">
          <button class="btn-secondary" @click="analisiStep = 'mapping'">Modifica mapping</button>
          <button class="btn-primary" @click="startNuovaAnalisi">Nuova analisi</button>
        </div>

        <!-- Modal giustificativo -->
        <div v-if="justifyingLevel != null" class="justify-overlay" @click.self="cancelJustify">
          <div class="justify-modal">
            <h3>Giustificativo – {{ justifyingLevel }}</h3>
            <p class="justify-hint">Inserisci un giustificativo per la deviazione retributiva superiore a ±5% dalla media complessiva.</p>
            <textarea v-model="justifyText" class="justify-textarea" rows="5" placeholder="Motivo..."></textarea>
            <div class="justify-actions">
              <span style="flex:1"></span>
              <button class="btn-secondary" @click="cancelJustify">Annulla</button>
              <button class="btn-primary" @click="saveJustify">Salva</button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Storico analisi -->
    <template v-else-if="showStorico">
      <div class="analisi-content">
        <h2 class="analisi-title">Storico Analisi</h2>
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
                <th>Fonte</th>
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
                <td class="storico-actions">
                  <button
                    class="btn-view"
                    :disabled="storicoViewing === a.id"
                    @click="viewAnalysis(a.id)"
                  >
                    {{ storicoViewing === a.id ? '…' : 'Apri' }}
                  </button>
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

    <!-- Salary Review -->
    <template v-else-if="showSalaryReview">

      <!-- CTA buttons + Sub-tab bar -->
      <div v-if="srView === 'list'" class="sr-top-bar">
        <div class="sr-cta-bar">
          <button class="btn-primary" @click="startCreateRule">+ Nuova Regola</button>
          <button class="btn-outline" @click="startCreateIncrease">+ Nuovo Aumento</button>
        </div>
        <div class="results-subtabs">
          <button class="subtab" :class="{ active: srSubTab === 'reviews' }" @click="srSubTab = 'reviews'">
            Revisioni Salariali
            <span v-if="eligibleReviews.filter(r => reviewStatus(r.name) === 'pending').length" class="sr-badge">{{ eligibleReviews.filter(r => reviewStatus(r.name) === 'pending').length }}</span>
          </button>
          <button class="subtab" :class="{ active: srSubTab === 'rules' }" @click="srSubTab = 'rules'">Regole</button>
        </div>
      </div>

      <!-- Vista lista -->
      <template v-if="srView === 'list'">

        <!-- Sub-tab: Rules -->
        <template v-if="srSubTab === 'rules'">
          <p v-if="srRulesError" class="upload-error">{{ srRulesError }}</p>

          <div class="sr-section">
            <p v-if="srRulesLoading" class="storico-status">Caricamento regole…</p>
            <div v-if="!srRulesLoading && srRules.length === 0 && !srRulesError" class="no-data-msg">Nessuna regola creata.</div>
            <div class="sr-rules-grid">
              <article v-for="rule in srRules" :key="rule.id" class="sr-rule-card">
                <div class="sr-rule-header">
                  <h3>{{ rule.name || 'Regola senza nome' }}</h3>
                  <span class="sr-rule-year">{{ rule.year }}</span>
                </div>
                <div class="sr-rule-meta">
                  <span v-if="rule.applyToAll">Tutti i dipendenti</span>
                  <span v-else>{{ (rule.eligibleUsers || []).length }} dipendent{{ (rule.eligibleUsers || []).length !== 1 ? 'i' : 'e' }}</span>
                  <span>Trigger: {{ rule.triggerType === 'performance' ? 'Performance \u2265 ' + rule.performanceScore : (rule.objectives || []).length + ' obiettivi' }}</span>
                  <span>RAL +{{ rule.defaultRalPct }}% / Var +{{ rule.defaultVariablePct }}%</span>
                </div>
                <div class="sr-rule-meta">
                  <span>{{ (rule.approvalSteps || []).length }} step di approvazione</span>
                </div>
                <div class="sr-rule-actions">
                  <button class="btn-secondary" @click="editRule(rule)">Modifica</button>
                  <button class="btn-outline" @click="duplicateRule(rule)">Duplica</button>
                  <button class="btn-delete" @click="removeRule(rule.id)">Elimina</button>
                </div>
              </article>
            </div>
          </div>

          <div v-if="srIncreases.length > 0" class="sr-section">
            <h2 class="analisi-title">Aumenti</h2>
            <table class="storico-table">
              <thead>
                <tr><th>Dipendente</th><th>Base %</th><th>Variabile %</th><th>Note</th></tr>
              </thead>
              <tbody>
                <tr v-for="inc in srIncreases" :key="inc.id">
                  <td>{{ inc.employee || '–' }}</td>
                  <td>{{ inc.ralPct }}%</td>
                  <td>{{ inc.variablePct }}%</td>
                  <td>{{ inc.notes || '–' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <!-- Sub-tab: Salary Reviews -->
        <template v-if="srSubTab === 'reviews'">
          <div v-if="eligibleReviews.length === 0" class="no-data-msg">
            Nessun dipendente idoneo. Crea una regola nella tab Regole per generare le revisioni salariali.
          </div>
          <div v-else class="rv-list">
            <div class="rv-header">
              <span class="rv-col rv-col-name">NOME</span>
              <span class="rv-col rv-col-role">RUOLO</span>
              <span class="rv-col rv-col-perf">PERFORMANCE</span>
              <span class="rv-col rv-col-increase">AUMENTO PROPOSTO</span>
              <span class="rv-col rv-col-rule">REGOLA</span>
              <span class="rv-col rv-col-status">STATO</span>
              <span class="rv-col rv-col-actions">AZIONI</span>
            </div>
            <div
              v-for="rv in eligibleReviews"
              :key="rv.name"
              class="rv-row"
              :class="{ 'rv-row-removed': reviewStatus(rv.name) === 'removed' }"
            >
              <span class="rv-col rv-col-name">
                <span class="rv-avatar">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>
                </span>
                <span class="rv-name">{{ rv.name }}</span>
              </span>
              <span class="rv-col rv-col-role">
                <span class="rv-role-badge">{{ rv.role }}</span>
              </span>
              <span class="rv-col rv-col-perf">
                <span class="rv-perf-bar-wrap">
                  <span class="rv-perf-bar" :style="{ width: rv.performanceScore + '%' }" :class="rv.performanceScore >= 80 ? 'rv-perf-high' : rv.performanceScore >= 60 ? 'rv-perf-mid' : 'rv-perf-low'"></span>
                </span>
                <span class="rv-perf-label">{{ rv.performanceScore }}/100</span>
              </span>
              <span class="rv-col rv-col-increase">
                <span class="rv-increase-badge">Base +{{ rv.proposedRalPct }}%</span>
                <span class="rv-increase-badge rv-increase-var">Var +{{ rv.proposedVariablePct }}%</span>
              </span>
              <span class="rv-col rv-col-rule">{{ rv.ruleName }}</span>
              <span class="rv-col rv-col-status">
                <span class="sr-status" :class="'sr-status-' + reviewStatus(rv.name)">
                  {{ reviewStatus(rv.name) === 'approved' ? 'Approvato' : reviewStatus(rv.name) === 'rejected' ? 'Rifiutato' : reviewStatus(rv.name) === 'removed' ? 'Rimosso' : 'In attesa' }}
                </span>
              </span>
              <span class="rv-col rv-col-actions" v-if="reviewStatus(rv.name) !== 'removed'">
                <button class="rv-action-btn rv-action-view" title="Visualizza" @click="viewReview(rv)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
                <button class="rv-action-btn rv-action-delete" title="Elimina" @click="removeReview(rv.name)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
                </button>
              </span>
              <span class="rv-col rv-col-actions" v-else></span>
            </div>
          </div>
        </template>
      </template>

      <!-- Dettaglio review -->
      <template v-if="srView === 'viewReview' && srViewingReview">
        <div class="sr-form">
          <button class="btn-secondary" style="margin-bottom: 1rem;" @click="backToReviewsList">&larr; Torna alla lista</button>
          <h2 class="analisi-title">{{ srViewingReview.name }}</h2>
          <p class="sr-rule-meta" style="margin-bottom: 1.25rem;">{{ srViewingReview.role }} &middot; Regola: {{ srViewingReview.ruleName }}</p>

          <div class="sr-review-grid">
            <div class="sr-review-card">
              <div class="sr-review-card-label">Performance</div>
              <div class="sr-review-card-value" :class="{ 'gap-alert': srViewingReview.performanceScore < 60 }">{{ srViewingReview.performanceScore }} <span class="sr-hint">/ 100</span></div>
            </div>
            <div class="sr-review-card">
              <div class="sr-review-card-label">Aumento Base Proposto</div>
              <div class="sr-review-card-value">+{{ srViewingReview.proposedRalPct }}%</div>
            </div>
            <div class="sr-review-card">
              <div class="sr-review-card-label">Aumento Variabile Proposto</div>
              <div class="sr-review-card-value">+{{ srViewingReview.proposedVariablePct }}%</div>
            </div>
          </div>

          <div class="sr-form-section">
            <label class="sr-label">Obiettivi</label>
            <div class="sr-obj-list">
              <div v-for="obj in srViewingReview.objectives" :key="obj" class="sr-obj-item">
                <span class="sr-obj-check" :class="{ reached: (srViewingReview.objectivesReached || []).includes(obj) }">
                  {{ (srViewingReview.objectivesReached || []).includes(obj) ? '&#10003;' : '&#10007;' }}
                </span>
                <span>{{ obj }}</span>
              </div>
              <div v-if="!srViewingReview.objectives || srViewingReview.objectives.length === 0" class="sr-hint">Nessun obiettivo definito</div>
            </div>
          </div>

          <div class="sr-form-section">
            <label class="sr-label">Stato attuale: <span class="sr-status" :class="'sr-status-' + reviewStatus(srViewingReview.name)">{{ reviewStatus(srViewingReview.name) === 'approved' ? 'Approvato' : reviewStatus(srViewingReview.name) === 'rejected' ? 'Rifiutato' : 'In attesa' }}</span></label>
          </div>

          <div class="mapping-actions">
            <button class="btn-delete" style="padding: 0.65rem 1.25rem; font-size: 0.85rem;" @click="rejectReview(srViewingReview.name)">Rifiuta</button>
            <button class="btn-primary" @click="approveReview(srViewingReview.name)">Approva</button>
          </div>
        </div>
      </template>

      <!-- Pannello crea/modifica regola -->
      <template v-if="srView === 'editRule' && srCurrentRule">
        <div class="sr-form">
          <h2 class="analisi-title">{{ srRules.some(r => r.id === srCurrentRule.id) ? 'Modifica Regola' : 'Nuova Regola' }}</h2>

          <div class="sr-form-section">
            <label class="sr-label">Nome Regola</label>
            <input v-model="srCurrentRule.name" type="text" class="sr-input" placeholder="Es. Revisione Annuale 2026" />
          </div>

          <div class="sr-form-section">
            <label class="sr-label">Idoneità</label>
            <label class="sr-checkbox-row">
              <input type="checkbox" v-model="srCurrentRule.applyToAll" />
              <span>Applica a tutti i dipendenti</span>
            </label>
            <div v-if="!srCurrentRule.applyToAll" class="multi-select-wrap">
              <div class="multi-select-box" @click="srEligibilityDropdownOpen = !srEligibilityDropdownOpen">
                <div class="multi-select-pills">
                  <span v-for="(u, i) in srCurrentRule.eligibleUsers" :key="i" class="pill">
                    {{ u }}
                    <button type="button" class="pill-x" @click.stop="removePill(srCurrentRule.eligibleUsers, i)">&times;</button>
                  </span>
                  <span v-if="srCurrentRule.eligibleUsers.length === 0" class="multi-select-placeholder">Seleziona dipendenti...</span>
                </div>
                <span class="multi-select-arrow">&#9662;</span>
              </div>
              <div v-if="srEligibilityDropdownOpen" class="multi-select-dropdown">
                <div
                  v-for="u in sampleUsers" :key="u"
                  class="multi-select-option"
                  :class="{ selected: srCurrentRule.eligibleUsers.includes(u) }"
                  @click="toggleUserSelection(srCurrentRule.eligibleUsers, u)"
                >
                  <input type="checkbox" :checked="srCurrentRule.eligibleUsers.includes(u)" tabindex="-1" />
                  <span>{{ u }}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="sr-form-section">
            <label class="sr-label">Anno di Riferimento</label>
            <input v-model.number="srCurrentRule.year" type="number" class="sr-input sr-input-sm" min="2020" max="2040" />
          </div>

          <div class="sr-form-section">
            <label class="sr-label">Condizione di attivazione</label>
            <div class="sr-radio-group">
              <label class="sr-radio-row">
                <input type="radio" v-model="srCurrentRule.triggerType" value="performance" />
                <span>Punteggio performance minimo</span>
              </label>
              <div v-if="srCurrentRule.triggerType === 'performance'" class="sr-indent">
                <input v-model.number="srCurrentRule.performanceScore" type="number" class="sr-input sr-input-sm" min="0" max="100" />
                <span class="sr-hint">/ 100</span>
              </div>
              <label class="sr-radio-row">
                <input type="radio" v-model="srCurrentRule.triggerType" value="objectives" />
                <span>Obiettivi specifici raggiunti</span>
              </label>
              <div v-if="srCurrentRule.triggerType === 'objectives'" class="sr-indent">
                <div class="pills-wrap">
                  <span v-for="(o, i) in srCurrentRule.objectives" :key="i" class="pill">
                    {{ o }}
                    <button type="button" class="pill-x" @click="removePill(srCurrentRule.objectives, i)">&times;</button>
                  </span>
                  <input
                    v-model="srObjInput"
                    type="text"
                    class="pill-input"
                    placeholder="Aggiungi obiettivo e premi Invio"
                    @keydown.enter.prevent="addPill(srCurrentRule.objectives, srObjInput); srObjInput = '';"
                  />
                </div>
              </div>
            </div>
          </div>

          <div class="sr-form-section">
            <label class="sr-label">Workflow di Approvazione</label>
            <div class="wf-steps">
              <div v-for="(step, si) in srCurrentRule.approvalSteps" :key="si" class="wf-step">
                <div class="wf-step-header">
                  <span class="wf-step-num">{{ si + 1 }}</span>
                  <select v-model="step.type" class="sr-select">
                    <option value="manager">Manager Diretto</option>
                    <option value="users">Utenti Specifici</option>
                  </select>
                  <button v-if="srCurrentRule.approvalSteps.length > 1" type="button" class="wf-step-remove" @click="removeApprovalStep(si)">&times;</button>
                </div>
                <div v-if="step.type === 'users'" class="multi-select-wrap wf-step-pills">
                  <div class="multi-select-box" @click="srApprovalDropdownOpen[si] = !srApprovalDropdownOpen[si]">
                    <div class="multi-select-pills">
                      <span v-for="(u, ui) in step.users" :key="ui" class="pill">
                        {{ u }}
                        <button type="button" class="pill-x" @click.stop="removePill(step.users, ui)">&times;</button>
                      </span>
                      <span v-if="step.users.length === 0" class="multi-select-placeholder">Seleziona approvatori...</span>
                    </div>
                    <span class="multi-select-arrow">&#9662;</span>
                  </div>
                  <div v-if="srApprovalDropdownOpen[si]" class="multi-select-dropdown">
                    <div
                      v-for="u in sampleUsers" :key="u"
                      class="multi-select-option"
                      :class="{ selected: step.users.includes(u) }"
                      @click="toggleUserSelection(step.users, u)"
                    >
                      <input type="checkbox" :checked="step.users.includes(u)" tabindex="-1" />
                      <span>{{ u }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <button type="button" class="btn-outline sr-add-step" @click="addApprovalStep">+ Aggiungi step</button>
          </div>

          <div class="sr-form-section">
            <label class="sr-label">Aumento Predefinito</label>
            <div class="sr-pct-row">
              <div class="sr-pct-field">
                <label>% Base</label>
                <input v-model.number="srCurrentRule.defaultRalPct" type="number" class="sr-input sr-input-sm" min="0" step="0.5" />
              </div>
              <div class="sr-pct-field">
                <label>% Variabile</label>
                <input v-model.number="srCurrentRule.defaultVariablePct" type="number" class="sr-input sr-input-sm" min="0" step="0.5" />
              </div>
            </div>
          </div>

          <p v-if="srRulesError" class="upload-error">{{ srRulesError }}</p>
          <div class="mapping-actions">
            <button class="btn-secondary" :disabled="srSaving" @click="cancelRuleEdit">Annulla</button>
            <button class="btn-primary" :disabled="srSaving" @click="saveCurrentRule">
              {{ srSaving ? 'Salvataggio…' : 'Salva Regola' }}
            </button>
          </div>
        </div>
      </template>

      <!-- Form crea aumento -->
      <template v-if="srView === 'newIncrease' && srCurrentIncrease">
        <div class="sr-form">
          <h2 class="analisi-title">Nuovo Aumento</h2>

          <div class="sr-form-section">
            <label class="sr-label">Dipendente</label>
            <select v-model="srCurrentIncrease.employee" class="sr-select">
              <option value="" disabled>Seleziona dipendente...</option>
              <option v-for="u in sampleUsers" :key="u" :value="u">{{ u }}</option>
            </select>
          </div>

          <div class="sr-form-section">
            <div class="sr-pct-row">
              <div class="sr-pct-field">
                <label>Aumento Base %</label>
                <input v-model.number="srCurrentIncrease.ralPct" type="number" class="sr-input sr-input-sm" min="0" step="0.5" />
              </div>
              <div class="sr-pct-field">
                <label>Aumento Variabile %</label>
                <input v-model.number="srCurrentIncrease.variablePct" type="number" class="sr-input sr-input-sm" min="0" step="0.5" />
              </div>
            </div>
          </div>

          <div class="sr-form-section">
            <label class="sr-label">Note</label>
            <textarea v-model="srCurrentIncrease.notes" class="justify-textarea" rows="3" placeholder="Motivazione o dettagli..."></textarea>
          </div>

          <div class="mapping-actions">
            <button class="btn-secondary" @click="cancelIncreaseEdit">Annulla</button>
            <button class="btn-primary" @click="saveCurrentIncrease">Salva Aumento</button>
          </div>
        </div>
      </template>

    </template>
    </div>
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
  background: rgba(10, 108, 210, 0.06);
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
  background: linear-gradient(310deg, #2152ff 0%, #21d4fd 100%);
  color: white;
  font-size: 0.8125rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  cursor: pointer;
  box-shadow: var(--shadow-soft);
  transition: transform 0.15s, box-shadow 0.15s;
}

.btn-primary:hover {
  box-shadow: 0 4px 12px rgba(10, 108, 210, 0.35);
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
  background: rgba(10, 108, 210, 0.08);
}

.btn-icon svg {
  width: 22px;
  height: 22px;
}

/* Salary Review */
.sr-top-bar {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin-bottom: 1.5rem;
}

.sr-top-bar .sr-cta-bar {
  margin-bottom: 1rem;
}

.sr-top-bar .results-subtabs {
  margin-bottom: 0;
}

.sr-cta-bar {
  display: flex;
  gap: 0.75rem;
}

.sr-section {
  margin-bottom: 2rem;
}

.sr-rules-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 1rem;
}

.sr-rule-card {
  background: var(--bg-card);
  border-radius: var(--radius-md);
  padding: 1.25rem;
  box-shadow: var(--shadow-card);
  transition: box-shadow 0.15s;
}

.sr-rule-card:hover {
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.1);
}

.sr-rule-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 0.6rem;
}

.sr-rule-header h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-primary);
}

.sr-rule-year {
  font-size: 0.8rem;
  color: var(--text-secondary);
  font-weight: 600;
}

.sr-rule-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin-bottom: 0.5rem;
}

.sr-rule-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

/* Form regola / aumento */
.sr-form {
  max-width: 640px;
}

.sr-form-section {
  margin-bottom: 1.5rem;
}

.sr-label {
  display: block;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 0.4rem;
}

.sr-input {
  width: 100%;
  padding: 0.65rem 0.85rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
  color: var(--text-primary);
  background: var(--bg-card);
  box-sizing: border-box;
}

.sr-input:focus {
  outline: none;
  border-color: var(--accent-blue);
  box-shadow: 0 0 0 2px rgba(10, 108, 210, 0.2);
}

.sr-input-sm {
  width: 120px;
}

.sr-select {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 0.85rem;
  background: var(--bg-card);
  color: var(--text-primary);
  flex: 1;
}

.sr-checkbox-row {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: var(--text-primary);
  cursor: pointer;
  margin-bottom: 0.5rem;
}

.sr-checkbox-row input {
  width: 18px;
  height: 18px;
  accent-color: var(--accent-blue);
}

.sr-radio-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.sr-radio-row {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: var(--text-primary);
  cursor: pointer;
}

.sr-radio-row input {
  accent-color: var(--accent-blue);
}

.sr-indent {
  padding-left: 1.6rem;
  margin-top: 0.35rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.sr-hint {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.sr-pct-row {
  display: flex;
  gap: 1.5rem;
}

.sr-pct-field {
  flex: 1;
}

.sr-pct-field label {
  display: block;
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin-bottom: 0.3rem;
}

/* Pills */
.pills-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  align-items: center;
  min-height: 40px;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.6rem;
  background: rgba(10, 108, 210, 0.1);
  color: var(--accent-blue);
  border-radius: 20px;
  font-size: 0.8rem;
  font-weight: 500;
  white-space: nowrap;
}

.pill-x {
  border: none;
  background: none;
  color: var(--accent-blue);
  font-size: 1rem;
  cursor: pointer;
  padding: 0;
  line-height: 1;
  opacity: 0.7;
  transition: opacity 0.12s;
}

.pill-x:hover {
  opacity: 1;
}

.pill-input {
  border: none;
  outline: none;
  flex: 1;
  min-width: 140px;
  font-size: 0.85rem;
  color: var(--text-primary);
  background: transparent;
  padding: 0.2rem 0;
}

/* Workflow steps */
.wf-steps {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.wf-step {
  background: var(--bg-page);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
  padding: 0.75rem;
}

.wf-step-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.wf-step-num {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-blue);
  color: #fff;
  border-radius: 50%;
  font-size: 0.75rem;
  font-weight: 700;
  flex-shrink: 0;
}

.wf-step-remove {
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 1.1rem;
  cursor: pointer;
  padding: 0 0.3rem;
  line-height: 1;
  transition: color 0.12s;
}

.wf-step-remove:hover {
  color: #ef4444;
}

.wf-step-pills {
  margin-top: 0.5rem;
}

.sr-add-step {
  font-size: 0.8rem;
  padding: 0.4rem 0.75rem;
}

/* Salary Review badges & statuses */
.sr-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 10px;
  background: #ef4444;
  color: #fff;
  font-size: 0.7rem;
  font-weight: 700;
  margin-left: 6px;
}

.sr-status {
  display: inline-block;
  padding: 0.2rem 0.6rem;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 600;
}

.sr-status-pending {
  background: rgba(234, 179, 8, 0.12);
  color: #a16207;
}

.sr-status-approved {
  background: rgba(34, 197, 94, 0.12);
  color: #15803d;
}

.sr-status-rejected {
  background: rgba(239, 68, 68, 0.1);
  color: #dc2626;
}

.sr-status-removed {
  background: var(--border-light);
  color: var(--text-muted);
}

.sr-row-removed td {
  opacity: 0.45;
  text-decoration: line-through;
}

/* Review detail */
.sr-review-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.sr-review-card {
  background: var(--bg-card);
  border-radius: var(--radius-md);
  padding: 1rem 1.25rem;
  box-shadow: var(--shadow-soft);
}

.sr-review-card-label {
  font-size: 0.75rem;
  color: var(--text-secondary);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin-bottom: 0.35rem;
}

.sr-review-card-value {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--accent-blue);
}

.sr-obj-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.sr-obj-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: var(--text-primary);
}

.sr-obj-check {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 0.75rem;
  font-weight: 700;
  background: rgba(239, 68, 68, 0.1);
  color: #dc2626;
  flex-shrink: 0;
}

.sr-obj-check.reached {
  background: rgba(34, 197, 94, 0.12);
  color: #15803d;
}

/* Reviews card-row list */
.rv-list {
  width: 100%;
}

.rv-header {
  display: flex;
  align-items: center;
  padding: 0 1rem;
  margin-bottom: 0.25rem;
}

.rv-header .rv-col {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  user-select: none;
}

.rv-row {
  display: flex;
  align-items: center;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
  padding: 0.75rem 1rem;
  margin-bottom: 0.5rem;
  transition: box-shadow 0.15s;
}

.rv-row:hover {
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.09);
}

.rv-row-removed {
  opacity: 0.4;
}

.rv-col {
  display: flex;
  align-items: center;
  min-width: 0;
}

.rv-col-name {
  flex: 2;
  gap: 0.6rem;
  font-weight: 600;
  color: var(--text-primary);
}

.rv-col-role {
  flex: 1.5;
}

.rv-col-perf {
  flex: 1.5;
  gap: 0.5rem;
}

.rv-col-increase {
  flex: 1.8;
  gap: 0.35rem;
}

.rv-col-rule {
  flex: 1.2;
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.rv-col-status {
  flex: 1;
}

.rv-col-actions {
  flex: 0 0 80px;
  justify-content: flex-end;
  gap: 0.35rem;
}

.rv-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: linear-gradient(310deg, rgba(33, 82, 255, 0.15) 0%, rgba(33, 212, 253, 0.15) 100%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #0a6cd2;
  flex-shrink: 0;
}

.rv-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rv-role-badge {
  display: inline-block;
  padding: 0.2rem 0.65rem;
  border-radius: 12px;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  background: linear-gradient(310deg, #2152ff 0%, #21d4fd 100%);
  color: #fff;
  white-space: nowrap;
}

.rv-perf-bar-wrap {
  display: block;
  width: 60px;
  height: 6px;
  border-radius: 3px;
  background: var(--border-light);
  overflow: hidden;
  flex-shrink: 0;
}

.rv-perf-bar {
  display: block;
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s;
}

.rv-perf-high { background: linear-gradient(90deg, #22c55e, #16a34a); }
.rv-perf-mid  { background: linear-gradient(90deg, #eab308, #f59e0b); }
.rv-perf-low  { background: linear-gradient(90deg, #ef4444, #f87171); }

.rv-perf-label {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
}

.rv-increase-badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 10px;
  font-size: 0.72rem;
  font-weight: 600;
  background: rgba(34, 197, 94, 0.1);
  color: #15803d;
  white-space: nowrap;
}

.rv-increase-var {
  background: rgba(10, 108, 210, 0.1);
  color: #0a6cd2;
}

.rv-action-btn {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}

.rv-action-view:hover {
  background: rgba(10, 108, 210, 0.1);
  color: #0a6cd2;
}

.rv-action-delete:hover {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

@media (max-width: 900px) {
  .rv-header { display: none; }
  .rv-row {
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .rv-col-name { flex: 1 1 100%; }
  .rv-col-role,
  .rv-col-perf,
  .rv-col-increase,
  .rv-col-rule,
  .rv-col-status { flex: 1 1 45%; }
  .rv-col-actions { flex: 1 1 100%; justify-content: flex-start; }
}

/* Multi-select dropdown */
.multi-select-wrap {
  position: relative;
}

.multi-select-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  cursor: pointer;
  min-height: 40px;
  transition: border-color 0.15s;
}

.multi-select-box:hover {
  border-color: var(--accent-blue);
}

.multi-select-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  flex: 1;
  align-items: center;
}

.multi-select-placeholder {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.multi-select-arrow {
  font-size: 0.7rem;
  color: var(--text-muted);
  margin-left: 0.5rem;
  flex-shrink: 0;
}

.multi-select-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 50;
  margin-top: 2px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
  max-height: 220px;
  overflow-y: auto;
}

.multi-select-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.55rem 0.75rem;
  font-size: 0.85rem;
  color: var(--text-primary);
  cursor: pointer;
  transition: background 0.1s;
}

.multi-select-option:hover {
  background: rgba(10, 108, 210, 0.06);
}

.multi-select-option.selected {
  background: rgba(10, 108, 210, 0.1);
  font-weight: 600;
}

.multi-select-option input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent-blue);
  pointer-events: none;
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
  background: rgba(10, 108, 210, 0.08);
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
  gap: 0;
  margin-bottom: 1.25rem;
  border-bottom: 1px solid var(--border-light);
}

.subtab {
  padding: 0.7rem 1.25rem;
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: none;
  color: var(--text-secondary);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.subtab:hover:not(:disabled) {
  color: var(--accent-blue);
}

.subtab.active {
  color: var(--accent-blue);
  border-bottom-color: var(--accent-blue);
  font-weight: 600;
  background: none;
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
  background: rgba(10, 108, 210, 0.04);
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

.storico-actions {
  display: flex;
  gap: 0.4rem;
}

.btn-view {
  background: none;
  border: 1px solid var(--accent-blue);
  color: var(--accent-blue);
  padding: 0.3rem 0.7rem;
  border-radius: 6px;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.btn-view:hover:not(:disabled) {
  background: var(--accent-blue);
  color: #fff;
}

.btn-view:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
  color: var(--primary);
}

.band-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.5rem;
  padding: 0.75rem 1rem;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-soft);
  font-size: 0.85rem;
  margin-bottom: 0.5rem;
  align-items: center;
}

.job-table {
  width: 100%;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-soft);
  overflow-x: auto;
}

.job-row {
  display: grid;
  grid-template-columns: 2fr 0.6fr 1fr repeat(4, 0.7fr) 0.8fr 1.1fr 0.9fr 0.5fr;
  gap: 0.5rem;
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border-light);
  align-items: center;
  font-size: 0.82rem;
}

.job-row.hay-row {
  grid-template-columns: 0.8fr 0.9fr repeat(4, 0.8fr) 0.9fr 0.6fr 1fr 1fr 1fr 0.8fr;
}

.job-row.clickable {
  cursor: pointer;
  transition: background 0.12s;
}

.job-row.clickable:hover {
  background: rgba(10, 108, 210, 0.04);
}

.job-row.expanded {
  background: rgba(10, 108, 210, 0.06);
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
  box-shadow: 0 0 0 2px rgba(10, 108, 210, 0.15);
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
  box-shadow: 0 0 0 2px rgba(10, 108, 210, 0.2);
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
  background: rgba(10, 108, 210, 0.04);
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

/* Pulsante giustificativo */
.btn-justify {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: #f3f4f6;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0;
  margin-left: 4px;
  vertical-align: middle;
  transition: all 0.15s;
}

.btn-justify:hover {
  background: #e5e7eb;
  border-color: var(--text-muted);
  color: var(--text-primary);
}

.btn-justify.has-note {
  background: rgba(10, 108, 210, 0.1);
  border-color: var(--accent-blue);
  color: var(--accent-blue);
}

/* Modal giustificativo */
.justify-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.justify-modal {
  background: var(--bg-card);
  border-radius: var(--radius-md);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
  padding: 1.75rem 2rem;
  width: 90%;
  max-width: 520px;
}

.justify-modal h3 {
  margin: 0 0 0.5rem;
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text-primary);
}

.justify-hint {
  margin: 0 0 1rem;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  line-height: 1.45;
}

.justify-textarea {
  width: 100%;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
  font-family: inherit;
  color: var(--text-primary);
  background: var(--bg-page);
  resize: vertical;
  box-sizing: border-box;
}

.justify-textarea:focus {
  outline: none;
  border-color: var(--accent-blue);
  box-shadow: 0 0 0 2px rgba(10, 108, 210, 0.2);
}

.justify-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 1rem;
}
.btn-ai {
  padding: 0.4rem 0.9rem;
  border: 1px solid var(--primary, #0a6cd2);
  border-radius: var(--radius-sm);
  background: rgba(10, 108, 210, 0.06);
  color: var(--primary, #0a6cd2);
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, box-shadow 0.15s;
  display: inline-flex;
  align-items: center;
}
.btn-ai:hover:not(:disabled) {
  background: rgba(10, 108, 210, 0.14);
  box-shadow: 0 2px 8px rgba(10, 108, 210, 0.15);
}
.btn-ai:disabled {
  opacity: 0.6;
  cursor: wait;
}
.spinner-sm {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(10, 108, 210, 0.2);
  border-top-color: var(--primary, #0a6cd2);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

/* Analysis Settings Panel */
.settings-panel {
  background: var(--bg-card);
  border-radius: var(--radius-md);
  padding: 1.25rem 1.5rem;
  box-shadow: var(--shadow-soft);
  margin: 1.5rem 0;
  border: 1px solid var(--border-light);
}

.settings-title {
  margin: 0 0 1rem;
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-primary);
}

.settings-row {
  margin-bottom: 1.25rem;
}

.settings-row:last-child {
  margin-bottom: 0;
}

.settings-hint {
  margin: 0 0 0.5rem;
  font-size: 0.8rem;
  color: var(--text-muted);
  line-height: 1.4;
}

.weights-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 0.75rem;
}

.weight-field label {
  display: block;
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin-bottom: 0.3rem;
  font-weight: 500;
}

.weight-input-wrap {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}

.weight-pct {
  font-size: 0.85rem;
  color: var(--text-secondary);
  font-weight: 600;
}

.weights-total {
  margin: 0.6rem 0 0;
  font-size: 0.825rem;
  font-weight: 600;
  color: var(--text-secondary);
}

.weights-error {
  color: #dc2626;
}

/* Warning row for >25% deviation */
.row-warning {
  background: rgba(245, 158, 11, 0.08) !important;
  border-left: 3px solid #f59e0b;
}
.job-family-cell {
  font-size: 0.82rem;
  display: flex;
  align-items: center;
  gap: 0.3rem;
}
.multiplier-badge {
  background: var(--primary);
  color: #fff;
  font-size: 0.68rem;
  padding: 0.1rem 0.35rem;
  border-radius: 8px;
  font-weight: 600;
  white-space: nowrap;
}
.level-tag {
  background: var(--bg-page);
  border: 1px solid var(--border-light);
  color: var(--text-secondary);
  font-size: 0.7rem;
  padding: 0.08rem 0.35rem;
  border-radius: 6px;
  font-weight: 600;
  margin-left: 0.2rem;
}
.weights-bar {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  flex-wrap: wrap;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  padding: 0.6rem 1rem;
  margin-bottom: 1.2rem;
  box-shadow: var(--shadow-soft);
}
.weights-bar-label {
  font-weight: 600;
  font-size: 0.85rem;
  color: var(--text-primary);
}
.wb-field {
  font-size: 0.8rem;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 0.25rem;
  white-space: nowrap;
}
.wb-input {
  width: 48px;
  padding: 0.2rem 0.3rem;
  border: 1px solid var(--border-light);
  border-radius: 6px;
  text-align: center;
  font-size: 0.8rem;
  background: var(--bg-page);
}
.wb-input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 2px rgba(10, 108, 210, 0.12);
}
.wb-total {
  font-weight: 700;
  font-size: 0.85rem;
  color: var(--text-primary);
}
.btn-sm {
  padding: 0.3rem 0.85rem;
  font-size: 0.8rem;
  border-radius: 6px;
}

/* Gender dashboard toggle */
.gender-dashboard-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 1.5rem 0 1rem;
  padding: 0.75rem 1rem;
  background: var(--bg-card);
  border-radius: 10px;
  box-shadow: var(--shadow-soft);
  flex-wrap: wrap;
}
.toggle-label {
  font-weight: 600;
  font-size: 0.9rem;
  color: var(--text-primary);
  margin-right: 0.25rem;
}
.toggle-btn {
  padding: 0.35rem 1rem;
  border: 1px solid var(--border-light);
  border-radius: 6px;
  background: var(--bg-page);
  cursor: pointer;
  font-size: 0.85rem;
  transition: all 0.15s;
}
.toggle-btn.active {
  background: var(--primary);
  color: #fff;
  border-color: var(--primary);
  font-weight: 600;
}
.eu-compliant-msg {
  color: #16a34a;
  font-weight: 600;
  font-size: 0.85rem;
  margin-left: 0.5rem;
  padding: 0.25rem 0.75rem;
  background: rgba(22, 163, 74, 0.08);
  border-radius: 6px;
}

/* Band gender gap table */
.band-gender-section {
  margin-top: 1rem;
}
.band-gender-table {
  display: grid;
  gap: 0;
  font-size: 0.85rem;
}
.band-gender-row {
  display: grid;
  grid-template-columns: 60px 80px 80px 120px 110px 1fr;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  align-items: center;
  border-bottom: 1px solid var(--border-light);
}
.band-gender-row.header {
  font-weight: 700;
  background: var(--bg-page);
  border-radius: 6px 6px 0 0;
  color: var(--text-secondary);
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.band-gender-row.gap-over {
  background: rgba(239, 68, 68, 0.05);
}
.band-gender-row.gap-ok {
  background: rgba(22, 163, 74, 0.04);
}
.gap-value {
  font-weight: 600;
}
.status-badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
}
.status-badge.compliant {
  background: rgba(22, 163, 74, 0.12);
  color: #16a34a;
}
.status-badge.non-compliant {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}
.btn-justify-open {
  font-size: 0.78rem;
  padding: 0.25rem 0.6rem;
  border: 1px dashed var(--border-light);
  border-radius: 6px;
  background: var(--bg-page);
  cursor: pointer;
  color: var(--primary);
  font-weight: 500;
  transition: all 0.15s;
}
.btn-justify-open:hover {
  border-color: var(--primary);
  background: rgba(10, 108, 210, 0.05);
}
.band-justify-summary {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.78rem;
  color: var(--text-primary);
  cursor: pointer;
  padding: 0.2rem 0.5rem;
  background: rgba(10, 108, 210, 0.06);
  border-radius: 5px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.band-justify-summary:hover { background: rgba(10, 108, 210, 0.1); }
.btn-link-sm {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 0.85rem;
  padding: 0;
}
.btn-link-sm:hover { color: #ef4444; }

/* Justification panel */
.band-justify-panel {
  grid-column: 1 / -1;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: 10px;
  padding: 1rem 1.25rem;
  margin: 0.25rem 0 0.5rem;
  box-shadow: var(--shadow-soft);
}
.bjp-header {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}
.bjp-header strong { font-size: 0.9rem; }
.bjp-reasons {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.bjp-reason-btn {
  display: grid;
  grid-template-columns: 28px 1fr 22px;
  grid-template-rows: auto auto;
  gap: 0 0.4rem;
  padding: 0.6rem 0.75rem;
  border: 1.5px solid var(--border-light);
  border-radius: 8px;
  background: var(--bg-page);
  cursor: pointer;
  text-align: left;
  transition: all 0.15s;
}
.bjp-reason-btn:hover {
  border-color: var(--primary);
  background: rgba(10, 108, 210, 0.03);
}
.bjp-reason-btn.active {
  border-color: var(--primary);
  background: rgba(10, 108, 210, 0.08);
  box-shadow: 0 0 0 2px rgba(10, 108, 210, 0.12);
}
.bjp-reason-icon {
  grid-row: 1 / 3;
  font-size: 1.2rem;
  align-self: center;
}
.bjp-reason-label {
  font-weight: 600;
  font-size: 0.82rem;
  color: var(--text-primary);
}
.bjp-reason-desc {
  grid-column: 2;
  font-size: 0.72rem;
  color: var(--text-secondary);
  line-height: 1.3;
}
.bjp-reason-check {
  grid-row: 1 / 3;
  align-self: center;
  justify-self: center;
  font-size: 0.9rem;
  color: var(--primary);
  font-weight: 700;
}
.bjp-note { margin-bottom: 0.75rem; }
.bjp-note-label {
  display: block;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 0.3rem;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.bjp-note-input {
  width: 100%;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border-light);
  border-radius: 6px;
  font-size: 0.82rem;
  background: var(--bg-page);
  resize: vertical;
  font-family: inherit;
}
.bjp-note-input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 2px rgba(10, 108, 210, 0.12);
}
.bjp-files { margin-bottom: 0.75rem; }
.bjp-file-list {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-bottom: 0.5rem;
}
.bjp-file-item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.5rem;
  background: var(--bg-page);
  border-radius: 5px;
  font-size: 0.8rem;
  border: 1px solid var(--border-light);
}
.bjp-file-icon { font-size: 0.9rem; }
.bjp-file-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.bjp-file-size {
  color: var(--text-secondary);
  font-size: 0.72rem;
}
.bjp-upload-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.35rem 0.75rem;
  border: 1px dashed var(--border-light);
  border-radius: 6px;
  background: var(--bg-page);
  cursor: pointer;
  font-size: 0.8rem;
  color: var(--primary);
  font-weight: 500;
  transition: all 0.15s;
}
.bjp-upload-btn:hover {
  border-color: var(--primary);
  background: rgba(10, 108, 210, 0.05);
}
.bjp-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

/* Adjusted gap section */
.adjusted-gap-section {
  margin-top: 1rem;
}
.adjusted-gap-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 1rem;
  margin-top: 0.75rem;
}
.adjusted-gap-box {
  text-align: center;
  padding: 0.75rem;
  background: var(--bg-page);
  border-radius: 8px;
  border: 1px solid var(--border-light);
}
.adjusted-gap-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin-bottom: 0.25rem;
}
.indicator-value.plain {
  color: var(--text-primary);
  font-size: 1.5rem;
}
.adjusted-gap-note {
  margin-top: 0.75rem;
  font-size: 0.85rem;
  color: var(--text-secondary);
  line-height: 1.5;
}
</style>
