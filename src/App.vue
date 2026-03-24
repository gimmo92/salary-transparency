<script setup>
import { ref, computed, onMounted, nextTick } from 'vue'
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
  suggestJustificationWithGemini,
} from './lib/gemini.js'
import {
  buildNormalizedJobGradingData,
  groupByLevel,
  enrichWithDeviation,
  seniorityToYearsNumeric,
} from './lib/jobGrading.js'
import {
  TRANSPARENCY_MACRO_AREAS,
  TRANSPARENCY_FLAT_FACTORS,
  trFieldName,
  transparencyParametricPointsFromFactor,
} from './lib/transparencyCriteria.js'
import {
  computeEuGenderDashboard,
  computeQuartileOutliers,
  gapSeverityClass as euGapSeverityClass,
  EU_GAP_THRESHOLD_PCT,
} from './lib/euGenderDashboard.js'
import { saveAnalysis, fetchAnalyses, fetchAnalysisById, deleteAnalysisById, fetchRules, saveRule, updateRuleById, deleteRuleById } from './lib/persistence.js'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'

const activeSection = ref('analisi')

/** Tab principali (Revisione salariale nascosta per ora) */
const sections = [
  { id: 'analisi', label: 'Analisi', icon: 'table' },
  { id: 'storico', label: 'Storico', icon: 'history' },
]

// Flusso unificato
const analisiStep = ref('upload') // idle | upload | mapping | results — default upload con sezione Analisi
const excelRows = ref([])
const excelHeaders = ref([])
const columnMapping = ref({})
const excelUrl = ref('')
const uploadError = ref('')
/** Avviso informativo (non errore) su mapping euristico / Gemini */
const geminiInfoNotice = ref('')
const uploadLoading = ref(false)
const geminiLoading = ref(false)
const analysisLoading = ref(false)
const saveStatus = ref('')

const indicatorsResult = ref(null)
const indicatorsSource = ref('locale')

const jobResults = ref([])

/** Override punteggi 1–5 per ruolo: chiave `${livelloCCNL}|${nomeRuolo}` → { factorId: number } */
const transparencyRoleOverrides = ref({})
const jobGradingCriteriaModalOpen = ref(false)
/** Popup scheda punteggi fattori per ruolo: { level, subLabel, roleName } */
const roleValuationModal = ref(null)

const roleValuationModalRb = computed(() => {
  const ctx = roleValuationModal.value
  if (!ctx) return null
  const band = jobResults.value.find((b) => b.level === ctx.level)
  const sub = band?.hayBands?.find((h) => h.label === ctx.subLabel)
  return sub?.roles?.find((r) => r.role === ctx.roleName) ?? null
})

function openRoleValuationModal(level, subLabel, roleName) {
  const band = jobResults.value.find((b) => b.level === level)
  const sub = band?.hayBands?.find((h) => h.label === subLabel)
  const role = sub?.roles?.find((r) => r.role === roleName)
  if (!role) return
  const next = emptyRoleTransparencyForm()
  for (const f of TRANSPARENCY_FLAT_FACTORS) {
    next[f.id] = clampTrScore(role[trFieldName(f.id)])
  }
  roleValuationForm.value = next
  roleValuationModal.value = { level, subLabel, roleName }
}
function closeRoleValuationModal() {
  roleValuationModal.value = null
}
function saveRoleValuationModal() {
  const ctx = roleValuationModal.value
  if (!ctx) return
  const overrides = {}
  for (const f of TRANSPARENCY_FLAT_FACTORS) {
    overrides[f.id] = clampTrScore(roleValuationForm.value[f.id])
  }
  const key = `${ctx.level}|${ctx.roleName}`
  transparencyRoleOverrides.value = { ...transparencyRoleOverrides.value, [key]: overrides }
  roleValuationModal.value = null
  runJobGrading()
}

/** Risultati analisi: dashboard UE genere (default) | job grading | giustificativo persona */
const resultsTab = ref('eu_dashboard')
/** Tab risultati da ripristinare dopo chiusura giustificativo persona */
const resultsTabBeforeJustify = ref('job_grading')
/** Retribuzione per KPI dashboard: base o totale */
const euDashboardSalaryMode = ref('total')

/** Giustificativi outlier quartile: chiave = index dipendente; testo non vuoto = escluso dall'analisi */
const quartileOutlierJustifications = ref({})

function isQuartileAnalysisExcluded(index) {
  const t = quartileOutlierJustifications.value[String(index)]
  return typeof t === 'string' && t.trim().length > 0
}

const geminiEnabled = ref(false)
/** true se /api/gemini/status non risponde (es. solo Vite senza server API) */
const geminiApiUnreachable = ref(false)

/** Area scroll principale (per scroll in alto aprendo giustificativo) */
const mainWrapRef = ref(null)

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
  COLUMN_ROLES.seniority,
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
    quartileOutlierJustifications.value = {}

    analisiStep.value = 'results'
    resultsTab.value = 'eu_dashboard'
    justifyingPerson.value = null
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

function isPersonJustified(person) {
  const key = String(person?.index || '')
  if (!key) return false
  const note = personJustifications.value[key]
  return typeof note === 'string' && note.trim().length > 0
}

function hayBandAdjustedGapPct(hayBand) {
  const people = (hayBand?.people || []).filter(
    (p) =>
      Number.isFinite(p?.totalSalary) &&
      p.totalSalary > 0 &&
      !isPersonJustified(p) &&
      !isQuartileAnalysisExcluded(p?.index),
  )
  const men = people.filter((p) => p.gender === 'M').map((p) => p.totalSalary)
  const women = people.filter((p) => p.gender === 'F').map((p) => p.totalSalary)
  if (!men.length || !women.length) return null
  const menAvg = men.reduce((s, v) => s + v, 0) / men.length
  const womenAvg = women.reduce((s, v) => s + v, 0) / women.length
  if (!menAvg) return null
  return ((menAvg - womenAvg) / menAvg) * 100
}

function hayBandHasJustifications(hayBand) {
  return (hayBand?.people || []).some((p) => isPersonJustified(p))
}

function hasHayBandDisparity(hayBand) {
  return isGapAlert(hayBandAdjustedGapPct(hayBand))
}

/** Numero di fasce Job Grading con gap M/F oltre ±5% (da corregere / giustificare) */
const jobGradingGapsToFixCount = computed(() => {
  let n = 0
  for (const band of jobResults.value || []) {
    for (const sub of band.hayBands || []) {
      if (hasHayBandDisparity(sub)) n += 1
    }
  }
  return n
})

function personGenderClass(gender) {
  if (gender === 'M') return 'gender-male'
  if (gender === 'F') return 'gender-female'
  return 'gender-unknown'
}

const expandedHayBands = ref(new Set())
const expandedRoleDetails = ref(new Set())

function hayBandKey(level, label) {
  return `${level}::${label}`
}

function expandAllRolesForFascia(level, subLabel, roles) {
  const next = new Set(expandedRoleDetails.value)
  for (const rb of roles || []) {
    if (rb?.role != null) next.add(roleDetailKey(level, subLabel, rb.role))
  }
  expandedRoleDetails.value = next
}

function collapseAllRolesForFascia(level, subLabel, roles) {
  const next = new Set(expandedRoleDetails.value)
  for (const rb of roles || []) {
    if (rb?.role != null) next.delete(roleDetailKey(level, subLabel, rb.role))
  }
  expandedRoleDetails.value = next
}

/** Aprendo una fascia si espandono anche tutti i ruoli (lista persone visibile); chiudendo si collassano. */
function toggleHayBand(level, label, sub) {
  const key = hayBandKey(level, label)
  const roles = sub?.roles
  if (expandedHayBands.value.has(key)) {
    expandedHayBands.value.delete(key)
    collapseAllRolesForFascia(level, label, roles)
  } else {
    expandedHayBands.value.add(key)
    expandAllRolesForFascia(level, label, roles)
  }
  expandedHayBands.value = new Set(expandedHayBands.value)
}

function isHayBandExpanded(level, label) {
  return expandedHayBands.value.has(hayBandKey(level, label))
}

function roleDetailKey(level, subLabel, role) {
  return `${level}::${subLabel}::${role}`
}

function toggleRoleDetail(level, subLabel, role) {
  const key = roleDetailKey(level, subLabel, role)
  if (expandedRoleDetails.value.has(key)) expandedRoleDetails.value.delete(key)
  else expandedRoleDetails.value.add(key)
  expandedRoleDetails.value = new Set(expandedRoleDetails.value)
}

function isRoleDetailExpanded(level, subLabel, role) {
  return expandedRoleDetails.value.has(roleDetailKey(level, subLabel, role))
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
    const grouped = groupByLevel(enrichedJob, transparencyRoleOverrides.value)
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
  geminiInfoNotice.value = ''
  indicatorsResult.value = null
  jobResults.value = []
  saveStatus.value = ''
  justifications.value = {}
  justifyingLevel.value = null
  genderViewMode.value = 'media'
  genderNormalizedCache.value = []
  quartileOutlierJustifications.value = {}
  transparencyRoleOverrides.value = {}
  bandGenderJustifications.value = {}
  resultsTab.value = 'eu_dashboard'
  euDashboardSalaryMode.value = 'total'
  justifyingPerson.value = null
}

function goToMappingFromResults() {
  analisiStep.value = 'mapping'
  justifyingPerson.value = null
  justifyText.value = ''
}

function goToUpload() {
  analisiStep.value = 'upload'
  uploadError.value = ''
  geminiInfoNotice.value = ''
}

async function onLoadFromUrl() {
  const url = (excelUrl.value || '').trim()
  if (!url) { uploadError.value = 'Inserisci il collegamento al file Excel.'; return }
  uploadError.value = ''
  geminiInfoNotice.value = ''
  uploadLoading.value = true
  geminiLoading.value = false
  try {
    const { rows, headers } = await parseExcelFromUrl(url)
    excelRows.value = rows
    excelHeaders.value = headers
    quartileOutlierJustifications.value = {}
    transparencyRoleOverrides.value = {}
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
      if (geminiApiUnreachable.value) {
        geminiInfoNotice.value =
          'Gemini non disponibile: in ambiente di sviluppo le route /api/gemini non sono servite da Vite. Usa il mapping euristico oppure avvia il progetto con `vercel dev` (con variabile GOOGLE_AI_API_KEY) oppure configura la chiave sul deploy. Vedi anche .env.example nella cartella del progetto.'
      } else {
        geminiInfoNotice.value =
          'Gemini non attivo: imposta la variabile GOOGLE_AI_API_KEY (Google AI Studio) nel pannello Environment Variables del deploy (es. Vercel → Settings → Environment Variables). È attivo il mapping euristico delle colonne.'
      }
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
  justifyingPerson.value = null
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
      uploadError.value = 'Nessun dato valido. Verifica il mapping delle colonne per il job grading.'
      return
    }

    // Gender gap per band & gap rettificato
    genderNormalizedCache.value = normalizedGender
    bandGenderJustifications.value = {}
    quartileOutlierJustifications.value = {}
    transparencyRoleOverrides.value = {}

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

    resultsTab.value = 'eu_dashboard'
    analisiStep.value = 'results'
  } finally { analysisLoading.value = false }
}

function formatPct(n) { return n == null ? '–' : n.toFixed(2) + '%' }

function formatPctSigned(n) {
  if (n == null || !Number.isFinite(n)) return '–'
  const sign = n > 0 ? '+' : ''
  return `${sign}${n.toFixed(1)}%`
}
/** Scostamento % retribuzione totale vs media della fascia (stesso bucket punteggio) */
function formatDeviationVsBandMean(p) {
  return formatPctSigned(p?.deviationFromHayBandMeanPct)
}
/** Punteggio performance mock (40–100), deterministico per indice dipendente */
function mockPerformanceScoreForPerson(personIndex) {
  const k = Number(personIndex) || 0
  const x = Math.sin(k * 12.9898) * 43758.5453
  const frac = x - Math.floor(x)
  return Math.round(40 + frac * 55)
}

/** Gap da pctGap / media M vs F: positivo = uomini pagati di più, negativo = donne pagate di più */
function formatGapMforF(gap, rettificato = false) {
  if (gap == null || !Number.isFinite(gap)) return '–'
  const a = Math.abs(gap)
  let body
  if (a < 1e-9) body = '0%'
  else {
    const letter = gap > 0 ? 'M' : 'F'
    body = `${letter} + ${a.toFixed(2)}%`
  }
  const lead = rettificato ? 'Gap rett.: ' : 'Gap: '
  return `${lead}${body}`
}
function formatNum(n) { return n == null ? '–' : Number(n).toLocaleString('it-IT', { maximumFractionDigits: 2 }) }
function clampScoreInput(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 1
  return Math.max(1, Math.min(100, Math.round(n)))
}
function clampTrScore(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 3
  return Math.max(1, Math.min(5, Math.round(n)))
}
function emptyRoleTransparencyForm() {
  const o = {}
  for (const f of TRANSPARENCY_FLAT_FACTORS) {
    o[f.id] = 3
  }
  return o
}
/** Form modifica punteggi nel popup Dettaglio valutazione */
const roleValuationForm = ref(emptyRoleTransparencyForm())
function roleTr(role, factorId) {
  if (!role) return null
  return role[trFieldName(factorId)]
}
/** Punti parametrici 0–100 per macro-area: Σ (% peso fattore × voto 1–5 / 5). */
function roleMacroAreaParametricPoints(role, area) {
  if (!role || !area?.factors?.length) return null
  let pts = 0
  let any = false
  for (const f of area.factors) {
    const s = roleTr(role, f.id)
    if (s == null || !Number.isFinite(Number(s))) continue
    any = true
    pts += transparencyParametricPointsFromFactor(Number(s), f.weightPct)
  }
  return any ? Math.round(pts * 100) / 100 : null
}
function macroAreaMaxParametricPoints(area) {
  return area.factors.reduce((sum, f) => sum + f.weightPct, 0)
}
function macroAreaParametricTooltip(role, area) {
  const pts = roleMacroAreaParametricPoints(role, area)
  if (pts == null) return ''
  const max = macroAreaMaxParametricPoints(area)
  return `Punti parametrici (scala 0–100): Σ (% peso × voto / 5) per i fattori dell’area. Massimo ${max} se tutti i voti sono 5.`
}
function formatMacroAreaScore(role, area) {
  const s = roleMacroAreaParametricPoints(role, area)
  return s == null ? '–' : formatNum(s)
}
function previewValuationFormWeighted() {
  let w = 0
  for (const f of TRANSPARENCY_FLAT_FACTORS) {
    w += clampTrScore(roleValuationForm.value[f.id]) * (f.weightPct / 100)
  }
  return Math.round(w * 100) / 100
}
function previewValuationFormParametric100() {
  let pts = 0
  for (const f of TRANSPARENCY_FLAT_FACTORS) {
    pts += transparencyParametricPointsFromFactor(clampTrScore(roleValuationForm.value[f.id]), f.weightPct)
  }
  return Math.round(pts * 100) / 100
}
/** Contributo da form modifica (popup dettaglio) */
function formatFactorParametricContributionFromForm(factor) {
  const v = transparencyParametricPointsFromFactor(clampTrScore(roleValuationForm.value[factor.id]), factor.weightPct)
  return formatNum(v)
}
/** Contributo singolo fattore su scala 100: % peso × voto / 5 */
function formatFactorParametricContribution(role, factor) {
  const s = roleTr(role, factor.id)
  if (s == null || !Number.isFinite(Number(s))) return '–'
  const v = transparencyParametricPointsFromFactor(Number(s), factor.weightPct)
  return formatNum(v)
}
function meanLocal(values) {
  if (!values?.length) return 0
  return values.reduce((sum, v) => sum + Number(v || 0), 0) / values.length
}
// Giustificativi per livelli fuori soglia
const justifications = ref({})
const justifyingLevel = ref(null)
const justifyText = ref('')
const personJustifications = ref({})
const justifyingPerson = ref(null)
const justifyAiLoading = ref(false)

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

