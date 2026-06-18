import { EU_GAP_THRESHOLD_PCT } from './salaryMetrics.js'
import { sanitizeText } from './gapReportFormat.js'

export const GAP_REPORT_VERSION = '1.0.0'

/**
 * Raccoglie giustificativi testuali per le persone di un gruppo.
 */
export function collectPersonJustifications(people, personJustifications = {}) {
  const parts = []
  for (const p of people || []) {
    const key = String(p?.index ?? '')
    const text = sanitizeText(personJustifications[key])
    if (!text) continue
    const name = p?.name && String(p.name).trim() ? String(p.name).trim() : `#${key}`
    parts.push(`${name}: ${text}`)
  }
  return parts.join('\n\n')
}

/**
 * Gruppi con |gap| oltre soglia e campione sufficiente (per sezione difendibilità).
 */
export function buildGroupsAboveThreshold({
  ccnlRows = [],
  thresholdPct = EU_GAP_THRESHOLD_PCT,
}) {
  return (ccnlRows || [])
    .filter(
      (r) =>
        !r.insufficientSample &&
        r.gapMean != null &&
        Number.isFinite(r.gapMean) &&
        Math.abs(r.gapMean) > thresholdPct,
    )
    .map((r) => ({
      groupType: 'Livello CCNL',
      label: r.levelLabel || r.levelKey,
      gapMean: r.gapMean,
      gapMedian: r.gapMedian,
      status: r.status,
      hasJustification: !!r.hasJustification,
      justificationText: collectPersonJustifications(r.people, r._personJustifications),
      nM: r.nM,
      nF: r.nF,
      nTotal: r.nTotal,
    }))
    .sort((a, b) => Math.abs(b.gapMean) - Math.abs(a.gapMean))
}

/** Top esposizione per sintesi esecutiva (livelli CCNL). */
export function buildExposureHotspots(ccnlRows = [], topN = 5) {
  return (ccnlRows || [])
    .filter((r) => !r.insufficientSample && r.gapMean != null && Number.isFinite(r.gapMean))
    .sort((a, b) => Math.abs(b.gapMean) - Math.abs(a.gapMean))
    .slice(0, topN)
    .map((r, i) => ({
      rank: i + 1,
      label: r.levelLabel || r.levelKey,
      gapMean: r.gapMean,
      status: r.status,
      nTotal: r.nTotal,
    }))
}

export function summarizeGroupCounts(groupsAbove = []) {
  const documented = groupsAbove.filter((g) => g.hasJustification).length
  const undocumented = groupsAbove.filter((g) => !g.hasJustification).length
  return {
    total: groupsAbove.length,
    documented,
    undocumented,
  }
}

/**
 * Arricchisce righe CCNL con map giustificativi per buildGroupsAboveThreshold.
 */
export function attachJustificationsToRows(rows, personJustifications) {
  return (rows || []).map((r) => ({
    ...r,
    _personJustifications: personJustifications,
  }))
}
