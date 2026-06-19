/**
 * Payload per comunicazione retributiva individuale (diritto di informazione).
 * Metrica fissa: livello retributivo normalizzato FTE; medie da stesso livello CCNL.
 */
import { SALARY_METRICS, getComparisonValue, MIN_GENDER_SAMPLE } from './salaryMetrics.js'
import { mean } from './indicators.js'
import { sanitizeText } from './gapReportFormat.js'

export const PAY_COMMUNICATION_VERSION = '1.0.0'

export const PAY_COMM_PRIVACY_NOTE =
  'Dato non disponibile per tutela della riservatezza (numerosità insufficiente)'

export const DEFAULT_PAY_CRITERIA_TEXT =
  'La retribuzione è determinata in applicazione del CCNL di riferimento, in base al livello di inquadramento contrattuale, all\'anzianità di servizio e agli scatti di anzianità previsti dal contratto. Eventuali elementi aggiuntivi retributivi sono attribuiti secondo i criteri contrattuali e le procedure interne adottate dall\'azienda in conformità al CCNL applicato.'

export const PAY_COMM_METRIC_DECLARATION =
  'Valori espressi come livello retributivo (elementi continuativi e fissi, esclusi i trattamenti individuali non strutturali), normalizzati full-time equivalent (FTE).'

function getLivelloFte(person) {
  return getComparisonValue(person, SALARY_METRICS.livello, { fte: true })
}

function deviationPct(employee, reference) {
  if (
    employee == null ||
    reference == null ||
    !Number.isFinite(employee) ||
    !Number.isFinite(reference) ||
    reference <= 0
  ) {
    return null
  }
  return ((employee - reference) / reference) * 100
}

export function positionTextFromDeviation(pct) {
  if (pct == null || !Number.isFinite(pct)) return '–'
  const sign = pct >= 0 ? '+' : ''
  const abs = Math.abs(pct).toFixed(1)
  if (Math.abs(pct) < 0.05) {
    return `In linea con la media di riferimento (scostamento ${sign}${pct.toFixed(1)}%)`
  }
  if (pct > 0) return `Sopra la media di riferimento del ${abs}%`
  return `Sotto la media di riferimento del ${abs}%`
}

function buildPositioning(reference, avg, employeeSalary) {
  const dev = deviationPct(employeeSalary, avg)
  return {
    reference,
    avg,
    deviationPct: dev,
    positionText: positionTextFromDeviation(dev),
  }
}

/**
 * @param {{
 *   person: object,
 *   levelRow?: object|null,
 *   companyName?: string,
 *   referencePeriod?: string,
 *   criteriaText?: string,
 *   minSample?: number,
 *   generatedAt?: Date,
 * }} input
 */
export function buildPayCommunicationPayload({
  person,
  levelRow = null,
  companyName = '',
  referencePeriod = '',
  criteriaText = '',
  minSample = MIN_GENDER_SAMPLE,
  generatedAt = new Date(),
}) {
  if (!person) throw new Error('Dipendente non specificato')

  const getSalary = getLivelloFte
  const employeeSalary = getSalary(person)
  if (employeeSalary == null) {
    throw new Error(
      'Retribuzione non disponibile per il livello retributivo normalizzato FTE del dipendente',
    )
  }

  const ccnlLabel =
    levelRow?.ccnlLabel || String(person.ccnl ?? '').trim() || 'N/D'
  const levelLabel =
    levelRow?.levelLabel || levelRow?.levelKey || String(person.level ?? '').trim() || 'N/D'

  const peers = levelRow?.people || []
  const withSal = peers.filter(
    (p) => (p.gender === 'M' || p.gender === 'F') && getSalary(p) != null,
  )
  const nM = withSal.filter((p) => p.gender === 'M').length
  const nF = withSal.filter((p) => p.gender === 'F').length
  const avgOverall = withSal.length ? mean(withSal.map(getSalary)) : null

  const showM = nM >= minSample
  const showF = nF >= minSample
  const requesterGender = person.gender
  const requesterGenderUnderThreshold =
    (requesterGender === 'M' && !showM) || (requesterGender === 'F' && !showF)
  const showDisaggregated = !requesterGenderUnderThreshold

  const avgM = showDisaggregated && showM ? (levelRow?.avgM ?? null) : null
  const avgF = showDisaggregated && showF ? (levelRow?.avgF ?? null) : null
  const suppressedM = showDisaggregated && !showM
  const suppressedF = showDisaggregated && !showF

  const positioning = {}
  if (showDisaggregated) {
    if (requesterGender === 'M' && avgM != null) {
      positioning.vsOwnGender = buildPositioning(
        'Media uomini (stesso livello CCNL)',
        avgM,
        employeeSalary,
      )
    } else if (requesterGender === 'F' && avgF != null) {
      positioning.vsOwnGender = buildPositioning(
        'Media donne (stesso livello CCNL)',
        avgF,
        employeeSalary,
      )
    }
    if (requesterGender === 'M' && avgF != null) {
      positioning.vsOtherGender = buildPositioning(
        'Media donne (stesso livello CCNL)',
        avgF,
        employeeSalary,
      )
    } else if (requesterGender === 'F' && avgM != null) {
      positioning.vsOtherGender = buildPositioning(
        'Media uomini (stesso livello CCNL)',
        avgM,
        employeeSalary,
      )
    }
  } else if (avgOverall != null) {
    positioning.vsOverall = {
      ...buildPositioning(
        'Media complessiva di categoria (stesso livello CCNL)',
        avgOverall,
        employeeSalary,
      ),
      privacyNote: PAY_COMM_PRIVACY_NOTE,
    }
  }

  const partTimePct =
    person.partTimePct != null && person.partTimePct < 100 ? person.partTimePct : null
  const partTimeRaw =
    partTimePct != null
      ? getComparisonValue(person, SALARY_METRICS.livello, { fte: false })
      : null

  return {
    version: PAY_COMMUNICATION_VERSION,
    companyName: companyName.trim() || 'Azienda',
    referencePeriod: referencePeriod.trim() || `Anno ${generatedAt.getFullYear()}`,
    generatedAtIso: generatedAt.toISOString(),
    generatedAtLabel: generatedAt.toLocaleString('it-IT'),
    metricDeclaration: PAY_COMM_METRIC_DECLARATION,
    criteriaText: sanitizeText(criteriaText, 8000) || DEFAULT_PAY_CRITERIA_TEXT,
    minSample,
    employee: {
      index: person.index,
      name: person.name && String(person.name).trim() ? String(person.name).trim() : `#${person.index}`,
      gender: person.gender,
      levelLabel,
      ccnlLabel,
      seniority: person.seniority ?? null,
      partTimePct,
      partTimeRawSalary: partTimeRaw,
      salaryFte: employeeSalary,
    },
    category: {
      ccnlLabel,
      levelLabel,
      nTotal: withSal.length,
      nM,
      nF,
      showDisaggregated,
      avgM: suppressedM ? null : avgM,
      avgF: suppressedF ? null : avgF,
      avgOverall,
      suppressedM,
      suppressedF,
      privacyNote: PAY_COMM_PRIVACY_NOTE,
    },
    positioning,
  }
}