function openPersonJustify(person, roleBlock, band, hayBand) {
  const key = String(person?.index || '')
  if (!key || !roleBlock || !band || !hayBand) return

  const peopleInFascia =
    hayBand?.people?.length ? hayBand.people : person ? [person] : []
  const seniorityYearsList = peopleInFascia
    .map((p) => seniorityToYearsNumeric(p.seniority))
    .filter((n) => n != null && Number.isFinite(n) && n >= 0)
  const fascAvgSeniorityYears = seniorityYearsList.length
    ? meanLocal(seniorityYearsList)
    : null
  const seniorityYearsRaw = seniorityToYearsNumeric(person?.seniority)
  const seniorityPctVsFascia =
    fascAvgSeniorityYears != null &&
    fascAvgSeniorityYears > 0 &&
    seniorityYearsRaw != null &&
    Number.isFinite(seniorityYearsRaw)
      ? ((seniorityYearsRaw - fascAvgSeniorityYears) / fascAvgSeniorityYears) * 100
      : null

  const perfScores = peopleInFascia.map((p) => mockPerformanceScoreForPerson(p.index))
  const fascAvgPerformance = perfScores.length ? meanLocal(perfScores) : null
  const performanceScore = mockPerformanceScoreForPerson(person?.index)
  const performancePctVsFascia =
    fascAvgPerformance != null &&
    fascAvgPerformance > 0 &&
    performanceScore != null
      ? ((performanceScore - fascAvgPerformance) / fascAvgPerformance) * 100
      : null

  const displayName =
    person?.name && String(person.name).trim()
      ? String(person.name).trim()
      : `Dipendente #${key}`
  const gapPct = hayBandAdjustedGapPct(hayBand)

  justifyingPerson.value = {
    key,
    displayName,
    label: `${roleBlock.role} · ${displayName}`,
    seniority: person?.seniority || null,
    seniorityYearsRaw,
    fascAvgSeniorityYears,
    seniorityPctVsFascia,
    performanceScore,
    fascAvgPerformance,
    performancePctVsFascia,
    roleName: roleBlock.role,
    bandNum: band.band,
    levelLabel: band.level,
    fasciaId: hayBand.id,
    fasciaRange: hayBand.label,
    baseSalary: person.baseSalary,
    variableComponents: person.variableComponents,
    totalSalary: person.totalSalary,
    gender: person.gender,
    roleScoresBlock: roleBlock,
    trWeightedScore: roleBlock.trWeightedScore,
    trParametricScore100: roleBlock.trParametricScore100,
    gapFasciaPct: gapPct,
    gapFasciaFormatted:
      gapPct != null ? formatGapMforF(gapPct, hayBandHasJustifications(hayBand)) : '–',
    /** Dati fascia per prompt AI (non confondere con retribuzione del singolo) */
    avgFasciaSalary: hayBand.avgTotalSalary ?? null,
    personDeviationFromFasciaPct: person.deviationFromHayBandMeanPct ?? null,
    avgSalaryMen: hayBand.avgSalaryMen,
    avgSalaryWomen: hayBand.avgSalaryWomen,
    nMenFascia: hayBand.nMen ?? 0,
    nWomenFascia: hayBand.nWomen ?? 0,
    justifySource: 'job_grading',
  }
  resultsTabBeforeJustify.value = resultsTab.value
  resultsTab.value = 'person_justify'
  justifyText.value = personJustifications.value[key] || ''
  nextTick(() => {
    mainWrapRef.value?.scrollTo({ top: 0, behavior: 'smooth' })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  })
}

function canSuggestPersonJustifyAI() {
  return !!justifyingPerson.value
}

async function suggestPersonJustifyAI() {
  if (!justifyingPerson.value || justifyAiLoading.value) return
  justifyAiLoading.value = true
  try {
    const j = justifyingPerson.value
    const suggestion = await suggestJustificationWithGemini({
      role: j.roleName,
      level: j.levelLabel,
      bandId: j.fasciaId,
      bandRangeLabel: j.fasciaRange,
      employeeName: j.displayName,
      gender: j.gender,
      personTotalSalary: j.totalSalary,
      avgFasciaSalary: j.avgFasciaSalary,
      personDeviationFromFasciaPct: j.personDeviationFromFasciaPct,
      genderGapPct: j.gapFasciaPct,
      avgSalaryMen: j.avgSalaryMen,
      avgSalaryWomen: j.avgSalaryWomen,
      nMen: j.nMenFascia,
      nWomen: j.nWomenFascia,
      trParametricScore100: j.trParametricScore100,
      trWeightedScore: j.trWeightedScore,
      seniorityPctVsFascia: j.seniorityPctVsFascia,
      performancePctVsFascia: j.performancePctVsFascia,
    })
    const text = String(suggestion || '').trim()
    if (text) {
      const cur = justifyText.value.trim()
      justifyText.value = cur ? `${cur}\n\n${text}` : text
      await nextTick()
      const box = mainWrapRef.value
      if (box && typeof box.scrollTo === 'function') {
        box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' })
      }
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
    }
  } catch (err) {
    uploadError.value = `Suggerimento AI non riuscito: ${err?.message || String(err)}`
  } finally {
    justifyAiLoading.value = false
  }
}

function formatSeniorityDisplay(s) {
  if (s == null || String(s).trim() === '') return '–'
  return String(s).trim()
}

function formatHayBandAvgMen(sub) {
  return (sub?.nMen ?? 0) > 0 ? formatNum(sub.avgSalaryMen) : '–'
}

function formatHayBandAvgWomen(sub) {
  return (sub?.nWomen ?? 0) > 0 ? formatNum(sub.avgSalaryWomen) : '–'
}

const personJustifyFileInput = ref(null)

function savePersonJustify() {
  if (justifyingPerson.value?.key) {
    const key = justifyingPerson.value.key
    const text = justifyText.value
    if (justifyingPerson.value.justifySource === 'quartile_outlier') {
      const next = { ...quartileOutlierJustifications.value }
      if (String(text || '').trim()) next[key] = text
      else delete next[key]
      quartileOutlierJustifications.value = next
    } else {
      personJustifications.value[key] = text
    }
  }
  const back = resultsTabBeforeJustify.value || 'job_grading'
  justifyingPerson.value = null
  justifyText.value = ''
  if (personJustifyFileInput.value) personJustifyFileInput.value.value = ''
  resultsTab.value = back
}

function cancelPersonJustify() {
  const back = resultsTabBeforeJustify.value || 'job_grading'
  justifyingPerson.value = null
  justifyText.value = ''
  if (personJustifyFileInput.value) personJustifyFileInput.value.value = ''
  resultsTab.value = back
}

const PERSON_JUSTIFY_DOC_INFO_SECTIONS = [
  {
    title: 'Competenze (Hard Skills)',
    body: 'Certificazioni tecniche, titoli di studio specialistici (Master/PhD) e matrici di competenze validate.',
  },
  {
    title: 'Performance (Merito)',
    body: 'Schede di valutazione annuale firmate, report sul raggiungimento dei KPI e storici dei premi MBO.',
  },
  {
    title: 'Esperienza (Seniority)',
    body: 'CV che attestino l\'esperienza pregressa nel ruolo e storico dell\'anzianità aziendale.',
  },
  {
    title: 'Condizioni di Lavoro',
    body: 'Documenti che provino turni notturni, reperibilità h24, trasferte frequenti o responsabilità extra (es. coordinamento progetti).',
  },
  {
    title: 'Mercato (Eccezioni)',
    body: 'Report di benchmarking salariale esterno e log dei processi di selezione che provino la scarsità di profili (difficoltà di reperimento).',
  },
]

function triggerPersonJustifyFile() {
  personJustifyFileInput.value?.click()
}

function onPersonJustifyFilesSelected(ev) {
  const input = ev.target
  const files = input?.files
  if (!files?.length || !justifyingPerson.value?.key) {
    if (input) input.value = ''
    return
  }
  const names = Array.from(files).map((f) => f.name).join(', ')
  const note = `[Documenti allegati: ${names}]`
  const cur = justifyText.value.trim()
  justifyText.value = cur ? `${cur}\n\n${note}` : note
  input.value = ''
}

/** Suggerimenti strutturati per il giustificativo persona (click per inserire nel testo) */
const PERSON_JUSTIFY_SUGGESTION_CATEGORIES = [
  {
    id: 'temporal',
    title: '1. Esperienza e anzianità (criteri temporali)',
    intro: 'Tra i più facili da documentare e i più comuni.',
    highRisk: false,
    items: [
      { label: 'Anzianità di servizio', snippet: 'Anzianità di servizio: anni trascorsi in azienda o nello specifico ruolo, con riferimento a scatti di anzianità o progressioni automatiche documentate.' },
      { label: 'Esperienza pregressa pertinente', snippet: 'Esperienza pregressa pertinente: anni di esperienza in ruoli simili prima dell\'assunzione, che giustificano una RAL di ingresso più elevata.' },
      { label: 'Curva di apprendimento', snippet: 'Curva di apprendimento: differenza tra un neo-assunto e un dipendente che ricopre il ruolo da tempo, fino a quando la produttività non si allinea.' },
    ],
  },
  {
    id: 'skills',
    title: '2. Competenze e formazione (criteri qualitativi)',
    intro: 'Il bagaglio che il dipendente porta nel ruolo.',
    highRisk: false,
    items: [
      { label: 'Istruzione / titoli di studio', snippet: 'Livello di istruzione e titoli di studio: possesso di master, dottorato o lauree specifiche non strettamente obbligatorie ma a valore aggiunto documentabile.' },
      { label: 'Certificazioni tecniche', snippet: 'Certificazioni tecniche: possesso di certificazioni rare o di alto livello (es. certificazioni cloud, legali, linguistiche avanzate).' },
      { label: 'Soft skills certificate', snippet: 'Soft skills certificate: competenze di leadership o negoziazione verificate tramite assessment oggettivi.' },
    ],
  },
  {
    id: 'performance',
    title: '3. Performance e merito (criteri di risultato)',
    intro: 'Richiedono un sistema di valutazione delle prestazioni solido e documentazione.',
    highRisk: false,
    items: [
      { label: 'Raggiungimento KPI', snippet: 'Raggiungimento dei KPI: storico dei risultati individuali documentato (es. superamento target di vendita o obiettivi tecnici).' },
      { label: 'Valutazione del potenziale', snippet: 'Valutazione del potenziale: risultati di assessment interni che identificano il dipendente come high potential.' },
      { label: 'Premi e bonus storici', snippet: 'Premi e bonus storici: componenti variabili una tantum legate a progetti specifici conclusi con successo.' },
    ],
  },
  {
    id: 'conditions',
    title: '4. Caratteristiche del lavoro (criteri di condizione)',
    intro: 'Differenze legate a come e dove si svolge il lavoro.',
    highRisk: false,
    items: [
      { label: 'Turni / notturno', snippet: 'Lavoro a turni o notturno: maggiorazioni legate a orari disagiati o rischiosi, documentate in busta paga / accordi.' },
      { label: 'Trasferta / sede', snippet: 'Indennità di trasferta o sede: differenze legate al costo della vita tra sedi o alla disponibilità costante a viaggiare.' },
      { label: 'Responsabilità aggiuntive', snippet: 'Responsabilità aggiuntive: incarichi temporanei o ad interim che non modificano il grado Hay ma comportano un incremento retributivo documentato.' },
    ],
  },
  {
    id: 'market',
    title: '5. Fattori di mercato (criteri esterni)',
    intro: 'Possono essere sensibili in sede di audit: documentare con evidenze solide.',
    highRisk: false,
    items: [
      { label: 'Scarsità di talenti (shortage)', snippet: '[ALTO RISCHIO AUDIT] Scarsità di talenti sul mercato: difficoltà documentata nel reperire la specifica figura professionale, con evidenze di mercato e processo di recruiting.' },
      { label: 'Retention / controfferta', snippet: '[ALTO RISCHIO AUDIT] Retention: controfferta formulata per evitare dimissioni di dipendente chiave, con documentazione della minaccia competitiva e dell\'approvazione interna.' },
    ],
  },
]

