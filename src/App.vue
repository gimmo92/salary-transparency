<script setup>
import { ref, computed, onMounted } from 'vue'
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
  checkGeminiAvailable,
  suggestJustificationWithGemini,
} from './lib/gemini.js'
import {
  buildNormalizedJobGradingData,
  aggregateRolesForGrading,
  enrichWithBandsAndDeviation,
  computeWeightedScore,
  normalizeLevelScore,
  getJobFamily,
  getJobFamilyMultiplier,
} from './lib/jobGrading.js'
import { saveAnalysis, fetchAnalyses, fetchAnalysisById, deleteAnalysisById, fetchRules, saveRule, updateRuleById, deleteRuleById } from './lib/persistence.js'
import { jsPDF } from 'jspdf'
import 'jspdf-autotable'

const activeSection = ref('salaryReview')

const sections = [
  { id: 'salaryReview', label: 'Salary Review', icon: 'salary' },
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
const jobSource = ref('locale')

const resultsTab = ref('genere') // 'genere' | 'pari_valore'

const geminiEnabled = ref(false)

// Analysis settings
const analysisSettings = ref({
  weights: { level: 45, skills: 15, responsibility: 20, mentalEffort: 10, conditions: 10 },
  filterOutliers: true,
  strictOutliers: true,
  bandCount: 10,
})

const weightsTotal = computed(() => {
  const w = analysisSettings.value.weights
  return w.level + w.skills + w.responsibility + w.mentalEffort + w.conditions
})

const weightsValid = computed(() => weightsTotal.value === 100)

function clampWeight(key) {
  const w = analysisSettings.value.weights
  if (w[key] < 0) w[key] = 0
  if (w[key] > 100) w[key] = 100
}

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
    jobSource.value = (record.calculation_source || '').includes('job:ai') ? 'ai' : 'locale'
    expandedRoles.value = new Set()
    justifications.value = {}

    excelUrl.value = record.source_url || ''
    columnMapping.value = record.mapping_json || {}
    excelHeaders.value = record.headers_json || []
    excelRows.value = record.rows_json || []
    saveStatus.value = `Analisi caricata dallo storico (ID: ${record.id})`

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

// Job grading helpers
const expandedRoles = ref(new Set())

function toggleRoleExpand(role) {
  if (expandedRoles.value.has(role)) expandedRoles.value.delete(role)
  else expandedRoles.value.add(role)
  expandedRoles.value = new Set(expandedRoles.value)
}

function onScoreEdit(r) {
  r.totalScore = computeWeightedScore(r, analysisSettings.value.weights)
  recalcBandsAndDeviation()
}

function recalcBandsAndDeviation() {
  const settings = analysisSettings.value
  const current = jobResults.value.map((r) => ({ ...r }))
  jobResults.value = enrichWithBandsAndDeviation(current, {
    bandCount: settings.bandCount,
    filterOutliers: settings.filterOutliers,
    strictOutliers: settings.strictOutliers,
    weights: settings.weights,
  })
}

function fallbackLocalJobScores(roles) {
  const weights = analysisSettings.value.weights
  return roles.map((r) => {
    const text = `${r.role || ''} ${r.level || ''} ${r.description || ''}`.toLowerCase()
    const clamp = (x) => Math.max(0, Math.min(100, Math.round(x)))
    const kw = (list) => list.reduce((c, w) => c + (text.includes(w) ? 1 : 0), 0)
    const competenze = clamp(35 + kw(['specialist', 'tecnico', 'engineer', 'analyst', 'senior']) * 10 + text.length / 50)
    const responsabilita = clamp(30 + kw(['manager', 'responsabile', 'head', 'direttore', 'lead']) * 14 + (r.level?.length || 0) * 2)
    const sforzo = clamp(30 + kw(['controllo', 'strateg', 'analisi', 'progett', 'decision']) * 9 + text.length / 70)
    const condizioni = clamp(25 + kw(['turno', 'notte', 'impianto', 'produzione', 'stabilimento']) * 12)
    const levelScore = r.levelScore ?? normalizeLevelScore(r.level)
    const family = r.jobFamily || getJobFamily(r.role)
    const multiplier = r.jobFamilyMultiplier ?? getJobFamilyMultiplier(family)
    const scores = { competenze_richieste: competenze, responsabilita, sforzo_mentale: sforzo, condizioni_lavorative: condizioni, levelScore, jobFamilyMultiplier: multiplier }
    return { role: r.role, levelScore, jobFamily: family, jobFamilyMultiplier: multiplier, ...scores, totalScore: computeWeightedScore(scores, weights) }
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
  justifications.value = {}
  justifyingRole.value = null
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
    const settings = analysisSettings.value
    const normalizedJob = buildNormalizedJobGradingData(excelRows.value, excelHeaders.value, columnMapping.value)
    if (normalizedJob.length > 0) {
      const aggregated = aggregateRolesForGrading(normalizedJob, { filterOutliers: settings.filterOutliers, strictOutliers: settings.strictOutliers })
      let scored = fallbackLocalJobScores(aggregated)
      jobSource.value = 'locale'

      if (geminiEnabled.value) {
        geminiLoading.value = true
        try {
          const aiInput = aggregated.map((r) => ({ role: r.role, level: r.level, job_description: r.description }))
          const aiScores = await scoreJobRolesWithGemini(aiInput)
          const mapAi = new Map(aiScores.map((x) => [String(x.role || '').toLowerCase().trim(), x]))
          scored = aggregated.map((r) => {
            const ai = mapAi.get(String(r.role || '').toLowerCase().trim())
            if (!ai) return { ...fallbackLocalJobScores([r])[0], role: r.role }
            const c = Number(ai.competenze_richieste ?? 0), resp = Number(ai.responsabilita ?? 0)
            const s = Number(ai.sforzo_mentale ?? 0), cond = Number(ai.condizioni_lavorative ?? 0)
            const levelScore = r.levelScore ?? normalizeLevelScore(r.level)
            const family = r.jobFamily || getJobFamily(r.role)
            const multiplier = r.jobFamilyMultiplier ?? getJobFamilyMultiplier(family)
            const scores = { competenze_richieste: c, responsabilita: resp, sforzo_mentale: s, condizioni_lavorative: cond, levelScore, jobFamilyMultiplier: multiplier }
            return { role: r.role, levelScore, jobFamily: family, jobFamilyMultiplier: multiplier, ...scores, totalScore: computeWeightedScore(scores, settings.weights) }
          })
          jobSource.value = 'ai'
        } catch (err) {
          uploadError.value += (uploadError.value ? ' | ' : '') + 'Job Grading AI fallback locale: ' + (err.message || String(err))
        } finally { geminiLoading.value = false }
      }

      const merged = aggregated.map((r) => ({ ...r, ...(scored.find((x) => x.role === r.role) || {}) }))
      jobResults.value = enrichWithBandsAndDeviation(merged, {
        bandCount: settings.bandCount,
        filterOutliers: settings.filterOutliers,
        strictOutliers: settings.strictOutliers,
        weights: settings.weights,
      })
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

function formatPct(n) { return n == null ? '–' : n.toFixed(2) + '%' }
function formatNum(n) { return n == null ? '–' : Number(n).toLocaleString('it-IT', { maximumFractionDigits: 2 }) }
function scoreBadgeClass(band) { return `band-${band}` }

// Giustificativi per ruoli fuori ±5%
const justifications = ref({})
const justifyingRole = ref(null)
const justifyText = ref('')
const justifyAiLoading = ref(false)

function openJustify(roleName) {
  justifyingRole.value = roleName
  justifyText.value = justifications.value[roleName] || ''
}

async function suggestJustify() {
  const roleName = justifyingRole.value
  if (!roleName) return
  const r = jobResults.value.find((x) => x.role === roleName)
  if (!r) return
  justifyAiLoading.value = true
  try {
    const suggestion = await suggestJustificationWithGemini({
      role: r.role,
      level: r.level || '',
      band: r.band,
      totalScore: Math.round(r.totalScore),
      medianSalary: Math.round(r.medianTotalSalary || 0),
      deviation: Math.round((r.deviationFromBandMedianPct || 0) * 10) / 10,
      jobFamily: r.jobFamily || 'General',
      nEmployees: r.n || 1,
    })
    justifyText.value = suggestion
  } catch (err) {
    justifyText.value = `[Errore AI: ${err.message}]`
  } finally {
    justifyAiLoading.value = false
  }
}

function saveJustify() {
  if (justifyingRole.value != null) {
    justifications.value[justifyingRole.value] = justifyText.value
  }
  justifyingRole.value = null
  justifyText.value = ''
}

function cancelJustify() {
  justifyingRole.value = null
  justifyText.value = ''
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
    'La valutazione dei ruoli è basata su cinque fattori ponderati con Clustering Funzionale:',
    '',
    '1. Inquadramento Contrattuale (Livello CCNL): fattore predominante, normalizzato in scala 0-100',
    '   (D1-D2=20pt, C1-C3=40pt, B1-B3=65pt, AS-A=85pt, Q=100pt).',
    '',
    '2. Competenze richieste (0-100): conoscenze tecniche, professionali e gestionali necessarie.',
    '',
    '3. Responsabilità (0-100): impatto sugli obiettivi, autonomia, gestione risorse.',
    '',
    '4. Sforzo mentale (0-100): complessità dei problemi, analisi, pensiero strategico.',
    '',
    '5. Condizioni lavorative (0-100): ambiente fisico, rischi, turni, trasferte.',
    '',
    'Job Family: ai ruoli IT/Tech è applicato un moltiplicatore di mercato (1.2x) al punteggio finale.',
    'Outliers: sono esclusi dal calcolo record con RAL < 15k o > 150k (eccezione: Manager/Dirigenti).',
    'La deviazione di banda è calcolata sulla mediana salariale (non sulla media) per robustezza statistica.',
    'Scostamenti superiori al ±5% richiedono un giustificativo documentato.',
  ]
  regText.forEach((line) => {
    doc.text(line, 14, y)
    y += 4.2
  })
  y += 4

  const head = [['Fascia', 'Ruolo', 'Livello', 'Family', 'Competenze', 'Resp.', 'Sforzo', 'Cond.', 'Totale', 'Mediana Retrib.', 'Scost. fascia', 'N', 'Giustificativo']]
  const body = jobResults.value.map((r) => [
    r.band,
    r.role || '–',
    r.level || '–',
    r.jobFamily || '–',
    r.competenze_richieste,
    r.responsabilita,
    r.sforzo_mentale,
    r.condizioni_lavorative,
    formatNum(r.totalScore),
    formatNum(r.medianTotalSalary),
    formatPct(r.deviationFromBandMedianPct),
    r.n,
    justifications.value[r.role] || '',
  ])

  doc.autoTable({
    startY: y,
    head,
    body,
    theme: 'grid',
    headStyles: { fillColor: [10, 108, 210], fontSize: 7.5, halign: 'center' },
    bodyStyles: { fontSize: 7.5 },
    columnStyles: {
      0: { halign: 'center', cellWidth: 14 },
      3: { halign: 'center' },
      4: { halign: 'center' },
      5: { halign: 'center' },
      6: { halign: 'center' },
      7: { halign: 'center', fontStyle: 'bold' },
      8: { halign: 'right' },
      9: { halign: 'right' },
      10: { halign: 'center', cellWidth: 10 },
      11: { cellWidth: 45 },
    },
    didParseCell(data) {
      if (data.section === 'body' && data.column.index === 9) {
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
        <!-- Analysis Settings Panel -->
        <div class="settings-panel">
          <h3 class="settings-title">Impostazioni Analisi</h3>

          <div class="settings-row">
            <label class="sr-label">Pesi fattori Job Grading</label>
            <p class="settings-hint">I pesi determinano l'importanza relativa di ogni fattore. La somma deve essere 100%.</p>
            <div class="weights-grid">
              <div class="weight-field">
                <label>Inquadramento Contrattuale</label>
                <div class="weight-input-wrap">
                  <input type="number" v-model.number="analysisSettings.weights.level" class="sr-input sr-input-sm" min="0" max="100" step="5" @change="clampWeight('level')" :disabled="analysisLoading" />
                  <span class="weight-pct">%</span>
                </div>
              </div>
              <div class="weight-field">
                <label>Competenze</label>
                <div class="weight-input-wrap">
                  <input type="number" v-model.number="analysisSettings.weights.skills" class="sr-input sr-input-sm" min="0" max="100" step="5" @change="clampWeight('skills')" :disabled="analysisLoading" />
                  <span class="weight-pct">%</span>
                </div>
              </div>
              <div class="weight-field">
                <label>Responsabilità</label>
                <div class="weight-input-wrap">
                  <input type="number" v-model.number="analysisSettings.weights.responsibility" class="sr-input sr-input-sm" min="0" max="100" step="5" @change="clampWeight('responsibility')" :disabled="analysisLoading" />
                  <span class="weight-pct">%</span>
                </div>
              </div>
              <div class="weight-field">
                <label>Sforzo mentale</label>
                <div class="weight-input-wrap">
                  <input type="number" v-model.number="analysisSettings.weights.mentalEffort" class="sr-input sr-input-sm" min="0" max="100" step="5" @change="clampWeight('mentalEffort')" :disabled="analysisLoading" />
                  <span class="weight-pct">%</span>
                </div>
              </div>
              <div class="weight-field">
                <label>Condizioni</label>
                <div class="weight-input-wrap">
                  <input type="number" v-model.number="analysisSettings.weights.conditions" class="sr-input sr-input-sm" min="0" max="100" step="5" @change="clampWeight('conditions')" :disabled="analysisLoading" />
                  <span class="weight-pct">%</span>
                </div>
              </div>
            </div>
            <p class="weights-total" :class="{ 'weights-error': !weightsValid }">
              Totale: {{ weightsTotal }}% <span v-if="!weightsValid">(deve essere 100%)</span>
            </p>
          </div>

          <div class="settings-row">
            <label class="sr-checkbox-row">
              <input type="checkbox" v-model="analysisSettings.filterOutliers" :disabled="analysisLoading" />
              <span>Filtro base (escludi record con RAL/Totale = 0, null o N/D)</span>
            </label>
          </div>

          <div class="settings-row">
            <label class="sr-checkbox-row">
              <input type="checkbox" v-model="analysisSettings.strictOutliers" :disabled="analysisLoading" />
              <span>Strict Outlier Removal (escludi RAL &lt; 15k o &gt; 150k, tranne Manager/Dirigenti)</span>
            </label>
          </div>

          <div class="settings-row">
            <label class="sr-label">Numero di bande</label>
            <p class="settings-hint">I ruoli verranno distribuiti equamente nel numero di bande specificato.</p>
            <input type="number" v-model.number="analysisSettings.bandCount" class="sr-input sr-input-sm" min="2" max="30" step="1" :disabled="analysisLoading" />
          </div>
        </div>

        <p v-if="uploadError" class="upload-error">{{ uploadError }}</p>
        <div class="mapping-actions">
          <button class="btn-secondary" :disabled="analysisLoading" @click="goToUpload">Indietro</button>
          <button class="btn-primary" :disabled="analysisLoading || !weightsValid" @click="confirmMapping">
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
          <p class="result-source">Evaluation: <strong>{{ jobSource === 'ai' ? 'Gemini NLP' : 'Local fallback' }}</strong></p>

          <!-- Inline weights editor -->
          <div class="weights-bar">
            <span class="weights-bar-label">Pesi:</span>
            <label class="wb-field">Livello <input type="number" v-model.number="analysisSettings.weights.level" class="wb-input" min="0" max="100" step="5" @change="clampWeight('level')" />%</label>
            <label class="wb-field">Skills <input type="number" v-model.number="analysisSettings.weights.skills" class="wb-input" min="0" max="100" step="5" @change="clampWeight('skills')" />%</label>
            <label class="wb-field">Resp. <input type="number" v-model.number="analysisSettings.weights.responsibility" class="wb-input" min="0" max="100" step="5" @change="clampWeight('responsibility')" />%</label>
            <label class="wb-field">Sforzo <input type="number" v-model.number="analysisSettings.weights.mentalEffort" class="wb-input" min="0" max="100" step="5" @change="clampWeight('mentalEffort')" />%</label>
            <label class="wb-field">Cond. <input type="number" v-model.number="analysisSettings.weights.conditions" class="wb-input" min="0" max="100" step="5" @change="clampWeight('conditions')" />%</label>
            <span class="wb-total" :class="{ 'weights-error': !weightsValid }">= {{ weightsTotal }}%</span>
            <button type="button" class="btn-sm btn-primary" :disabled="!weightsValid" @click.stop.prevent="recalcBandsAndDeviation">Ricalcola</button>
          </div>

          <div v-for="band in [...new Set(jobResults.map(r => r.band))].sort((a,b) => a-b)" :key="band" class="band-section">
            <h3 class="band-title" :class="scoreBadgeClass(band)">Band {{ band }}</h3>
            <div class="job-table">
              <div class="job-row header">
                <span>Role</span><span>Livello</span><span>Family</span><span>Skills</span><span>Resp.</span><span>Effort</span><span>Cond.</span><span>Total</span><span>Median Comp.</span><span>Band Dev.</span><span>N</span>
              </div>
              <template v-for="r in jobResults.filter(x => x.band === band)" :key="`${band}-${r.role}`">
                <div class="job-row clickable" @click="r.n > 1 ? toggleRoleExpand(r.role) : null" :class="{ expanded: expandedRoles.has(r.role), 'row-warning': Math.abs(r.deviationFromBandMedianPct) > 25 }">
                  <span>
                    <span v-if="r.n > 1" class="expand-icon">{{ expandedRoles.has(r.role) ? '▾' : '▸' }}</span>
                    {{ r.role }} <small v-if="r.level">({{ r.level }})</small>
                  </span>
                  <span>{{ formatNum(r.levelScore) }} <small v-if="r.level" class="level-tag">{{ r.level }}</small></span>
                  <span class="job-family-cell">{{ r.jobFamily }}<small v-if="r.jobFamilyMultiplier > 1" class="multiplier-badge">×{{ r.jobFamilyMultiplier }}</small></span>
                  <span><input type="number" class="score-input" v-model.number="r.competenze_richieste" @input="onScoreEdit(r)" @click.stop min="0" max="100" /></span>
                  <span><input type="number" class="score-input" v-model.number="r.responsabilita" @input="onScoreEdit(r)" @click.stop min="0" max="100" /></span>
                  <span><input type="number" class="score-input" v-model.number="r.sforzo_mentale" @input="onScoreEdit(r)" @click.stop min="0" max="100" /></span>
                  <span><input type="number" class="score-input" v-model.number="r.condizioni_lavorative" @input="onScoreEdit(r)" @click.stop min="0" max="100" /></span>
                  <span><strong>{{ formatNum(r.totalScore) }}</strong></span>
                  <span>{{ formatNum(r.medianTotalSalary) }}</span>
                  <span :class="{ 'gap-alert': isGapAlert(r.deviationFromBandMedianPct) }">
                    {{ formatPct(r.deviationFromBandMedianPct) }}
                    <button
                      v-if="isGapAlert(r.deviationFromBandMedianPct)"
                      class="btn-justify"
                      :class="{ 'has-note': justifications[r.role] }"
                      title="Add justification"
                      @click.stop="openJustify(r.role)"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>
                    </button>
                  </span>
                  <span>{{ r.n }}</span>
                </div>
                <div v-if="expandedRoles.has(r.role) && r.people && r.people.length > 1" class="people-detail">
                  <div class="people-header"><span>#</span><span>Employee</span><span>Base Salary</span><span>Variable Comp.</span><span>Total Comp.</span><span>Dev. from Role Avg.</span></div>
                  <div v-for="p in r.people" :key="p.index" class="people-row">
                    <span>{{ p.index }}</span><span>{{ p.name || '–' }}</span><span>{{ formatNum(p.baseSalary) }}</span><span>{{ formatNum(p.variableComponents) }}</span><span>{{ formatNum(p.totalSalary) }}</span>
                    <span :class="{ 'gap-alert': isGapAlert(p.deviationFromRoleAvgPct) }">{{ formatPct(p.deviationFromRoleAvgPct) }}</span>
                  </div>
                </div>
              </template>
            </div>
          </div>
          <div class="mapping-actions" style="margin-top: 1.5rem;">
            <button class="btn-primary" @click="exportJobGradingPdf">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="vertical-align: -3px; margin-right: 0.35rem;"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M12 18v-6M9 15l3 3 3-3"/></svg>
              Export PDF
            </button>
          </div>
        </div>
        <div v-else-if="resultsTab === 'pari_valore' && jobResults.length === 0" class="no-data-msg">
          Job grading data not available. Check that the Role, Level and Job Description columns are mapped.
        </div>

        <div class="mapping-actions">
          <button class="btn-secondary" @click="analisiStep = 'mapping'">Edit mapping</button>
          <button class="btn-primary" @click="startNuovaAnalisi">New analysis</button>
        </div>

        <!-- Modal giustificativo -->
        <div v-if="justifyingRole != null" class="justify-overlay" @click.self="cancelJustify">
          <div class="justify-modal">
            <h3>Giustificativo – {{ justifyingRole }}</h3>
            <p class="justify-hint">Inserisci un giustificativo per la deviazione retributiva superiore a ±5% dalla mediana di banda.</p>
            <textarea v-model="justifyText" class="justify-textarea" rows="5" placeholder="Motivo..." :disabled="justifyAiLoading"></textarea>
            <div class="justify-actions">
              <button v-if="geminiEnabled" type="button" class="btn-ai" :disabled="justifyAiLoading" @click="suggestJustify">
                <span v-if="justifyAiLoading" class="spinner-sm"></span>
                <span v-else>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="vertical-align:-2px;margin-right:4px"><path d="M12 2l2.09 6.26L20.18 9l-5.09 4.09L16.82 20 12 16.18 7.18 20l1.73-6.91L3.82 9l6.09-.74z"/></svg>
                  Suggerisci con AI
                </span>
              </button>
              <span style="flex:1"></span>
              <button class="btn-secondary" @click="cancelJustify">Annulla</button>
              <button class="btn-primary" @click="saveJustify" :disabled="justifyAiLoading">Salva</button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Storico analisi -->
    <template v-else-if="showStorico">
      <div class="analisi-content">
        <h2 class="analisi-title">Analysis History</h2>
        <p v-if="storicoLoading" class="storico-status">Loading history…</p>
        <p v-if="storicoError" class="upload-error">{{ storicoError }}</p>
        <div v-if="!storicoLoading && storicoList.length === 0 && !storicoError" class="storico-empty">
          No saved analyses.
        </div>
        <div v-if="storicoList.length > 0" class="storico-table-wrap">
          <table class="storico-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Source</th>
                <th>Calculation</th>
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
                    {{ storicoViewing === a.id ? '…' : 'View' }}
                  </button>
                  <button
                    class="btn-delete"
                    :disabled="storicoDeleting === a.id"
                    @click="removeAnalysis(a.id)"
                  >
                    {{ storicoDeleting === a.id ? '…' : 'Delete' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="mapping-actions">
          <button class="btn-secondary" @click="loadStorico">Refresh</button>
        </div>
      </div>
    </template>

    <!-- Salary Review -->
    <template v-else-if="showSalaryReview">

      <!-- CTA buttons + Sub-tab bar -->
      <div v-if="srView === 'list'" class="sr-top-bar">
        <div class="sr-cta-bar">
          <button class="btn-primary" @click="startCreateRule">+ Create Rule</button>
          <button class="btn-outline" @click="startCreateIncrease">+ Create Increase</button>
        </div>
        <div class="results-subtabs">
          <button class="subtab" :class="{ active: srSubTab === 'reviews' }" @click="srSubTab = 'reviews'">
            Salary Reviews
            <span v-if="eligibleReviews.filter(r => reviewStatus(r.name) === 'pending').length" class="sr-badge">{{ eligibleReviews.filter(r => reviewStatus(r.name) === 'pending').length }}</span>
          </button>
          <button class="subtab" :class="{ active: srSubTab === 'rules' }" @click="srSubTab = 'rules'">Rules</button>
        </div>
      </div>

      <!-- Vista lista -->
      <template v-if="srView === 'list'">

        <!-- Sub-tab: Rules -->
        <template v-if="srSubTab === 'rules'">
          <p v-if="srRulesError" class="upload-error">{{ srRulesError }}</p>

          <div class="sr-section">
            <p v-if="srRulesLoading" class="storico-status">Loading rules…</p>
            <div v-if="!srRulesLoading && srRules.length === 0 && !srRulesError" class="no-data-msg">No rules created.</div>
            <div class="sr-rules-grid">
              <article v-for="rule in srRules" :key="rule.id" class="sr-rule-card">
                <div class="sr-rule-header">
                  <h3>{{ rule.name || 'Unnamed rule' }}</h3>
                  <span class="sr-rule-year">{{ rule.year }}</span>
                </div>
                <div class="sr-rule-meta">
                  <span v-if="rule.applyToAll">All employees</span>
                  <span v-else>{{ (rule.eligibleUsers || []).length }} employee{{ (rule.eligibleUsers || []).length !== 1 ? 's' : '' }}</span>
                  <span>Trigger: {{ rule.triggerType === 'performance' ? 'Performance \u2265 ' + rule.performanceScore : (rule.objectives || []).length + ' objectives' }}</span>
                  <span>RAL +{{ rule.defaultRalPct }}% / Var +{{ rule.defaultVariablePct }}%</span>
                </div>
                <div class="sr-rule-meta">
                  <span>{{ (rule.approvalSteps || []).length }} approval step{{ (rule.approvalSteps || []).length !== 1 ? 's' : '' }}</span>
                </div>
                <div class="sr-rule-actions">
                  <button class="btn-secondary" @click="editRule(rule)">Edit</button>
                  <button class="btn-outline" @click="duplicateRule(rule)">Duplicate</button>
                  <button class="btn-delete" @click="removeRule(rule.id)">Delete</button>
                </div>
              </article>
            </div>
          </div>

          <div v-if="srIncreases.length > 0" class="sr-section">
            <h2 class="analisi-title">Increases</h2>
            <table class="storico-table">
              <thead>
                <tr><th>Employee</th><th>Base %</th><th>Variable %</th><th>Notes</th></tr>
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
            No eligible employees. Create a rule in the Rules tab to generate salary reviews.
          </div>
          <div v-else class="rv-list">
            <div class="rv-header">
              <span class="rv-col rv-col-name">NAME</span>
              <span class="rv-col rv-col-role">ROLE</span>
              <span class="rv-col rv-col-perf">PERFORMANCE</span>
              <span class="rv-col rv-col-increase">PROPOSED INCREASE</span>
              <span class="rv-col rv-col-rule">RULE</span>
              <span class="rv-col rv-col-status">STATUS</span>
              <span class="rv-col rv-col-actions">ACTIONS</span>
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
                  {{ reviewStatus(rv.name) === 'approved' ? 'Approved' : reviewStatus(rv.name) === 'rejected' ? 'Rejected' : reviewStatus(rv.name) === 'removed' ? 'Removed' : 'Pending' }}
                </span>
              </span>
              <span class="rv-col rv-col-actions" v-if="reviewStatus(rv.name) !== 'removed'">
                <button class="rv-action-btn rv-action-view" title="View" @click="viewReview(rv)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
                <button class="rv-action-btn rv-action-delete" title="Delete" @click="removeReview(rv.name)">
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
          <button class="btn-secondary" style="margin-bottom: 1rem;" @click="backToReviewsList">&larr; Back to list</button>
          <h2 class="analisi-title">{{ srViewingReview.name }}</h2>
          <p class="sr-rule-meta" style="margin-bottom: 1.25rem;">{{ srViewingReview.role }} &middot; Rule: {{ srViewingReview.ruleName }}</p>

          <div class="sr-review-grid">
            <div class="sr-review-card">
              <div class="sr-review-card-label">Performance</div>
              <div class="sr-review-card-value" :class="{ 'gap-alert': srViewingReview.performanceScore < 60 }">{{ srViewingReview.performanceScore }} <span class="sr-hint">/ 100</span></div>
            </div>
            <div class="sr-review-card">
              <div class="sr-review-card-label">Proposed Base Increase</div>
              <div class="sr-review-card-value">+{{ srViewingReview.proposedRalPct }}%</div>
            </div>
            <div class="sr-review-card">
              <div class="sr-review-card-label">Proposed Variable Increase</div>
              <div class="sr-review-card-value">+{{ srViewingReview.proposedVariablePct }}%</div>
            </div>
          </div>

          <div class="sr-form-section">
            <label class="sr-label">Objectives</label>
            <div class="sr-obj-list">
              <div v-for="obj in srViewingReview.objectives" :key="obj" class="sr-obj-item">
                <span class="sr-obj-check" :class="{ reached: (srViewingReview.objectivesReached || []).includes(obj) }">
                  {{ (srViewingReview.objectivesReached || []).includes(obj) ? '&#10003;' : '&#10007;' }}
                </span>
                <span>{{ obj }}</span>
              </div>
              <div v-if="!srViewingReview.objectives || srViewingReview.objectives.length === 0" class="sr-hint">No objectives defined</div>
            </div>
          </div>

          <div class="sr-form-section">
            <label class="sr-label">Current status: <span class="sr-status" :class="'sr-status-' + reviewStatus(srViewingReview.name)">{{ reviewStatus(srViewingReview.name) === 'approved' ? 'Approved' : reviewStatus(srViewingReview.name) === 'rejected' ? 'Rejected' : 'Pending' }}</span></label>
          </div>

          <div class="mapping-actions">
            <button class="btn-delete" style="padding: 0.65rem 1.25rem; font-size: 0.85rem;" @click="rejectReview(srViewingReview.name)">Reject</button>
            <button class="btn-primary" @click="approveReview(srViewingReview.name)">Approve</button>
          </div>
        </div>
      </template>

      <!-- Pannello crea/modifica regola -->
      <template v-if="srView === 'editRule' && srCurrentRule">
        <div class="sr-form">
          <h2 class="analisi-title">{{ srRules.some(r => r.id === srCurrentRule.id) ? 'Edit Rule' : 'New Rule' }}</h2>

          <div class="sr-form-section">
            <label class="sr-label">Rule Name</label>
            <input v-model="srCurrentRule.name" type="text" class="sr-input" placeholder="E.g. Annual Review 2026" />
          </div>

          <div class="sr-form-section">
            <label class="sr-label">Eligibility</label>
            <label class="sr-checkbox-row">
              <input type="checkbox" v-model="srCurrentRule.applyToAll" />
              <span>Apply to all employees</span>
            </label>
            <div v-if="!srCurrentRule.applyToAll" class="multi-select-wrap">
              <div class="multi-select-box" @click="srEligibilityDropdownOpen = !srEligibilityDropdownOpen">
                <div class="multi-select-pills">
                  <span v-for="(u, i) in srCurrentRule.eligibleUsers" :key="i" class="pill">
                    {{ u }}
                    <button type="button" class="pill-x" @click.stop="removePill(srCurrentRule.eligibleUsers, i)">&times;</button>
                  </span>
                  <span v-if="srCurrentRule.eligibleUsers.length === 0" class="multi-select-placeholder">Select employees...</span>
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
            <label class="sr-label">Reference Year</label>
            <input v-model.number="srCurrentRule.year" type="number" class="sr-input sr-input-sm" min="2020" max="2040" />
          </div>

          <div class="sr-form-section">
            <label class="sr-label">Trigger</label>
            <div class="sr-radio-group">
              <label class="sr-radio-row">
                <input type="radio" v-model="srCurrentRule.triggerType" value="performance" />
                <span>Minimum performance score</span>
              </label>
              <div v-if="srCurrentRule.triggerType === 'performance'" class="sr-indent">
                <input v-model.number="srCurrentRule.performanceScore" type="number" class="sr-input sr-input-sm" min="0" max="100" />
                <span class="sr-hint">/ 100</span>
              </div>
              <label class="sr-radio-row">
                <input type="radio" v-model="srCurrentRule.triggerType" value="objectives" />
                <span>Specific objectives achieved</span>
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
                    placeholder="Add objective and press Enter"
                    @keydown.enter.prevent="addPill(srCurrentRule.objectives, srObjInput); srObjInput = '';"
                  />
                </div>
              </div>
            </div>
          </div>

          <div class="sr-form-section">
            <label class="sr-label">Approval Workflow</label>
            <div class="wf-steps">
              <div v-for="(step, si) in srCurrentRule.approvalSteps" :key="si" class="wf-step">
                <div class="wf-step-header">
                  <span class="wf-step-num">{{ si + 1 }}</span>
                  <select v-model="step.type" class="sr-select">
                    <option value="manager">Direct Manager</option>
                    <option value="users">Specific Users</option>
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
                      <span v-if="step.users.length === 0" class="multi-select-placeholder">Select approvers...</span>
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
            <button type="button" class="btn-outline sr-add-step" @click="addApprovalStep">+ Add step</button>
          </div>

          <div class="sr-form-section">
            <label class="sr-label">Default Increase</label>
            <div class="sr-pct-row">
              <div class="sr-pct-field">
                <label>% Base</label>
                <input v-model.number="srCurrentRule.defaultRalPct" type="number" class="sr-input sr-input-sm" min="0" step="0.5" />
              </div>
              <div class="sr-pct-field">
                <label>% Variable</label>
                <input v-model.number="srCurrentRule.defaultVariablePct" type="number" class="sr-input sr-input-sm" min="0" step="0.5" />
              </div>
            </div>
          </div>

          <p v-if="srRulesError" class="upload-error">{{ srRulesError }}</p>
          <div class="mapping-actions">
            <button class="btn-secondary" :disabled="srSaving" @click="cancelRuleEdit">Cancel</button>
            <button class="btn-primary" :disabled="srSaving" @click="saveCurrentRule">
              {{ srSaving ? 'Saving…' : 'Save Rule' }}
            </button>
          </div>
        </div>
      </template>

      <!-- Form crea aumento -->
      <template v-if="srView === 'newIncrease' && srCurrentIncrease">
        <div class="sr-form">
          <h2 class="analisi-title">New Increase</h2>

          <div class="sr-form-section">
            <label class="sr-label">Employee</label>
            <select v-model="srCurrentIncrease.employee" class="sr-select">
              <option value="" disabled>Select employee...</option>
              <option v-for="u in sampleUsers" :key="u" :value="u">{{ u }}</option>
            </select>
          </div>

          <div class="sr-form-section">
            <div class="sr-pct-row">
              <div class="sr-pct-field">
                <label>Base Increase %</label>
                <input v-model.number="srCurrentIncrease.ralPct" type="number" class="sr-input sr-input-sm" min="0" step="0.5" />
              </div>
              <div class="sr-pct-field">
                <label>Variable Increase %</label>
                <input v-model.number="srCurrentIncrease.variablePct" type="number" class="sr-input sr-input-sm" min="0" step="0.5" />
              </div>
            </div>
          </div>

          <div class="sr-form-section">
            <label class="sr-label">Notes</label>
            <textarea v-model="srCurrentIncrease.notes" class="justify-textarea" rows="3" placeholder="Reason or details..."></textarea>
          </div>

          <div class="mapping-actions">
            <button class="btn-secondary" @click="cancelIncreaseEdit">Cancel</button>
            <button class="btn-primary" @click="saveCurrentIncrease">Save Increase</button>
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
  grid-template-columns: 2fr 0.6fr 1fr repeat(4, 0.7fr) 0.8fr 1.1fr 0.9fr 0.5fr;
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
</style>