function appendPersonJustifySnippet(snippet) {
  const s = String(snippet || '').trim()
  if (!s) return
  const cur = justifyText.value.trim()
  if (cur.includes(s)) return
  justifyText.value = cur ? `${cur}\n\n• ${s}` : `• ${s}`
}

// Gender gap dashboard
const genderViewMode = ref('media') // 'media' | 'mediana'
const genderNormalizedCache = ref([])
/** Dataset genere dopo esclusione outlier con giustificativo (dashboard, gap, quartili) */
const genderNormalizedForAnalysis = computed(() =>
  genderNormalizedCache.value.filter((r) => !isQuartileAnalysisExcluded(r.index)),
)

const bandGenderGaps = computed(() =>
  computeBandGenderGaps(genderNormalizedForAnalysis.value, jobResults.value),
)
const adjustedGapResult = computed(() =>
  computeAdjustedGap(genderNormalizedForAnalysis.value, 5),
)

const bandGenderJustifications = ref({})
const expandedJustifyBand = ref(null)

const euDashboard = computed(() =>
  computeEuGenderDashboard(
    genderNormalizedForAnalysis.value,
    jobResults.value,
    euDashboardSalaryMode.value,
  ),
)

const quartileOutlierRows = computed(() =>
  computeQuartileOutliers(genderNormalizedForAnalysis.value, euDashboardSalaryMode.value),
)

const quartileExcludedEntries = computed(() => {
  const cache = genderNormalizedCache.value
  const out = []
  for (const [key, text] of Object.entries(quartileOutlierJustifications.value)) {
    const note = String(text || '').trim()
    if (!note) continue
    const idx = Number(key)
    const person = cache.find((r) => r.index === idx)
    if (person) out.push({ ...person, note })
  }
  return out.sort((a, b) => a.index - b.index)
})

function findJobGradingContextByIndex(index) {
  for (const b of jobResults.value || []) {
    for (const sub of b.hayBands || []) {
      for (const rb of sub.roles || []) {
        const p = (rb.people || []).find((pp) => pp.index === index)
        if (p) {
          return { band: b, hayBand: sub, roleBlock: rb, person: p }
        }
      }
    }
  }
  return null
}

function openQuartileOutlierJustifyTab(row) {
  if (!row) return
  const key = String(row.index)
  const ctx = findJobGradingContextByIndex(row.index)

  if (ctx) {
    openPersonJustify(ctx.person, ctx.roleBlock, ctx.band, ctx.hayBand)
  } else {
    justifyingPerson.value = {
      key,
      displayName: row.name && String(row.name).trim() ? String(row.name).trim() : `Dipendente #${key}`,
      label: `Outlier quartile · #${key}`,
      seniority: null,
      seniorityYearsRaw: null,
      fascAvgSeniorityYears: null,
      seniorityPctVsFascia: null,
      performanceScore: mockPerformanceScoreForPerson(row.index),
      fascAvgPerformance: null,
      performancePctVsFascia: null,
      roleName: row.role || 'N/D',
      bandNum: '–',
      levelLabel: row.level || 'N/D',
      fasciaId: `Q${row.quartile}`,
      fasciaRange: row.reason || 'Outlier quartile',
      baseSalary: null,
      variableComponents: null,
      totalSalary: row.salary,
      gender: row.gender,
      roleScoresBlock: null,
      trWeightedScore: null,
      trParametricScore100: null,
      gapFasciaPct: null,
      gapFasciaFormatted: '–',
      avgFasciaSalary: null,
      personDeviationFromFasciaPct: null,
      avgSalaryMen: null,
      avgSalaryWomen: null,
      nMenFascia: 0,
      nWomenFascia: 0,
      justifySource: 'quartile_outlier',
    }
    resultsTabBeforeJustify.value = resultsTab.value
    resultsTab.value = 'person_justify'
    nextTick(() => {
      mainWrapRef.value?.scrollTo({ top: 0, behavior: 'smooth' })
      window.scrollTo({ top: 0, behavior: 'smooth' })
    })
  }

  justifyText.value = quartileOutlierJustifications.value[key] || ''
  if (justifyingPerson.value) {
    justifyingPerson.value.justifySource = 'quartile_outlier'
  }
}

function clearQuartileOutlierExclusion(index) {
  const next = { ...quartileOutlierJustifications.value }
  delete next[String(index)]
  quartileOutlierJustifications.value = next
}

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
  // loadRules() — da ripristinare se si riattiva la sezione Revisione salariale
  geminiApiUnreachable.value = false
  try {
    const res = await fetch('/api/gemini/status')
    if (!res.ok) {
      geminiApiUnreachable.value = true
      geminiEnabled.value = false
    } else {
      const data = await res.json()
      geminiEnabled.value = !!data.geminiEnabled
    }
  } catch {
    geminiApiUnreachable.value = true
    geminiEnabled.value = false
  }
})

function bandJustifyReasonLabelsForPdf(reasonIds) {
  if (!reasonIds?.length) return ''
  return reasonIds.map((id) => BAND_JUSTIFY_REASONS.find((r) => r.id === id)?.label || id).join('; ')
}

/** Righe per PDF: giustificativi dipendenti salvati in job grading */
function buildPdfJobGradingPersonRows() {
  const notes = personJustifications.value || {}
  const rows = []
  const seen = new Set()
  for (const b of jobResults.value || []) {
    for (const sub of b.hayBands || []) {
      for (const rb of sub.roles || []) {
        for (const p of rb.people || []) {
          const key = String(p.index)
          const text = notes[key]
          if (typeof text !== 'string' || !text.trim()) continue
          seen.add(key)
          rows.push({
            livello: b.level || '–',
            fascia: sub.label || '–',
            ruolo: rb.role || '–',
            index: p.index,
            nome: (p.name && String(p.name).trim()) || `Dip. #${key}`,
            genere: p.gender === 'M' ? 'M' : p.gender === 'F' ? 'F' : '–',
            testo: text.trim().replace(/\r\n/g, '\n').replace(/\n/g, ' '),
          })
        }
      }
    }
  }
  for (const [key, text] of Object.entries(notes)) {
    if (seen.has(key)) continue
    const t = String(text || '').trim()
    if (!t) continue
    rows.push({
      livello: '–',
      fascia: '–',
      ruolo: '–',
      index: key,
      nome: '–',
      genere: '–',
      testo: t.replace(/\r\n/g, '\n').replace(/\n/g, ' '),
    })
  }
  return rows.sort((a, b) => {
    const na = Number(a.index)
    const nb = Number(b.index)
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
    return String(a.index).localeCompare(String(b.index))
  })
}

function buildPdfQuartileJustificationRows() {
  const rows = []
  const cache = genderNormalizedCache.value || []
  for (const [key, text] of Object.entries(quartileOutlierJustifications.value || {})) {
    const t = String(text || '').trim()
    if (!t) continue
    const idx = Number(key)
    const person = cache.find((r) => r.index === idx)
    rows.push({
      index: key,
      nome: person?.name != null && String(person.name).trim() ? String(person.name).trim() : '–',
      genere: person?.gender === 'M' ? 'M' : person?.gender === 'F' ? 'F' : '–',
      livello: person?.level != null ? String(person.level) : '–',
      ruolo: person?.role != null ? String(person.role) : '–',
      testo: t.replace(/\r\n/g, '\n').replace(/\n/g, ' '),
    })
  }
  return rows.sort((a, b) => Number(a.index) - Number(b.index))
}

function buildPdfBandGenderRows() {
  const map = bandGenderJustifications.value || {}
  const rows = []
  for (const [band, j] of Object.entries(map)) {
    if (!j) continue
    const hasReasons = (j.reasons || []).length > 0
    const note = String(j.note || '').trim()
    const fileNames = (j.files || []).map((f) => f.name).filter(Boolean).join(', ')
    if (!hasReasons && !note && !fileNames) continue
    const reasonStr = bandJustifyReasonLabelsForPdf(j.reasons || [])
    const parts = [reasonStr, note, fileNames].filter(Boolean)
    rows.push({
      band: String(band),
      contenuto: parts.join(' | '),
    })
  }
  return rows.sort((a, b) => a.band.localeCompare(b.band))
}

function buildPdfLevelJustificationRows() {
  const rows = []
  for (const [level, text] of Object.entries(justifications.value || {})) {
    const t = String(text || '').trim()
    if (!t) continue
    rows.push({
      livello: String(level),
      testo: t.replace(/\r\n/g, '\n').replace(/\n/g, ' '),
    })
  }
  return rows.sort((a, b) => a.livello.localeCompare(b.livello))
}

// PDF export job grading
function exportJobGradingPdf() {
  try {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
    const pageWidth = doc.internal.pageSize.getWidth()
    let y = 18

    doc.setFontSize(16)
    doc.setFont('helvetica', 'bold')
    doc.text('Valutazione dei Lavori di Pari Valore - Job Grading', pageWidth / 2, y, { align: 'center' })
    y += 8
    doc.setFontSize(9)
    doc.setFont('helvetica', 'normal')
    doc.text(`Data: ${new Date().toLocaleDateString('it-IT')}`, pageWidth / 2, y, { align: 'center' })
    y += 10

    doc.setFontSize(11)
    doc.setFont('helvetica', 'bold')
    doc.text('Riepilogo fasce', 14, y)
    y += 6

    const head = [['Livello', 'CCNL', 'Fascia', 'N U', 'N D', 'N Ruoli', 'Gap', 'Med. M', 'Med. F']]
    const body = jobResults.value.flatMap((b) =>
      (b.hayBands || []).map((sub) => {
        const gap = hayBandAdjustedGapPct(sub)
        const gapLabel = gap == null
          ? 'n/d'
          : formatGapMforF(gap, hayBandHasJustifications(sub))
        return [
          b.band,
          b.level || '-',
          sub.label,
          sub.nMen ?? 0,
          sub.nWomen ?? 0,
          sub.nRoles ?? 0,
          gapLabel,
          formatHayBandAvgMen(sub),
          formatHayBandAvgWomen(sub),
        ]
      }),
    )

    autoTable(doc, {
      startY: y,
      head,
      body,
      theme: 'grid',
      headStyles: { fillColor: [10, 108, 210], fontSize: 7.5, halign: 'center' },
      bodyStyles: { fontSize: 7.5 },
      columnStyles: {
        0: { halign: 'center', cellWidth: 12 },
        1: { halign: 'center', cellWidth: 18 },
        2: { halign: 'center', cellWidth: 20 },
        3: { halign: 'center', cellWidth: 12 },
        4: { halign: 'center', cellWidth: 12 },
        5: { halign: 'center', cellWidth: 14 },
        6: { halign: 'center', cellWidth: 18 },
        7: { halign: 'right', cellWidth: 22 },
        8: { halign: 'right', cellWidth: 22 },
      },
      margin: { left: 14, right: 14 },
    })

    let nextY = doc.lastAutoTable?.finalY != null ? doc.lastAutoTable.finalY + 12 : y + 60

    const jgRows = buildPdfJobGradingPersonRows()
    const qRows = buildPdfQuartileJustificationRows()
    const bandRows = buildPdfBandGenderRows()
    const levRows = buildPdfLevelJustificationRows()
    const anyJustify = jgRows.length + qRows.length + bandRows.length + levRows.length > 0

    const tableOptsText = {
      theme: 'grid',
      headStyles: { fillColor: [10, 108, 210], fontSize: 7, halign: 'center' },
      bodyStyles: { fontSize: 6.5, overflow: 'linebreak' },
      margin: { left: 14, right: 14 },
    }

    const newPageIfNeeded = (start) => {
      if (start > 155) {
        doc.addPage()
        return 16
      }
      return start
    }

    // ---- Dashboard UE (dati principali) ----
    const dash = euDashboard.value || {}
    nextY = newPageIfNeeded(nextY)
    doc.setFontSize(11)
    doc.setFont('helvetica', 'bold')
    doc.text('Dashboard trasparenza genere (UE) — Dati', 14, nextY)
    nextY += 6

    autoTable(doc, {
      ...tableOptsText,
      startY: nextY,
      head: [[
        'Modalità',
        'Gap medio',
        'Gap mediano',
        '% fasce > 5%',
        'Fasce > 5%',
        'Fasce confrontabili',
        'Budget stima',
        'N M',
        'N F',
        'N analizzati',
      ]],
      body: [[
        euDashboardSalaryMode.value === 'base' ? 'Retrib. base' : 'Retrib. totale',
        formatPct(dash.gapMean),
        formatPct(dash.gapMedian),
        formatPct(dash.pctFasceSopraSoglia),
        dash.bandsAboveThreshold ?? 0,
        dash.bandsComparable ?? 0,
        formatNum(dash.budgetEstimate),
        dash.nMaschi ?? 0,
        dash.nFemmine ?? 0,
        dash.nTotaleAnalizzati ?? 0,
      ]],
      columnStyles: {
        0: { cellWidth: 24 },
        1: { cellWidth: 18, halign: 'right' },
        2: { cellWidth: 18, halign: 'right' },
        3: { cellWidth: 18, halign: 'right' },
        4: { cellWidth: 16, halign: 'center' },
        5: { cellWidth: 22, halign: 'center' },
        6: { cellWidth: 22, halign: 'right' },
        7: { cellWidth: 12, halign: 'center' },
        8: { cellWidth: 12, halign: 'center' },
        9: { cellWidth: 16, halign: 'center' },
      },
    })
    nextY = doc.lastAutoTable.finalY + 8

    const quartRows = (dash.quartiles || []).map((q) => [
      `Q${q.quartile}`,
      q.totale ?? 0,
      q.maschile ?? 0,
      q.femminile ?? 0,
      formatPct(q.maschilePct),
      formatPct(q.femminilePct),
    ])
    if (quartRows.length) {
      nextY = newPageIfNeeded(nextY)
      doc.setFontSize(10)
      doc.setFont('helvetica', 'bold')
      doc.text('Distribuzione per quartili', 14, nextY)
      nextY += 5
      autoTable(doc, {
        ...tableOptsText,
        startY: nextY,
        head: [['Quartile', 'Totale', 'M', 'F', '% M', '% F']],
        body: quartRows,
        columnStyles: {
          0: { cellWidth: 18, halign: 'center' },
          1: { cellWidth: 18, halign: 'center' },
          2: { cellWidth: 12, halign: 'center' },
          3: { cellWidth: 12, halign: 'center' },
          4: { cellWidth: 14, halign: 'right' },
          5: { cellWidth: 14, halign: 'right' },
        },
      })
      nextY = doc.lastAutoTable.finalY + 8
    }

    const levelRowsPdf = (dash.levelRows || []).map((r) => [
      r.band ?? '–',
      r.levelLabel ?? '–',
      r.nM ?? 0,
      r.nF ?? 0,
      r.gap == null ? 'n/d' : formatPct(r.gap),
    ])
    if (levelRowsPdf.length) {
      nextY = newPageIfNeeded(nextY)
      doc.setFontSize(10)
      doc.setFont('helvetica', 'bold')
      doc.text('Gap per livello CCNL', 14, nextY)
      nextY += 5
      autoTable(doc, {
        ...tableOptsText,
        startY: nextY,
        head: [['Band', 'Livello', 'N M', 'N F', 'Gap']],
        body: levelRowsPdf,
        columnStyles: {
          0: { cellWidth: 12, halign: 'center' },
          1: { cellWidth: 26 },
          2: { cellWidth: 12, halign: 'center' },
          3: { cellWidth: 12, halign: 'center' },
          4: { cellWidth: 16, halign: 'right' },
        },
      })
      nextY = doc.lastAutoTable.finalY + 8
    }

    const fasciaRowsPdf = (dash.fasciaRows || []).map((r) => [
      r.levelLabel ?? '–',
      r.fasciaId ?? '–',
      r.fasciaLabel ?? '–',
      r.nM ?? 0,
      r.nF ?? 0,
      r.gap == null ? 'n/d' : formatPct(r.gap),
    ])
    if (fasciaRowsPdf.length) {
      nextY = newPageIfNeeded(nextY)
      doc.setFontSize(10)
      doc.setFont('helvetica', 'bold')
      doc.text('Gap per fascia / cluster', 14, nextY)
      nextY += 5
      autoTable(doc, {
        ...tableOptsText,
        startY: nextY,
        head: [['Livello', 'Fascia', 'Range', 'N M', 'N F', 'Gap']],
        body: fasciaRowsPdf,
        columnStyles: {
          0: { cellWidth: 22 },
          1: { cellWidth: 16, halign: 'center' },
          2: { cellWidth: 24 },
          3: { cellWidth: 12, halign: 'center' },
          4: { cellWidth: 12, halign: 'center' },
          5: { cellWidth: 16, halign: 'right' },
        },
      })
      nextY = doc.lastAutoTable.finalY + 8
    }

    if (jgRows.length) {
      nextY = newPageIfNeeded(nextY)
      doc.setFontSize(11)
      doc.setFont('helvetica', 'bold')
      doc.text('Giustificativi dipendenti (job grading)', 14, nextY)
      nextY += 6
      autoTable(doc, {
        ...tableOptsText,
        startY: nextY,
        head: [['Livello CCNL', 'Fascia', 'Ruolo', '#', 'Nome', 'Genere', 'Testo giustificativo']],
        body: jgRows.map((r) => [r.livello, r.fascia, r.ruolo, String(r.index), r.nome, r.genere, r.testo]),
        columnStyles: {
          0: { cellWidth: 22 },
          1: { cellWidth: 26 },
          2: { cellWidth: 28 },
          3: { cellWidth: 10, halign: 'center' },
          4: { cellWidth: 28 },
          5: { cellWidth: 12, halign: 'center' },
          6: { cellWidth: 'auto' },
        },
      })
      nextY = doc.lastAutoTable.finalY + 12
    }

    if (qRows.length) {
      nextY = newPageIfNeeded(nextY)
      doc.setFontSize(11)
      doc.setFont('helvetica', 'bold')
      doc.text('Giustificativi outlier quartile (dashboard UE)', 14, nextY)
      nextY += 6
      autoTable(doc, {
        ...tableOptsText,
        startY: nextY,
        head: [['#', 'Nome', 'Genere', 'Livello', 'Ruolo', 'Testo giustificativo']],
        body: qRows.map((r) => [r.index, r.nome, r.genere, r.livello, r.ruolo, r.testo]),
        columnStyles: {
          0: { cellWidth: 10, halign: 'center' },
          1: { cellWidth: 32 },
          2: { cellWidth: 12, halign: 'center' },
          3: { cellWidth: 22 },
          4: { cellWidth: 32 },
          5: { cellWidth: 'auto' },
        },
      })
      nextY = doc.lastAutoTable.finalY + 12
    }

    if (bandRows.length) {
      nextY = newPageIfNeeded(nextY)
      doc.setFontSize(11)
      doc.setFont('helvetica', 'bold')
      doc.text('Giustificativi gap per livello (dashboard UE)', 14, nextY)
      nextY += 6
      autoTable(doc, {
        ...tableOptsText,
        startY: nextY,
        head: [['Livello / banda', 'Motivi, note e allegati (nomi file)']],
        body: bandRows.map((r) => [r.band, r.contenuto]),
        columnStyles: {
          0: { cellWidth: 35 },
          1: { cellWidth: 'auto' },
        },
      })
      nextY = doc.lastAutoTable.finalY + 12
    }

    if (levRows.length) {
      nextY = newPageIfNeeded(nextY)
      doc.setFontSize(11)
      doc.setFont('helvetica', 'bold')
      doc.text('Giustificativi per livello CCNL (modale)', 14, nextY)
      nextY += 6
      autoTable(doc, {
        ...tableOptsText,
        startY: nextY,
        head: [['Livello', 'Testo giustificativo']],
        body: levRows.map((r) => [r.livello, r.testo]),
        columnStyles: {
          0: { cellWidth: 35 },
          1: { cellWidth: 'auto' },
        },
      })
      nextY = doc.lastAutoTable.finalY + 12
    }

    if (!anyJustify) {
      nextY = newPageIfNeeded(nextY)
      doc.setFontSize(9)
      doc.setFont('helvetica', 'italic')
      doc.setTextColor(100, 100, 100)
      doc.text('Nessun giustificativo testuale registrato nell’analisi corrente.', 14, nextY)
      doc.setTextColor(0, 0, 0)
    }

    doc.save('job-grading-report.pdf')
  } catch (err) {
    uploadError.value = 'Esportazione PDF non riuscita: ' + (err?.message || String(err))
  }
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
          @click="activeSection = s.id; if (s.id === 'analisi' && analisiStep === 'idle') analisiStep = 'upload'; if (s.id === 'storico') loadStorico()"
        >
          <span class="tab-icon">
            <svg v-if="s.icon === 'table'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18"/></svg>
            <svg v-else-if="s.icon === 'history'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </span>
          <span class="tab-label">{{ s.label }}</span>
        </button>
      </nav>
    </header>

    <div ref="mainWrapRef" class="main-wrap">
    <header class="main-header">
      <button class="btn-primary" @click="startNuovaAnalisi">
        <span>NUOVA ANALISI</span>
      </button>
    </header>

    <!-- Flusso unificato: Upload → Mapping → Risultati -->
    <template v-if="showAnalisiFlow">
      <!-- Step 1: Link Excel -->
      <div v-if="analisiStep === 'upload'" class="analisi-content">
        <h2 class="analisi-title">Collegamento al file Excel</h2>
        <p class="analisi-desc">Incolla il link a un file Excel (.xlsx) in cloud. L'app mapperà automaticamente le colonne per la valutazione dei lavori di pari valore (job grading).</p>
        <div class="url-input-wrap">
          <input v-model="excelUrl" type="url" class="url-input" placeholder="https://... file.xlsx" :disabled="uploadLoading || geminiLoading" @keydown.enter="onLoadFromUrl" />
          <button type="button" class="btn-primary" :disabled="uploadLoading || geminiLoading || !excelUrl.trim()" @click="onLoadFromUrl">
            <span v-if="uploadLoading">Scaricamento…</span>
            <span v-else-if="geminiLoading">Riconoscimento colonne…</span>
            <span v-else>Carica e mappa colonne</span>
          </button>
        </div>
        <p class="api-key-warn">
          Stato Gemini: <strong>{{ geminiEnabled ? 'attivo' : 'non attivo' }}</strong>
          <span v-if="geminiApiUnreachable" class="muted"> (API non raggiungibile in questo ambiente)</span>
        </p>
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
          <p class="settings-hint">Il job grading raggruppa i dipendenti per livello di inquadramento CCNL. Ogni livello viene analizzato con retribuzione media e deviazione.</p>
        </div>

        <p v-if="geminiInfoNotice" class="upload-info">{{ geminiInfoNotice }}</p>
        <p v-if="uploadError" class="upload-error">{{ uploadError }}</p>
        <div class="mapping-actions">
          <button class="btn-secondary" :disabled="analysisLoading" @click="goToUpload">Indietro</button>
          <button class="btn-primary" :disabled="analysisLoading" @click="confirmMapping">
            <span v-if="analysisLoading">Generazione analisi...</span>
            <span v-else>Esegui analisi</span>
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

        <div class="results-subtabs eu-results-tabs">
          <button
            type="button"
            class="subtab"
            :class="{ active: resultsTab === 'eu_dashboard' }"
            @click="resultsTab = 'eu_dashboard'"
          >
            Dashboard trasparenza genere (UE)
          </button>
          <button
            type="button"
            class="subtab"
            :class="{ active: resultsTab === 'job_grading' }"
            :disabled="jobResults.length === 0"
            @click="resultsTab = 'job_grading'"
          >
            Lavori di pari valore
          </button>
          <button
            v-if="justifyingPerson != null"
            type="button"
            class="subtab"
            :class="{ active: resultsTab === 'person_justify' }"
            @click="resultsTab = 'person_justify'"
          >
            Giustificativo
          </button>
        </div>

        <!-- Global Gender Pay Transparency Dashboard — Direttiva UE 2023/970 -->
        <div v-show="resultsTab === 'eu_dashboard'" class="eu-dashboard-wrap">
          <div v-if="genderNormalizedCache.length === 0" class="no-data-msg">
            Per la <strong>Global Gender Pay Transparency Dashboard</strong> (Direttiva UE 2023/970) è necessario mappare la colonna <strong>Genere</strong> e avere dipendenti con valori M/F nel file.
          </div>
          <template v-else>
            <div class="eu-dash-header">
              <h3 class="eu-dash-title">Global Gender Pay Transparency Dashboard</h3>
              <p class="eu-dash-sub">
                Trasparenza retributiva di genere — riferimento <strong>Direttiva UE 2023/970</strong>.
              </p>
              <div class="eu-salary-toggle">
                <span class="eu-salary-toggle-label">Calcolo gap su:</span>
                <button type="button" :class="['toggle-btn', { active: euDashboardSalaryMode === 'base' }]" @click="euDashboardSalaryMode = 'base'">Retribuzione base</button>
                <button type="button" :class="['toggle-btn', { active: euDashboardSalaryMode === 'total' }]" @click="euDashboardSalaryMode = 'total'">Retribuzione totale</button>
              </div>
            </div>
            <p class="eu-legend-line">
              <span class="eu-leg eu-leg-green">■</span> |gap| &lt; 4% &nbsp;
              <span class="eu-leg eu-leg-yellow">■</span> 4%–5% &nbsp;
              <span class="eu-leg eu-leg-red">■</span> &gt; 5% (oltre soglia indicativa)
            </p>

            <div class="eu-kpi-grid">
              <div class="eu-kpi-card">
                <div class="eu-kpi-label">Gender pay gap medio (azienda)</div>
                <div class="eu-kpi-value" :class="euGapSeverityClass(euDashboard.gapMean)">{{ formatGapMforF(euDashboard.gapMean) }}</div>
              </div>
              <div class="eu-kpi-card">
                <div class="eu-kpi-label">Gender pay gap mediano (azienda)</div>
                <div class="eu-kpi-value" :class="euGapSeverityClass(euDashboard.gapMedian)">{{ formatGapMforF(euDashboard.gapMedian) }}</div>
              </div>
              <div class="eu-kpi-card eu-kpi-span">
                <div class="eu-kpi-label">Dipendenti analizzati</div>
                <div class="eu-kpi-value-inline">
                  <strong>Uomini:</strong> {{ euDashboard.nMaschi }}
                  &nbsp;·&nbsp;
                  <strong>Donne:</strong> {{ euDashboard.nFemmine }}
                  &nbsp;·&nbsp;
                  <span class="muted">Totale M/F: {{ euDashboard.nTotaleAnalizzati }}</span>
                </div>
              </div>
            </div>

            <div class="eu-charts-row">
              <div class="eu-panel">
                <h4 class="eu-panel-title">Quartili retributivi</h4>
                <p class="eu-panel-desc">Quattro gruppi uguali (dal 25% più basso al 25% più alto). Percentuali di uomini e donne <em>all’interno</em> di ciascun quartile.</p>
                <div class="eu-quartile-chart">
                  <div v-for="q in euDashboard.quartiles" :key="q.quartile" class="eu-quartile-col">
                    <div class="eu-q-label">Q{{ q.quartile }}</div>
                    <div class="eu-q-pair">
                      <div class="eu-q-bar-col">
                        <div class="eu-q-bar-bg">
                          <div class="eu-q-bar eu-q-bar-m" :style="{ height: (q.totale ? q.maschilePct : 0) + '%' }"></div>
                        </div>
                        <span class="eu-q-pct">M {{ (q.totale ? q.maschilePct : 0).toFixed(0) }}%</span>
                      </div>
                      <div class="eu-q-bar-col">
                        <div class="eu-q-bar-bg">
                          <div class="eu-q-bar eu-q-bar-f" :style="{ height: (q.totale ? q.femminilePct : 0) + '%' }"></div>
                        </div>
                        <span class="eu-q-pct">F {{ (q.totale ? q.femminilePct : 0).toFixed(0) }}%</span>
                      </div>
                    </div>
                    <div class="eu-q-meta">n = {{ q.totale }}</div>
                  </div>
                </div>
              </div>

              <div class="eu-panel">
                <h4 class="eu-panel-title">Gap medio per livello CCNL</h4>
                <p class="eu-panel-desc">Confronto media M vs F per livello ({{ euDashboardSalaryMode === 'base' ? 'retribuzione base' : 'retribuzione totale' }}).</p>
                <div class="eu-level-list">
                  <div v-for="row in euDashboard.levelRows" :key="'lv-' + row.band + '-' + row.levelLabel" class="eu-level-row">
                    <div class="eu-level-head">
                      <span class="eu-level-name">{{ row.levelLabel }}</span>
                      <span class="eu-level-gap" :class="euGapSeverityClass(row.gap)">{{ row.gap == null ? 'n/d' : formatGapMforF(row.gap) }}</span>
                    </div>
                    <div v-if="row.gap != null" class="eu-level-track">
                      <div
                        class="eu-level-fill"
                        :class="euGapSeverityClass(row.gap)"
                        :style="{ width: Math.min(100, Math.abs(row.gap) * 1.5) + '%' }"
                      ></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="eu-panel eu-outlier-panel">
              <h4 class="eu-panel-title">Outlier per quartile (IQR)</h4>
              <p class="eu-panel-desc">
                Regola a scatola (IQR × 1,5) <strong>all’interno di ciascun quartile</strong> sulla
                {{ euDashboardSalaryMode === 'base' ? 'retribuzione base' : 'retribuzione totale' }}.
                Con un giustificativo testuale il dipendente viene <strong>escluso dall’analisi</strong> (KPI, quartili, gap per livello, fasce job grading).
              </p>
              <div v-if="quartileOutlierRows.length === 0" class="muted">
                Nessun outlier rilevato (o dati insufficienti: servono almeno 8 persone con retribuzione valida).
              </div>
              <div v-else class="eu-outlier-table-wrap">
                <table class="eu-outlier-table">
                  <thead>
                    <tr>
                      <th>Q</th>
                      <th>Nome</th>
                      <th>Genere</th>
                      <th class="eu-outlier-num">{{ euDashboardSalaryMode === 'base' ? 'Base' : 'Totale' }}</th>
                      <th>Motivo</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in quartileOutlierRows" :key="'o-' + row.index">
                      <td>Q{{ row.quartile }}</td>
                      <td>{{ row.name || '—' }}</td>
                      <td><span :class="personGenderClass(row.gender)">{{ row.gender }}</span></td>
                      <td class="eu-outlier-num">{{ formatNum(row.salary) }}</td>
                      <td class="eu-outlier-reason">{{ row.reason }}</td>
                      <td>
                        <button type="button" class="btn-eu-outlier" @click="openQuartileOutlierJustifyTab(row)">Giustificativo</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div v-if="quartileExcludedEntries.length" class="eu-outlier-excluded">
                <h5 class="eu-outlier-excluded-title">Esclusi dall’analisi</h5>
                <ul class="eu-outlier-excluded-list">
                  <li v-for="ex in quartileExcludedEntries" :key="'ex-' + ex.index" class="eu-outlier-excluded-item">
                    <div class="eu-outlier-ex-main">
                      <span class="eu-outlier-ex-name">{{ ex.name || '—' }}</span>
                      <span class="muted">#{{ ex.index }}</span>
                    </div>
                    <p class="eu-outlier-ex-note">{{ ex.note }}</p>
                    <button type="button" class="btn-eu-outlier btn-eu-outlier-ghost" @click="clearQuartileOutlierExclusion(ex.index)">Ripristina in analisi</button>
                  </li>
                </ul>
              </div>
            </div>

            <div class="eu-panel eu-alert-panel">
              <h4 class="eu-panel-title">Top 3 criticità (fasce / cluster)</h4>
              <ul v-if="euDashboard.criticalAlerts.length" class="eu-alert-list">
                <li v-for="(a, idx) in euDashboard.criticalAlerts" :key="idx" class="eu-alert-item">
                  <strong>{{ a.levelLabel }}</strong>, <strong>{{ a.fasciaId }}</strong> (range {{ a.fasciaLabel }}):
                  <span class="gap-alert">{{ formatGapMforF(a.gap) }}</span>
                </li>
              </ul>
              <p v-else class="muted">Nessuna fascia con |gap| &gt; 5% tra quelle confrontabili, oppure dati insufficienti.</p>
            </div>

          </template>
        </div>

        <div v-show="resultsTab === 'job_grading'">
          <template v-if="jobResults.length > 0">
          <div
            class="job-grading-gap-alert"
            :class="{ 'job-grading-gap-alert--ok': jobGradingGapsToFixCount === 0 }"
            role="status"
          >
            <span class="job-grading-gap-alert__icon" aria-hidden="true">
              <svg v-if="jobGradingGapsToFixCount > 0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="22" height="22"><path d="M12 3l10 18H2L12 3z"/><path d="M12 9v5"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/></svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="22" height="22"><path d="M20 6L9 17l-5-5"/></svg>
            </span>
            <div class="job-grading-gap-alert__body">
              <strong class="job-grading-gap-alert__count">{{ jobGradingGapsToFixCount }}</strong>
              <span class="job-grading-gap-alert__label">Gap da correggere</span>
              <span class="job-grading-gap-alert__hint">(fasce con disparità M/F oltre il 5%)</span>
            </div>
          </div>
          <div class="job-grading-tab-head">
            <p class="result-source job-grading-tab-head__text">Raggruppamento per <strong>Livello CCNL</strong> · voto 1–5 per fattore; <strong>punteggio parametrico 0–100</strong> = Σ (% peso × voto / 5)</p>
            <button type="button" class="btn-jg-criteria" @click="jobGradingCriteriaModalOpen = true">Info analisi</button>
          </div>

          <div v-for="band in jobResults" :key="band.band" class="band-section">
            <h3 class="band-title">{{ band.level }}</h3>
            <div class="band-summary">
              <span>Media retrib.: <strong>{{ formatNum(band.avgTotalSalary) }}</strong></span>
              <span>Media RAL: <strong>{{ formatNum(band.avgBaseSalary) }}</strong></span>
            </div>
            <div class="job-table" v-if="band.hayBands && band.hayBands.length">
              <div class="job-row header hay-row">
                <span>Fascia</span><span title="Fascia di punteggio parametrico (scala /100)">Range /100</span><span>N uomini</span><span>N donne</span><span>N ruoli</span><span>Media retrib. M</span><span>Media retrib. F</span>
              </div>
              <template v-for="sub in band.hayBands" :key="`${band.level}-${sub.label}`">
                <div
                  class="job-row hay-row clickable"
                  @click="toggleHayBand(band.level, sub.label, sub)"
                >
                  <span class="hay-band-label">
                    <strong>{{ isHayBandExpanded(band.level, sub.label) ? '▾' : '▸' }} {{ sub.id }}</strong>
                    <svg
                      v-if="hasHayBandDisparity(sub)"
                      class="hay-band-alert-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      width="14"
                      height="14"
                      title="Presenza di disparita retributive nella fascia"
                    >
                      <path d="M12 3l10 18H2L12 3z" />
                      <path d="M12 9v5" />
                      <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none" />
                    </svg>
                  </span>
                  <span>
                    {{ sub.label }}
                    <span v-if="hayBandAdjustedGapPct(sub) != null" class="hay-band-gap-pill" :class="{ 'gap-alert': hasHayBandDisparity(sub) }">
                      {{ formatGapMforF(hayBandAdjustedGapPct(sub), hayBandHasJustifications(sub)) }}
                    </span>
                  </span>
                  <span>{{ sub.nMen ?? 0 }}</span>
                  <span>{{ sub.nWomen ?? 0 }}</span>
                  <span>{{ sub.nRoles }}</span>
                  <span>{{ formatHayBandAvgMen(sub) }}</span>
                  <span>{{ formatHayBandAvgWomen(sub) }}</span>
                </div>
                <div
                  v-if="isHayBandExpanded(band.level, sub.label)"
                  class="people-detail hay-fascia-detail"
                >
                  <div class="people-header hay-role-header jg-tr-score-grid">
                    <span><svg class="inline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M3 7h18"/><path d="M6 7V5a2 2 0 012-2h8a2 2 0 012 2v2"/><rect x="3" y="7" width="18" height="13" rx="2"/></svg> Ruolo</span>
                    <span
                      v-for="area in TRANSPARENCY_MACRO_AREAS"
                      :key="'h-' + area.id"
                      class="jg-tr-col-head jg-tr-col-area"
                      :title="area.label + ' — punti parametrici (0–100) nell’area; peso area sul totale: ' + area.weightPct + '%'"
                    >{{ area.label }}</span>
                    <span class="jg-tr-col-head jg-tr-col-head-punteggio" title="Punteggio parametrico 0–100: Σ (% peso × voto 1–5 / 5) su tutti i fattori">Punteggio</span>
                    <span class="jg-tr-col-head jg-tr-col-head-detail" title="Apri la scheda con macro-aree, fattori e punteggi 1–5">Dettaglio</span>
                    <span>N</span>
                    <span>Media retrib.</span>
                  </div>
                  <template v-for="rb in sub.roles" :key="`${band.level}-${sub.label}-${rb.role}`">
                    <div
                      class="people-row hay-role-row jg-tr-score-grid clickable"
                      @click="toggleRoleDetail(band.level, sub.label, rb.role)"
                    >
                      <span class="role-cell-main">
                        <span><svg class="inline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M3 7h18"/><path d="M6 7V5a2 2 0 012-2h8a2 2 0 012 2v2"/><rect x="3" y="7" width="18" height="13" rx="2"/></svg>{{ isRoleDetailExpanded(band.level, sub.label, rb.role) ? '▾' : '▸' }} {{ rb.role }}</span>
                      </span>
                      <span
                        v-for="area in TRANSPARENCY_MACRO_AREAS"
                        :key="rb.role + area.id"
                        class="jg-tr-score-cell"
                        :title="macroAreaParametricTooltip(rb, area)"
                      >{{ formatMacroAreaScore(rb, area) }}</span>
                      <span class="jg-tr-score-cell jg-tr-p jg-tr-p-100">
                        <template v-if="rb.trParametricScore100 != null">
                          {{ formatNum(rb.trParametricScore100) }}<span class="muted jg-tr-p100-suffix">/100</span>
                        </template>
                        <template v-else>–</template>
                      </span>
                      <span class="jg-tr-detail-cell">
                        <button
                          type="button"
                          class="btn-jg-role-valuation"
                          title="Apri la tabella con macro-aree, fattori e punteggi"
                          @click.stop="openRoleValuationModal(band.level, sub.label, rb.role)"
                        >
                          Dettaglio valutazione
                        </button>
                      </span>
                      <span>{{ rb.n }}</span>
                      <span>{{ formatNum(rb.avgTotalSalary) }}</span>
                    </div>
                    <div
                      v-if="isRoleDetailExpanded(band.level, sub.label, rb.role)"
                      class="jg-role-expand-block"
                    >
                      <div class="people-detail hay-person-detail jg-role-persons-after-table">
                      <div class="people-header hay-person-header">
                        <span>#</span><span><svg class="inline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="12" cy="7" r="4"/><path d="M5.5 21a6.5 6.5 0 0113 0"/></svg> Persona</span><span class="hay-person-deviation-head" title="Scostamento % retribuzione totale rispetto alla media della fascia">Scost. vs media fascia</span><span>Retrib. base</span><span>Comp. variabile</span>                        <span>Retrib. totale</span><span>Giustificativo</span>
                      </div>
                      <div
                        v-for="p in rb.people"
                        :key="`${band.level}-${sub.label}-${rb.role}-${p.index}`"
                        class="people-row hay-person-row"
                      >
                        <span>{{ p.index }}</span>
                        <span>
                          <svg
                            v-if="p.gender === 'M'"
                            class="inline-icon"
                            :class="personGenderClass(p.gender)"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            width="13"
                            height="13"
                          ><circle cx="9" cy="15" r="5"/><path d="M13 11l7-7"/><path d="M15 4h5v5"/></svg>
                          <svg
                            v-else-if="p.gender === 'F'"
                            class="inline-icon"
                            :class="personGenderClass(p.gender)"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            width="13"
                            height="13"
                          ><circle cx="12" cy="9" r="5"/><path d="M12 14v7"/><path d="M9 18h6"/></svg>
                          <svg
                            v-else
                            class="inline-icon gender-unknown"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            width="13"
                            height="13"
                          ><circle cx="12" cy="12" r="9"/><path d="M9 9h.01"/><path d="M15 9h.01"/><path d="M8 15c1.2 1.2 2.6 1.8 4 1.8s2.8-.6 4-1.8"/></svg>
                          {{ p.name || '–' }}
                        </span>
                        <span class="hay-person-deviation-cell" title="Retribuzione totale vs media aritmetica della fascia (stesso punteggio pesato)">{{ formatDeviationVsBandMean(p) }}</span>
                        <span>{{ formatNum(p.baseSalary) }}</span>
                        <span>{{ formatNum(p.variableComponents) }}</span>
                        <span>{{ formatNum(p.totalSalary) }}</span>
                        <span class="hay-person-justify-cell">
                          <button
                            v-if="hasHayBandDisparity(sub) || personJustifications[String(p.index)]"
                            type="button"
                            class="btn-justify-person"
                            :class="{ 'has-note': personJustifications[String(p.index)] }"
                            title="Apri o modifica il giustificativo (gap M/F nella fascia)"
                            @click.stop="openPersonJustify(p, rb, band, sub)"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>
                            + Giustificativo
                          </button>
                          <span v-else class="muted hay-person-no-justify">–</span>
                        </span>
                      </div>
                      </div>
                    </div>
                  </template>
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
          </template>
          <div v-else class="no-data-msg">
            Dati job grading non disponibili. Verifica che la colonna <strong>Livello</strong> sia mappata correttamente.
          </div>
        </div>

        <!-- Tab: inserisci giustificativo (ex popup) -->
        <div
          v-show="resultsTab === 'person_justify' && justifyingPerson"
          class="person-justify-tab-panel"
        >
          <template v-if="justifyingPerson">
            <h2 class="person-justify-tab-title">
              Inserisci giustificativo per {{ justifyingPerson.displayName }}
            </h2>
            <p class="person-justify-tab-lead">
              <strong>Ruolo:</strong> {{ justifyingPerson.roleName }}
              · <strong>Livello CCNL</strong> {{ justifyingPerson.bandNum }} ({{ justifyingPerson.levelLabel }})
              · <strong>{{ justifyingPerson.fasciaId }}</strong> — range /100 {{ justifyingPerson.fasciaRange }}
            </p>

            <div class="person-justify-summary-grid">
              <div class="person-justify-summary-card">
                <h4 class="person-justify-summary-title">Dati retributivi</h4>
                <ul class="person-justify-summary-list">
                  <li><strong>Retribuzione base:</strong> {{ formatNum(justifyingPerson.baseSalary) }}</li>
                  <li><strong>Componenti variabili:</strong> {{ formatNum(justifyingPerson.variableComponents) }}</li>
                  <li><strong>Retribuzione totale:</strong> {{ formatNum(justifyingPerson.totalSalary) }}</li>
                  <li><strong>Genere:</strong> {{ justifyingPerson.gender === 'M' ? 'M' : justifyingPerson.gender === 'F' ? 'F' : '–' }}</li>
                </ul>
              </div>
              <div class="person-justify-summary-card">
                <h4 class="person-justify-summary-title">Gap M/F nella fascia</h4>
                <p class="person-justify-gap-line">
                  <span :class="euGapSeverityClass(justifyingPerson.gapFasciaPct)">{{ justifyingPerson.gapFasciaFormatted }}</span>
                </p>
              </div>
              <div class="person-justify-summary-card person-justify-summary-card--hay">
                <h4 class="person-justify-summary-title">Punteggi ruolo (1–5)</h4>
                <ul class="person-justify-summary-list person-justify-hay-list">
                  <li v-for="f in TRANSPARENCY_FLAT_FACTORS" :key="f.id">
                    <strong>{{ f.label }}:</strong> {{ roleTr(justifyingPerson.roleScoresBlock, f.id) ?? '–' }}
                  </li>
                  <li><strong>Punteggio parametrico:</strong> {{ justifyingPerson.trParametricScore100 != null ? formatNum(justifyingPerson.trParametricScore100) + '/100' : '–' }} <span class="muted">(media 1–5: {{ justifyingPerson.trWeightedScore != null ? formatNum(justifyingPerson.trWeightedScore) : '–' }})</span></li>
                </ul>
              </div>
            </div>

            <div class="justify-person-metrics">
              <div class="justify-metric-card">
                <div class="justify-metric-title">Anzianità</div>
                <p class="justify-metric-line">
                  <strong>Da file:</strong>
                  {{ formatSeniorityDisplay(justifyingPerson.seniority) }}
                </p>
                <p class="justify-metric-line">
                  <strong>Scostamento vs media della fascia:</strong>
                  <span v-if="justifyingPerson.seniorityPctVsFascia != null" class="justify-metric-pct">
                    {{ formatPctSigned(justifyingPerson.seniorityPctVsFascia) }}
                  </span>
                  <span v-else class="muted">n/d</span>
                  <span v-if="justifyingPerson.fascAvgSeniorityYears != null" class="justify-metric-ref muted">
                    (media fascia: {{ justifyingPerson.fascAvgSeniorityYears.toFixed(1) }} anni)
                  </span>
                </p>
                <p v-if="justifyingPerson.seniorityPctVsFascia == null" class="justify-metric-note muted">
                  Il confronto % richiede anzianità espressa in anni numerici o data di ingresso; in alcuni formati non è calcolabile.
                </p>
              </div>
              <div class="justify-metric-card justify-metric-card--mock">
                <div class="justify-metric-title">Performance</div>
                <p class="justify-metric-line">
                  <strong>Punteggio performance:</strong>
                  {{ justifyingPerson.performanceScore ?? '–' }} / 100
                </p>
                <p class="justify-metric-line">
                  <strong>Scostamento vs media della fascia:</strong>
                  <span v-if="justifyingPerson.performancePctVsFascia != null" class="justify-metric-pct">
                    {{ formatPctSigned(justifyingPerson.performancePctVsFascia) }}
                  </span>
                  <span v-else class="muted">n/d</span>
                  <span v-if="justifyingPerson.fascAvgPerformance != null" class="justify-metric-ref muted">
                    (media fascia: {{ justifyingPerson.fascAvgPerformance.toFixed(1) }})
                  </span>
                </p>
              </div>
              <div class="justify-metric-card justify-metric-card--upload">
                <div class="justify-metric-title">Carica documento</div>
                <div class="justify-upload-toolbar">
                  <input
                    ref="personJustifyFileInput"
                    type="file"
                    class="person-justify-file-input"
                    multiple
                    accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,application/pdf,image/*"
                    @change="onPersonJustifyFilesSelected"
                  />
                  <button type="button" class="btn-secondary justify-upload-btn" @click="triggerPersonJustifyFile">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" aria-hidden="true"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    Carica documento giustificativo
                  </button>
                  <div class="justify-doc-info-wrap">
                    <button
                      type="button"
                      class="justify-info-trigger"
                      aria-label="Informazioni sui documenti da allegare"
                      aria-describedby="person-justify-doc-tooltip-tab"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
                    </button>
                    <div id="person-justify-doc-tooltip-tab" class="justify-doc-tooltip" role="tooltip">
                      <p class="justify-doc-tooltip-title">Documentazione utile per categoria</p>
                      <p v-for="(sec, idx) in PERSON_JUSTIFY_DOC_INFO_SECTIONS" :key="idx" class="justify-doc-tooltip-p">
                        <strong>{{ sec.title }}:</strong> {{ sec.body }}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <p class="justify-hint">Inserisci un giustificativo rispetto al gap retributivo M/F nella fascia (puoi richiamare anzianità e performance come elementi oggettivi, se coerenti con i dati).</p>
            <div v-if="canSuggestPersonJustifyAI()" class="justify-ai-row">
              <button
                type="button"
                class="btn-ai"
                :disabled="justifyAiLoading || !geminiEnabled"
                @click="suggestPersonJustifyAI"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true">
                  <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3z"/>
                  <path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14z"/>
                  <path d="M5 14l.7 1.6L7.3 16l-1.6.7L5 18.3l-.7-1.6L2.7 16l1.6-.7L5 14z"/>
                </svg>
                <span v-if="justifyAiLoading">Elaboro frase con AI...</span>
                <span v-else>Suggerisci giustificativo AI</span>
              </button>
              <span v-if="!geminiEnabled" class="muted justify-ai-note">Gemini non attivo in questo ambiente.</span>
            </div>

            <div class="person-justify-suggestions">
              <p class="person-justify-suggestions-title">Suggerimenti — clic per aggiungere al testo</p>
              <details
                v-for="cat in PERSON_JUSTIFY_SUGGESTION_CATEGORIES"
                :key="cat.id"
                class="person-justify-cat"
              >
                <summary class="person-justify-cat-summary">{{ cat.title }}</summary>
                <p v-if="cat.intro" class="person-justify-cat-intro">{{ cat.intro }}</p>
                <div class="person-justify-chips">
                  <button
                    v-for="(item, i) in cat.items"
                    :key="`${cat.id}-${i}`"
                    type="button"
                    class="person-justify-chip"
                    @click="appendPersonJustifySnippet(item.snippet)"
                  >
                    {{ item.label }}
                  </button>
                </div>
              </details>
            </div>

            <label class="person-justify-textarea-label">Testo del giustificativo</label>
            <textarea v-model="justifyText" class="justify-textarea" rows="6" placeholder="Motivo..."></textarea>
            <div class="justify-actions justify-actions-tab">
              <button type="button" class="btn-secondary" @click="cancelPersonJustify">Annulla</button>
              <button type="button" class="btn-primary" @click="savePersonJustify">Salva giustificativo</button>
            </div>
          </template>
        </div>

        <div class="mapping-actions">
          <button class="btn-secondary" @click="goToMappingFromResults">Modifica mapping</button>
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
        <div v-if="roleValuationModal != null" class="justify-overlay" @click.self="closeRoleValuationModal">
          <div class="justify-modal justify-modal--wide jg-role-valuation-modal" role="dialog" aria-modal="true" aria-labelledby="jg-role-val-title">
            <h3 id="jg-role-val-title">Dettaglio valutazione — {{ roleValuationModal.roleName }}</h3>
            <p class="justify-hint jg-role-valuation-edit-hint">
              Modifica i <strong>voti (1–5)</strong> per ogni fattore e salva. Apri <strong>Info analisi</strong> per le definizioni dei livelli.
            </p>
            <template v-if="roleValuationModalRb">
              <div class="jg-role-valuation-table-wrap">
                <table class="jg-role-valuation-table">
                  <thead>
                    <tr>
                      <th>Macro-area (peso sul totale)</th>
                      <th>Fattore (peso sull’area)</th>
                      <th>Voto (1–5)</th>
                      <th>Contributo (pt /100)</th>
                    </tr>
                  </thead>
                  <tbody>
                    <template v-for="area in TRANSPARENCY_MACRO_AREAS" :key="'vm-' + area.id + '-' + roleValuationModalRb.role">
                      <tr v-for="(f, fi) in area.factors" :key="f.id">
                        <td v-if="fi === 0" :rowspan="area.factors.length" class="jg-rv-mac">
                          <strong>{{ area.label }}</strong>
                          <div class="jg-rv-w">{{ area.weightPct }}% sul totale valutazione</div>
                        </td>
                        <td class="jg-rv-fac">
                          <strong>{{ f.label }}</strong>
                          <div class="jg-rv-w">{{ f.weightPct }}% · {{ f.description }}</div>
                        </td>
                        <td class="jg-rv-score">
                          <input
                            v-model.number="roleValuationForm[f.id]"
                            type="number"
                            min="1"
                            max="5"
                            step="1"
                            class="mapping-select jg-rv-input"
                            :aria-label="'Voto ' + f.label"
                            @click.stop
                          />
                        </td>
                        <td class="jg-rv-pt" title="% peso sul totale × voto / 5">{{ formatFactorParametricContributionFromForm(f) }}</td>
                      </tr>
                    </template>
                  </tbody>
                  <tfoot>
                    <tr class="jg-rv-foot">
                      <td colspan="2"><strong>Punteggio parametrico (0–100)</strong></td>
                      <td class="muted">—</td>
                      <td class="jg-rv-foot-score">
                        <strong>{{ formatNum(previewValuationFormParametric100()) }}</strong>
                        <span class="muted jg-rv-foot-hint">Σ (% peso × voto / 5); es. 10% e voto 4 → 8 pt</span>
                      </td>
                    </tr>
                    <tr class="jg-rv-foot jg-rv-foot--sub">
                      <td colspan="2"><strong>Media pesata (scala 1–5)</strong></td>
                      <td colspan="2" class="jg-rv-foot-score">
                        <strong>{{ formatNum(previewValuationFormWeighted()) }}</strong>
                        <span class="muted jg-rv-foot-hint">Σ (voto × peso fattore)</span>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </template>
            <p v-else class="muted jg-role-valuation-missing">Dati ruolo non disponibili.</p>
            <div class="justify-actions">
              <button type="button" class="btn-secondary" @click="closeRoleValuationModal">Annulla</button>
              <span style="flex: 1"></span>
              <button type="button" class="btn-primary" @click="saveRoleValuationModal">Salva e ricalcola fasce</button>
            </div>
          </div>
        </div>

        <div
          v-if="jobGradingCriteriaModalOpen"
          class="eu-outlier-modal-backdrop jg-criteria-backdrop"
          @click.self="jobGradingCriteriaModalOpen = false"
        >
          <div class="jg-criteria-modal" role="dialog" aria-modal="true" aria-labelledby="jg-crit-title">
            <h3 id="jg-crit-title">Criteri valutativi — trasparenza retributiva</h3>
            <p class="jg-criteria-intro muted">
              Quattro macro-aree con peso sul totale. Ogni fattore ha peso proprio e una scala da <strong>1</strong> (minimo) a <strong>5</strong> (massimo).
            </p>
            <div class="jg-criteria-table-wrap">
              <table class="jg-criteria-table">
                <thead>
                  <tr>
                    <th>Macro-area</th>
                    <th>Fattore (peso)</th>
                    <th>In sintesi</th>
                    <th>1</th>
                    <th>2</th>
                    <th>3</th>
                    <th>4</th>
                    <th>5</th>
                  </tr>
                </thead>
                <tbody>
                  <template v-for="area in TRANSPARENCY_MACRO_AREAS" :key="area.id">
                    <tr v-for="(f, fi) in area.factors" :key="f.id">
                      <td v-if="fi === 0" :rowspan="area.factors.length" class="jg-mac-area">
                        <strong>{{ area.label }}</strong>
                        <div class="jg-mac-w">{{ area.weightPct }}%</div>
                      </td>
                      <td class="jg-crit-factor">
                        <strong>{{ f.label }}</strong>
                        <span class="jg-f-w">{{ f.weightPct }}%</span>
                      </td>
                      <td class="jg-crit-desc">{{ f.description }}</td>
                      <td v-for="(lvl, li) in f.levels" :key="li" class="jg-crit-lvl">{{ lvl }}</td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </div>
            <div class="jg-criteria-actions">
              <button type="button" class="btn-primary" @click="jobGradingCriteriaModalOpen = false">Chiudi</button>
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

/* EU 2023/970 — Global Gender Pay Transparency Dashboard */
.eu-results-tabs {
  margin-top: 0.25rem;
}

/* Tab giustificativo persona (ex modal) */
.person-justify-tab-panel {
  margin-bottom: 1.5rem;
  padding: 1rem 1.15rem;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: 12px;
  box-shadow: var(--shadow-soft);
}
.person-justify-tab-title {
  margin: 0 0 0.35rem;
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.3;
}
.person-justify-tab-lead {
  margin: 0 0 1rem;
  font-size: 0.875rem;
  color: var(--text-secondary);
  line-height: 1.5;
}
.person-justify-summary-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.75rem;
  margin-bottom: 1rem;
}
@media (min-width: 900px) {
  .person-justify-summary-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}
.person-justify-summary-card {
  border: 1px solid var(--border-light);
  border-radius: 10px;
  padding: 0.65rem 0.85rem;
  background: var(--bg-page);
}
.person-justify-summary-title {
  margin: 0 0 0.5rem;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}
.person-justify-summary-list {
  margin: 0;
  padding-left: 1.1rem;
  font-size: 0.82rem;
  line-height: 1.45;
}
.person-justify-hay-list {
  columns: 1;
}
@media (min-width: 600px) {
  .person-justify-hay-list {
    columns: 2;
  }
}
.person-justify-gap-line {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 700;
}
.justify-ai-row {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  margin: 0 0 0.9rem;
  flex-wrap: wrap;
}
.justify-ai-row .btn-ai {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.justify-ai-note {
  font-size: 0.78rem;
}
.justify-actions-tab {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 1rem;
}

.eu-dashboard-wrap {
  margin-bottom: 2rem;
}
.eu-dash-header {
  margin-bottom: 1rem;
}
.eu-dash-title {
  margin: 0 0 0.35rem;
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--text-primary);
}
.eu-dash-sub {
  margin: 0 0 1rem;
  font-size: 0.875rem;
  color: var(--text-secondary);
  line-height: 1.5;
}
.eu-salary-toggle {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.eu-salary-toggle-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-right: 0.25rem;
}
.eu-legend-line {
  font-size: 0.8125rem;
  color: var(--text-secondary);
  margin: 0 0 1rem;
}
.eu-leg {
  font-size: 0.9rem;
  margin-right: 0.15rem;
}
.eu-leg-green {
  color: #16a34a;
}
.eu-leg-yellow {
  color: #ca8a04;
}
.eu-leg-red {
  color: #dc2626;
}
.gap-severity-green {
  color: #15803d;
}
.gap-severity-yellow {
  color: #b45309;
}
.gap-severity-red {
  color: #b91c1c;
}
.gap-severity-na {
  color: var(--text-secondary);
}
.eu-kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;
  margin-bottom: 1.5rem;
}
.eu-kpi-card {
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: 10px;
  padding: 1rem 1.1rem;
  box-shadow: var(--shadow-soft);
}
.eu-kpi-span {
  grid-column: 1 / -1;
}
@media (min-width: 720px) {
  .eu-kpi-span {
    grid-column: span 2;
  }
}
.eu-kpi-label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
  margin-bottom: 0.35rem;
}
.eu-kpi-value {
  font-size: 1.35rem;
  font-weight: 700;
  line-height: 1.2;
}
.eu-kpi-value-inline {
  font-size: 0.95rem;
  line-height: 1.4;
}
.eu-kpi-hint {
  margin-top: 0.4rem;
  font-size: 0.75rem;
  color: var(--text-secondary);
  line-height: 1.35;
}
.eu-charts-row {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1.25rem;
  margin-bottom: 1.25rem;
}
@media (min-width: 900px) {
  .eu-charts-row {
    grid-template-columns: 1fr 1fr;
  }
}
.eu-panel {
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: 10px;
  padding: 1rem 1.15rem;
  box-shadow: var(--shadow-soft);
}
.eu-panel-title {
  margin: 0 0 0.35rem;
  font-size: 0.95rem;
  font-weight: 700;
}
.eu-panel-desc {
  margin: 0 0 1rem;
  font-size: 0.8rem;
  color: var(--text-secondary);
  line-height: 1.45;
}
.eu-outlier-panel {
  margin-bottom: 1.25rem;
}
.eu-outlier-table-wrap {
  overflow-x: auto;
  margin-bottom: 1rem;
}
.eu-outlier-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
}
.eu-outlier-table th,
.eu-outlier-table td {
  border-bottom: 1px solid var(--border-light);
  padding: 0.45rem 0.5rem;
  text-align: left;
  vertical-align: middle;
}
.eu-outlier-table th {
  font-weight: 600;
  color: var(--text-secondary);
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.eu-outlier-num {
  text-align: right;
  white-space: nowrap;
}
.eu-outlier-reason {
  color: var(--text-secondary);
  max-width: 14rem;
}
.btn-eu-outlier {
  font: inherit;
  font-size: 0.78rem;
  padding: 0.35rem 0.65rem;
  border-radius: 6px;
  border: 1px solid #2152ff;
  background: linear-gradient(310deg, #2152ff 0%, #21d4fd 100%);
  color: #fff;
  cursor: pointer;
  white-space: nowrap;
}
.btn-eu-outlier:hover {
  filter: brightness(1.05);
}
.btn-eu-outlier-ghost {
  background: transparent;
  color: #2152ff;
  border-color: var(--border-light);
}
.eu-outlier-excluded {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px dashed var(--border-light);
}
.eu-outlier-excluded-title {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
  font-weight: 700;
}
.eu-outlier-excluded-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.eu-outlier-excluded-item {
  padding: 0.65rem 0;
  border-bottom: 1px solid var(--border-light);
}
.eu-outlier-excluded-item:last-child {
  border-bottom: none;
}
.eu-outlier-ex-main {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.eu-outlier-ex-name {
  font-weight: 600;
}
.eu-outlier-ex-note {
  margin: 0.35rem 0 0.5rem;
  font-size: 0.82rem;
  line-height: 1.4;
  color: var(--text-secondary);
}
.eu-outlier-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1200;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}
.eu-outlier-modal {
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: 12px;
  padding: 1.25rem 1.35rem;
  max-width: 28rem;
  width: 100%;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.18);
}
.eu-outlier-modal h4 {
  margin: 0 0 0.35rem;
  font-size: 1.05rem;
}
.eu-outlier-modal-sub {
  margin: 0 0 1rem;
  font-size: 0.85rem;
}
.eu-outlier-label {
  display: block;
  font-size: 0.78rem;
  font-weight: 600;
  margin-bottom: 0.35rem;
  color: var(--text-secondary);
}
.eu-outlier-textarea {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  font-size: 0.88rem;
  padding: 0.5rem 0.65rem;
  border-radius: 8px;
  border: 1px solid var(--border-light);
  background: var(--bg-page);
  color: inherit;
  resize: vertical;
  min-height: 5rem;
  margin-bottom: 1rem;
}
.eu-outlier-modal-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: flex-end;
}
.eu-quartile-chart {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 0.75rem;
  min-height: 160px;
}
.eu-quartile-col {
  flex: 1;
  text-align: center;
  min-width: 0;
}
.eu-q-label {
  font-weight: 700;
  font-size: 0.85rem;
  margin-bottom: 0.5rem;
}
.eu-q-pair {
  display: flex;
  gap: 0.35rem;
  justify-content: center;
  align-items: flex-end;
}
.eu-q-bar-col {
  flex: 1;
  max-width: 48px;
}
.eu-q-bar-bg {
  height: 100px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: var(--bg-page);
  border-radius: 6px 6px 0 0;
  border: 1px solid var(--border-light);
  border-bottom: none;
  overflow: hidden;
}
.eu-q-bar {
  width: 100%;
  min-height: 2px;
  border-radius: 4px 4px 0 0;
  transition: height 0.2s ease;
}
.eu-q-bar-m {
  background: linear-gradient(180deg, #3b82f6, #1d4ed8);
}
.eu-q-bar-f {
  background: linear-gradient(180deg, #ec4899, #be185d);
}
.eu-q-pct {
  display: block;
  font-size: 0.65rem;
  color: var(--text-secondary);
  margin-top: 0.25rem;
  line-height: 1.2;
}
.eu-q-meta {
  font-size: 0.72rem;
  color: var(--text-secondary);
  margin-top: 0.35rem;
}
.eu-level-list {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  max-height: 280px;
  overflow-y: auto;
}
.eu-level-row {
  font-size: 0.82rem;
}
.eu-level-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 0.75rem;
  margin-bottom: 0.2rem;
}
.eu-level-name {
  font-weight: 600;
  flex: 1;
  min-width: 140px;
}
.eu-level-gap {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.eu-level-track {
  height: 6px;
  background: var(--bg-page);
  border-radius: 4px;
  overflow: hidden;
}
.eu-level-fill {
  height: 100%;
  border-radius: 4px;
  min-width: 2px;
}
.eu-level-fill.gap-severity-green {
  background: #22c55e;
}
.eu-level-fill.gap-severity-yellow {
  background: #eab308;
}
.eu-level-fill.gap-severity-red {
  background: #ef4444;
}
.eu-level-fill.gap-severity-na {
  background: var(--border);
}
.eu-alert-panel {
  margin-bottom: 1rem;
}
.eu-alert-list {
  margin: 0;
  padding-left: 1.2rem;
}
.eu-alert-item {
  margin-bottom: 0.5rem;
  font-size: 0.875rem;
  line-height: 1.45;
}
.eu-seg-panel {
  border-color: rgba(202, 138, 4, 0.35);
  background: rgba(254, 252, 232, 0.35);
}
.eu-seg-list {
  margin: 0;
  padding-left: 1.2rem;
  font-size: 0.82rem;
  line-height: 1.5;
}

.no-data-msg {
  padding: 2rem 0;
  text-align: center;
  color: var(--text-secondary);
  font-size: 0.95rem;
}

.job-grading-gap-alert {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  margin: 0 0 1rem;
  border-radius: 10px;
  border: 1px solid rgba(220, 38, 38, 0.35);
  background: rgba(254, 242, 242, 0.95);
  color: #991b1b;
}
.job-grading-gap-alert--ok {
  border-color: rgba(22, 163, 74, 0.35);
  background: rgba(240, 253, 244, 0.95);
  color: #166534;
}
.job-grading-gap-alert__icon {
  flex-shrink: 0;
  display: flex;
  margin-top: 0.1rem;
}
.job-grading-gap-alert__body {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.35rem 0.5rem;
  font-size: 0.9rem;
  line-height: 1.4;
}
.job-grading-gap-alert__count {
  font-size: 1.25rem;
  font-variant-numeric: tabular-nums;
}
.job-grading-gap-alert__label {
  font-weight: 600;
}
.job-grading-gap-alert__hint {
  font-size: 0.8rem;
  font-weight: 500;
  opacity: 0.9;
  width: 100%;
  flex-basis: 100%;
}
@media (min-width: 520px) {
  .job-grading-gap-alert__hint {
    width: auto;
    flex-basis: auto;
  }
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
  grid-template-columns: 1fr 1.35fr 0.72fr 0.72fr 0.65fr 1fr 1fr;
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

.people-detail.hay-fascia-detail {
  border-left: 3px solid var(--accent-blue, #2b86ed);
  margin-left: 0.25rem;
  padding-left: 1rem;
}

.hay-band-label {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.hay-band-alert-icon {
  color: #dc2626;
  flex: 0 0 auto;
}

.hay-band-gap-pill {
  display: inline-block;
  margin-left: 0.4rem;
  padding: 0.08rem 0.4rem;
  border-radius: 999px;
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--text-secondary);
  background: rgba(148, 163, 184, 0.14);
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

.hay-role-header.jg-tr-score-grid,
.hay-role-row.jg-tr-score-grid {
  grid-template-columns:
    minmax(10rem, 2.1fr)
    repeat(4, minmax(5.25rem, 0.95fr))
    minmax(3.5rem, 0.5fr)
    minmax(7.5rem, 1.05fr)
    minmax(1.15rem, 0.38fr)
    minmax(4.2rem, 1fr);
  gap: 0.25rem 0.35rem;
  font-size: 0.72rem;
}
.jg-tr-col-head {
  text-align: center;
  line-height: 1.15;
  white-space: normal;
  font-size: 0.62rem;
}
.hay-role-header.jg-tr-score-grid .jg-tr-col-area {
  white-space: normal;
  hyphens: auto;
  word-break: break-word;
}
.jg-tr-col-head-punteggio,
.jg-tr-col-head-detail {
  font-size: 0.58rem;
  line-height: 1.2;
}
.jg-tr-detail-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
}
.hay-role-row.jg-tr-score-grid .jg-tr-detail-cell {
  white-space: normal;
}
.btn-jg-role-valuation {
  font-size: 0.62rem;
  padding: 0.22rem 0.5rem;
  line-height: 1.25;
  white-space: nowrap;
  border: 1px solid rgba(10, 108, 210, 0.4);
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  color: var(--text-primary);
  font-weight: 600;
}
.btn-jg-role-valuation:hover {
  background: rgba(10, 108, 210, 0.1);
}
.jg-role-valuation-modal .jg-role-valuation-table-wrap {
  max-height: min(70vh, 520px);
  overflow: auto;
  margin-bottom: 0.5rem;
}
.jg-role-valuation-missing {
  margin: 0.5rem 0 1rem;
}
.jg-tr-score-cell {
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.jg-tr-p {
  font-weight: 700;
  color: var(--text-primary);
}
.jg-tr-p-100 {
  white-space: nowrap;
}
.jg-tr-p100-suffix {
  font-size: 0.78em;
  font-weight: 600;
  margin-left: 0.08rem;
}
.jg-rv-pt {
  text-align: center;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  white-space: nowrap;
}
.jg-rv-foot--sub td {
  background: rgba(33, 82, 255, 0.035);
  border-top: 1px solid var(--border-light);
}
.role-params-total--sub {
  margin-top: 0.2rem;
  margin-bottom: 0;
  font-size: 0.86rem;
}
.role-params-formula {
  font-size: 0.9em;
}
.jg-role-expand-block {
  margin: 0.35rem 0 0.5rem 0.25rem;
  padding-left: 0.5rem;
  border-left: 3px solid rgba(33, 82, 255, 0.35);
}
.jg-role-valuation-panel {
  background: #f8fafc;
  border: 1px solid var(--border-light);
  border-radius: 10px;
  padding: 0.65rem 0.85rem 0.75rem;
  margin-bottom: 0.65rem;
}
.jg-role-valuation-table-wrap {
  overflow-x: auto;
  border-radius: 8px;
  border: 1px solid var(--border-light);
  background: #fff;
}
.jg-role-valuation-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.74rem;
  line-height: 1.35;
}
.jg-role-valuation-table th,
.jg-role-valuation-table td {
  border-bottom: 1px solid var(--border-light);
  padding: 0.45rem 0.5rem;
  vertical-align: top;
  text-align: left;
}
.jg-role-valuation-table thead th {
  background: rgba(10, 108, 210, 0.09);
  font-weight: 700;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--text-secondary);
}
.jg-role-valuation-table tbody tr:last-child td {
  border-bottom: none;
}
.jg-rv-mac {
  background: rgba(10, 108, 210, 0.05);
  font-weight: 600;
  min-width: 7.5rem;
  width: 18%;
}
.jg-rv-fac {
  min-width: 10rem;
  width: 22%;
}
.jg-rv-w {
  font-size: 0.72em;
  font-weight: 600;
  color: var(--text-secondary);
  margin-top: 0.2rem;
  line-height: 1.3;
}
.jg-rv-score {
  text-align: center;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  width: 4rem;
  white-space: nowrap;
}
.jg-rv-input {
  width: 3.25rem;
  max-width: 100%;
  padding: 0.28rem 0.35rem;
  text-align: center;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.jg-role-valuation-edit-hint {
  margin: 0 0 0.65rem;
  font-size: 0.82rem;
}
.jg-rv-foot td {
  background: rgba(33, 82, 255, 0.06);
  border-top: 2px solid var(--border-light);
  padding-top: 0.55rem;
  padding-bottom: 0.55rem;
}
.jg-rv-foot-score {
  font-variant-numeric: tabular-nums;
}
.jg-rv-foot-score strong {
  font-size: 1rem;
}
.jg-rv-foot-hint {
  display: block;
  font-size: 0.68rem;
  font-weight: 400;
  margin-top: 0.2rem;
}
.jg-role-persons-after-table {
  margin-top: 0.25rem;
}
.job-grading-tab-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.65rem;
}
.job-grading-tab-head__text {
  flex: 1;
  min-width: 14rem;
  margin: 0;
}
.btn-jg-criteria {
  flex-shrink: 0;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  padding: 0.42rem 0.85rem;
  border-radius: 8px;
  border: 1px solid var(--border-light);
  background: var(--bg-card);
  color: #2152ff;
  cursor: pointer;
  box-shadow: var(--shadow-soft);
}
.btn-jg-criteria:hover {
  background: rgba(33, 82, 255, 0.08);
}
.jg-criteria-modal {
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: 12px;
  padding: 1rem 1.15rem 1.1rem;
  max-width: min(96vw, 1200px);
  width: 100%;
  max-height: 90vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.18);
}
.jg-criteria-modal h3 {
  margin: 0 0 0.35rem;
  font-size: 1.05rem;
}
.jg-criteria-intro {
  margin: 0 0 0.65rem;
  font-size: 0.82rem;
  line-height: 1.4;
}
.jg-criteria-table-wrap {
  overflow: auto;
  flex: 1;
  margin-bottom: 0.75rem;
  border: 1px solid var(--border-light);
  border-radius: 8px;
}
.jg-criteria-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.62rem;
  line-height: 1.3;
}
.jg-criteria-table th,
.jg-criteria-table td {
  border: 1px solid var(--border-light);
  padding: 0.35rem 0.4rem;
  vertical-align: top;
}
.jg-criteria-table thead th {
  background: rgba(10, 108, 210, 0.08);
  font-weight: 700;
  position: sticky;
  top: 0;
  z-index: 1;
}
.jg-mac-area {
  background: rgba(10, 108, 210, 0.06);
  font-weight: 600;
  white-space: normal;
  min-width: 5.5rem;
}
.jg-mac-w {
  font-size: 0.75em;
  font-weight: 700;
  color: var(--text-secondary);
  margin-top: 0.2rem;
}
.jg-crit-factor .jg-f-w {
  display: block;
  font-size: 0.75em;
  font-weight: 600;
  color: var(--text-secondary);
  margin-top: 0.15rem;
}
.jg-crit-desc {
  max-width: 10rem;
  color: var(--text-secondary);
}
.jg-crit-lvl {
  min-width: 5.5rem;
  max-width: 7.5rem;
  font-size: 0.58rem;
  line-height: 1.25;
}
.jg-criteria-actions {
  display: flex;
  justify-content: flex-end;
}
.justify-modal--wide {
  max-width: min(94vw, 44rem);
}
.role-params-grid--tr {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(13.5rem, 1fr));
  gap: 0.5rem;
  max-height: 52vh;
  overflow-y: auto;
  margin-bottom: 0.5rem;
}

.hay-person-header,
.hay-person-row {
  grid-template-columns: 0.4fr 1.5fr 0.9fr 1fr 1fr 1fr 1.15fr;
}

/* Blocco persone: sfondo bianco (stacca dal grigio/azzurro di .people-detail) */
.people-detail.hay-person-detail {
  background: #fff;
  border: 1px solid var(--border-light);
  border-radius: 8px;
  padding: 0.4rem 0.65rem 0.55rem;
  margin: 0.2rem 0 0.35rem;
}

.people-detail.hay-person-detail .hay-person-header {
  background: #fff;
  border-bottom-color: #e5e7eb;
}

.people-detail.hay-person-detail .hay-person-row {
  background: #fff;
  border-bottom: 1px solid #f0f0f0;
}

.people-detail.hay-person-detail .hay-person-row:hover {
  background: #fafafa;
}

.hay-role-row span,
.hay-person-row span,
.hay-role-header span,
.hay-person-header span {
  white-space: nowrap;
}

.hay-role-row span:first-child,
.hay-person-row span:nth-child(2),
.hay-role-header span:first-child,
.hay-person-header span:nth-child(2) {
  white-space: normal;
}

.hay-seniority-cell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.76rem;
  color: var(--text-secondary);
}
.hay-person-deviation-head {
  line-height: 1.2;
  white-space: normal;
}
.hay-person-deviation-cell {
  font-size: 0.76rem;
  font-variant-numeric: tabular-nums;
  text-align: right;
  color: var(--text-secondary);
}

.justify-seniority-box {
  background: rgba(10, 108, 210, 0.06);
  border-radius: var(--radius-sm);
  padding: 0.5rem 0.65rem;
  margin-bottom: 0.35rem;
}

.justify-person-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.75rem;
  margin: 0 0 1rem;
}
.justify-metric-card {
  background: rgba(10, 108, 210, 0.06);
  border: 1px solid var(--border-light);
  border-radius: 10px;
  padding: 0.65rem 0.85rem;
  font-size: 0.875rem;
  line-height: 1.45;
}
.justify-metric-card--mock {
  background: rgba(234, 179, 8, 0.08);
  border-color: rgba(202, 138, 4, 0.35);
}
.justify-metric-card--upload {
  background: rgba(10, 108, 210, 0.05);
}
.justify-metric-title {
  font-weight: 700;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text-secondary);
  margin-bottom: 0.4rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.justify-mock-badge {
  font-weight: 600;
  font-size: 0.65rem;
  text-transform: none;
  letter-spacing: 0;
  background: rgba(202, 138, 4, 0.2);
  color: #92400e;
  padding: 0.15rem 0.45rem;
  border-radius: 999px;
}
.justify-metric-line {
  margin: 0.25rem 0 0;
}
.justify-metric-pct {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  margin-left: 0.25rem;
}
.justify-metric-ref {
  display: block;
  margin-top: 0.2rem;
  font-size: 0.78rem;
}
.justify-metric-note {
  margin: 0.45rem 0 0;
  font-size: 0.78rem;
  line-height: 1.35;
}

.person-justify-file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.justify-upload-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.75rem;
  margin: 0;
}
.justify-upload-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.justify-metric-card--upload .justify-upload-toolbar {
  flex-direction: column;
  align-items: stretch;
}
.justify-metric-card--upload .justify-upload-btn {
  justify-content: center;
}
.justify-metric-card--upload .justify-doc-info-wrap {
  align-self: flex-start;
}
.justify-doc-info-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.justify-info-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--border-light);
  border-radius: 50%;
  background: var(--bg-page);
  color: var(--accent-blue, #2563eb);
  cursor: help;
  transition: background 0.15s, border-color 0.15s;
}
.justify-info-trigger:hover,
.justify-info-trigger:focus-visible {
  background: rgba(37, 99, 235, 0.08);
  border-color: var(--accent-blue, #2563eb);
  outline: none;
}
.justify-doc-tooltip {
  display: none;
  position: absolute;
  z-index: 50;
  left: 0;
  bottom: calc(100% + 8px);
  width: min(22rem, calc(100vw - 3rem));
  max-height: min(70vh, 24rem);
  overflow-y: auto;
  padding: 0.75rem 0.9rem;
  font-size: 0.78rem;
  line-height: 1.45;
  color: var(--text-primary);
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: 10px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.12);
  text-align: left;
}
.justify-doc-tooltip::after {
  content: '';
  position: absolute;
  left: 14px;
  bottom: -6px;
  width: 10px;
  height: 10px;
  background: var(--bg-card);
  border-right: 1px solid var(--border-light);
  border-bottom: 1px solid var(--border-light);
  transform: rotate(45deg);
}
.justify-doc-info-wrap:hover .justify-doc-tooltip,
.justify-doc-info-wrap:focus-within .justify-doc-tooltip {
  display: block;
}
.justify-doc-tooltip-title {
  margin: 0 0 0.5rem;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}
.justify-doc-tooltip-p {
  margin: 0 0 0.5rem;
}
.justify-doc-tooltip-p:last-child {
  margin-bottom: 0;
}

.inline-icon {
  display: inline-block;
  vertical-align: -2px;
  margin-right: 0.25rem;
  color: var(--text-secondary);
}

.inline-icon.gender-male {
  color: #2563eb;
}

.inline-icon.gender-female {
  color: #db2777;
}

.inline-icon.gender-unknown {
  color: #64748b;
}

.role-cell-main {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.role-params-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
  margin: 0.75rem 0 0.5rem;
}

.role-param-field {
  display: grid;
  gap: 0.3rem;
  font-size: 0.82rem;
  color: var(--text-secondary);
}

.role-params-total {
  margin: 0.25rem 0 0.5rem;
  font-size: 0.85rem;
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

.upload-info {
  margin: 1rem 0 0;
  padding: 0.65rem 0.85rem;
  border-radius: 8px;
  border: 1px solid rgba(37, 99, 235, 0.25);
  background: rgba(59, 130, 246, 0.06);
  color: #1e40af;
  font-size: 0.875rem;
  line-height: 1.45;
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

/* Pulsante giustificativo persona (testo esplicito) */
.hay-person-justify-cell {
  display: flex;
  align-items: center;
  justify-content: flex-start;
}

.hay-person-no-justify {
  font-size: 0.78rem;
}

.btn-justify-person {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.65rem;
  border: 1px solid rgba(22, 163, 74, 0.35);
  border-radius: 6px;
  background: rgba(22, 163, 74, 0.08);
  color: #166534;
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}

.btn-justify-person svg {
  flex-shrink: 0;
  opacity: 0.75;
}

.btn-justify-person:hover {
  background: rgba(22, 163, 74, 0.16);
  border-color: #16a34a;
  color: #15803d;
}

.btn-justify-person:hover svg {
  opacity: 1;
}

.btn-justify-person.has-note {
  background: rgba(22, 163, 74, 0.2);
  border-color: #16a34a;
  color: #14532d;
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
  max-height: min(92vh, 900px);
  overflow-y: auto;
}

.justify-modal-person {
  max-width: 640px;
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

.person-justify-suggestions {
  margin: 0 0 1rem;
  padding: 0.75rem 0.85rem;
  background: var(--bg-page);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
}

.person-justify-suggestions-title {
  margin: 0 0 0.65rem;
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.person-justify-cat {
  margin-bottom: 0.35rem;
  border: 1px solid var(--border-light);
  border-radius: 8px;
  background: var(--bg-card);
  overflow: hidden;
}

.person-justify-cat--risk {
  border-color: rgba(220, 38, 38, 0.35);
}

.person-justify-cat-summary {
  cursor: pointer;
  padding: 0.5rem 0.65rem;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-primary);
  list-style: none;
}

.person-justify-cat-summary::-webkit-details-marker {
  display: none;
}

.person-justify-cat-summary::before {
  content: '▸ ';
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.person-justify-cat[open] .person-justify-cat-summary::before {
  content: '▾ ';
}

.person-justify-cat-intro {
  margin: 0 0.65rem 0.5rem;
  font-size: 0.75rem;
  color: var(--text-secondary);
  line-height: 1.4;
}

.person-justify-risk-banner {
  margin: 0 0.65rem 0.5rem;
  padding: 0.45rem 0.55rem;
  font-size: 0.72rem;
  line-height: 1.4;
  color: #991b1b;
  background: rgba(220, 38, 38, 0.1);
  border-radius: 6px;
}

.person-justify-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  padding: 0 0.65rem 0.65rem;
}

.person-justify-chip {
  font-size: 0.72rem;
  padding: 0.35rem 0.55rem;
  border: 1px solid var(--border-light);
  border-radius: 999px;
  background: var(--bg-page);
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.12s, background 0.12s;
}

.person-justify-chip:hover {
  border-color: var(--accent-blue);
  background: rgba(10, 108, 210, 0.06);
}

.person-justify-textarea-label {
  display: block;
  margin: 0 0 0.35rem;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-secondary);
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
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: #ffffff;
  color: #1f2937;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  transition: all 0.15s;
}
.toggle-btn:hover {
  background: #f8fafc;
  border-color: #94a3b8;
}
.toggle-btn.active {
  background: #2563eb;
  color: #fff;
  border-color: #2563eb;
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
