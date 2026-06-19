/**
 * Generazione PDF "Report analisi divario retributivo" (server-side, testo selezionabile).
 */
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { GAP_REPORT_VERSION } from './gapReportPayload.js'
import { fmtNum, fmtEuro, fmtPct, fmtGapSigned, statusLabel, sanitizeText } from './gapReportFormat.js'
import { MIN_GENDER_SAMPLE, EU_GAP_THRESHOLD_PCT } from './salaryMetrics.js'

const MARGIN = 14
const FOOTER_Y_OFFSET = 8

function ensureSpace(doc, y, needed, top = 20) {
  const pageHeight = doc.internal.pageSize.getHeight()
  if (y + needed > pageHeight - 18) {
    doc.addPage()
    return top
  }
  return y
}

function drawPageChrome(doc, payload) {
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const page = doc.internal.getNumberOfPages()
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(80, 80, 80)
  const company = payload.companyName || 'Azienda'
  const period = payload.referencePeriod || '–'
  doc.text(`${company} · ${period}`, MARGIN, 10)
  doc.text(`Generato: ${payload.generatedAtLabel || '–'}`, pageWidth - MARGIN, 10, { align: 'right' })
  doc.text(`Pag. ${page}`, pageWidth / 2, pageHeight - FOOTER_Y_OFFSET, { align: 'center' })
  doc.text(`Report v${payload.version || GAP_REPORT_VERSION}`, MARGIN, pageHeight - FOOTER_Y_OFFSET)
  doc.setTextColor(0, 0, 0)
}

function sectionTitle(doc, y, title) {
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.text(title, MARGIN, y)
  return y + 6
}

function bodyText(doc, y, text, maxWidth) {
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  const lines = doc.splitTextToSize(text, maxWidth)
  doc.text(lines, MARGIN, y)
  return y + lines.length * 4.2 + 2
}

const TABLE = {
  theme: 'grid',
  headStyles: { fillColor: [45, 55, 72], fontSize: 8, halign: 'center' },
  bodyStyles: { fontSize: 8, overflow: 'linebreak' },
  margin: { left: MARGIN, right: MARGIN },
}

function addTable(doc, startY, head, body, columnStyles = {}) {
  autoTable(doc, {
    ...TABLE,
    startY,
    head,
    body,
    columnStyles,
  })
  return doc.lastAutoTable.finalY + 8
}

function drawCover(doc, payload) {
  const pageWidth = doc.internal.pageSize.getWidth()
  let y = 48
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.text('Report di analisi del divario retributivo di genere', pageWidth / 2, y, { align: 'center' })
  y += 10
  doc.setFontSize(11)
  doc.setFont('helvetica', 'normal')
  doc.text('documento di supporto alla reportistica e alla documentazione interna', pageWidth / 2, y, {
    align: 'center',
  })
  y += 22
  doc.setFontSize(10)
  const lines = [
    ['Ragione sociale', payload.companyName || '–'],
    ['CCNL di riferimento', payload.ccnlName || '–'],
    ['Periodo di riferimento', payload.referencePeriod || '–'],
    ['Data generazione', payload.generatedAtLabel || '–'],
    ['Dipendenti analizzati (M/F)', String(payload.nEmployees ?? '–')],
    ['Metrica retributiva', payload.metricLabel || '–'],
    ['Normalizzazione part-time', payload.fte ? 'Sì (full-time equivalent)' : 'No (valori annui grezzi)'],
    ['Versione calcolo', payload.version || GAP_REPORT_VERSION],
  ]
  for (const [label, val] of lines) {
    doc.setFont('helvetica', 'bold')
    doc.text(`${label}:`, MARGIN + 20, y)
    doc.setFont('helvetica', 'normal')
    doc.text(String(val), MARGIN + 72, y)
    y += 7
  }
  y += 8
  doc.setFont('helvetica', 'italic')
  doc.setFontSize(9)
  const note = payload.methodNote || ''
  const noteLines = doc.splitTextToSize(note, pageWidth - MARGIN * 2)
  doc.text(noteLines, MARGIN, y)
  drawPageChrome(doc, payload)
}

function drawExecutiveSummary(doc, payload, startY) {
  let y = sectionTitle(doc, startY, '2. Sintesi esecutiva')
  const s = payload.executiveSummary || {}
  const gc = s.groupCounts || {}
  const bullets = [
    `Gap medio aziendale: ${fmtGapSigned(s.gapMean)} · Gap mediano: ${fmtGapSigned(s.gapMedian)}`,
    `Gap medio su componente variabile: ${fmtGapSigned(s.gapVarMean)} · Gap mediano variabile: ${fmtGapSigned(s.gapVarMedian)}`,
    `Percettori componente variabile — Uomini: ${fmtPct(s.pctMenWithVar)} · Donne: ${fmtPct(s.pctWomenWithVar)}`,
    `Gruppi (livello CCNL) oltre soglia ${EU_GAP_THRESHOLD_PCT}%: ${gc.total ?? 0} (documentati: ${gc.documented ?? 0}, da documentare: ${gc.undocumented ?? 0})`,
  ]
  for (const b of bullets) {
    y = bodyText(doc, y, `• ${b}`, doc.internal.pageSize.getWidth() - MARGIN * 2)
  }
  y += 2
  y = bodyText(doc, y, 'Punti di maggiore esposizione (|gap| per livello CCNL, campione sufficiente):', doc.internal.pageSize.getWidth() - MARGIN * 2)
  const hotspots = s.hotspots || []
  if (!hotspots.length) {
    y = bodyText(doc, y, 'Nessun livello con gap calcolabile.', doc.internal.pageSize.getWidth() - MARGIN * 2)
  } else {
    for (const h of hotspots) {
      y = bodyText(
        doc,
        y,
        `#${h.rank} ${h.label}: ${fmtGapSigned(h.gapMean, { short: true })} (${statusLabel(h.status)}) — N=${h.nTotal}`,
        doc.internal.pageSize.getWidth() - MARGIN * 2,
      )
    }
  }
  return y + 4
}

/**
 * @param {object} payload — snapshot serializzabile dall'analisi corrente
 * @returns {Uint8Array}
 */
export function buildGapReportPdfBuffer(payload) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()

  drawCover(doc, payload)
  doc.addPage()

  let y = 20
  y = drawExecutiveSummary(doc, payload, y)
  y = ensureSpace(doc, y, 40)

  // 3. CCNL
  y = sectionTitle(doc, y, '3. Reporting per livello CCNL (vista analitica per inquadramento contrattuale)')
  y = bodyText(
    doc,
    y,
    'Confronto M/F per CCNL e livello di inquadramento contrattuale. I campioni con meno di 3 persone per genere sono segnalati e non considerati ai fini delle soglie.',
    pageWidth - MARGIN * 2,
  )
  const ccnlRows = payload.ccnlLevels || []
  const multiCcnlPdf = new Set(ccnlRows.map((r) => r.ccnlKey).filter(Boolean)).size > 1
  const ccnlBody = ccnlRows.map((r) => {
    const base = [
      r.nTotal ?? 0,
      r.nM ?? 0,
      r.nF ?? 0,
      r.insufficientSample ? 'n/d' : fmtEuro(r.avgM),
      r.insufficientSample ? 'n/d' : fmtEuro(r.avgF),
      r.insufficientSample ? 'n/d' : fmtGapSigned(r.gapMean, { short: true }),
      r.insufficientSample ? 'n/d' : fmtGapSigned(r.gapMedian, { short: true }),
      statusLabel(r.status, r.insufficientSample),
    ]
    if (multiCcnlPdf) {
      return [r.ccnlLabel || '–', r.displayLevelLabel || r.levelLabel || '–', ...base]
    }
    return [r.displayLevelLabel || r.levelLabel || '–', ...base]
  })
  const ccnlHead = multiCcnlPdf
    ? [['CCNL', 'Livello', 'N', 'N M', 'N F', 'Media M', 'Media F', 'Gap medio', 'Gap mediano', 'Stato']]
    : [['Livello', 'N', 'N M', 'N F', 'Media M', 'Media F', 'Gap medio', 'Gap mediano', 'Stato']]
  y = addTable(
    doc,
    y,
    ccnlHead,
    ccnlBody.length ? ccnlBody : [multiCcnlPdf ? ['–', '–', '–', '–', '–', '–', '–', '–', '–', '–'] : ['–', '–', '–', '–', '–', '–', '–', '–', '–']],
    multiCcnlPdf ? { 0: { cellWidth: 24 }, 1: { cellWidth: 18 }, 9: { cellWidth: 24 } } : { 0: { cellWidth: 22 }, 8: { cellWidth: 28 } },
  )

  // 4. Quartili
  y = ensureSpace(doc, y, 30)
  y = sectionTitle(doc, y, '4. Quartili retributivi')
  const qBody = (payload.quartiles || []).map((q) => [
    `Q${q.quartile}`,
    q.totale ?? 0,
    q.maschile ?? 0,
    q.pctOfTotalM != null ? fmtPct(q.pctOfTotalM) : 'n/d',
    q.femminile ?? 0,
    q.pctOfTotalF != null ? fmtPct(q.pctOfTotalF) : 'n/d',
    q.avgMaschile != null ? fmtEuro(q.avgMaschile) : 'n/d',
    q.avgFemminile != null ? fmtEuro(q.avgFemminile) : 'n/d',
    q.gapPct != null ? fmtGapSigned(q.gapPct, { short: true }) : 'n/d',
  ])
  y = addTable(
    doc,
    y,
    [['Q', 'N tot.', 'N M', '% M su tot.', 'N F', '% F su tot.', 'Media M', 'Media F', 'Gap M/F']],
    qBody.length ? qBody : [['–', '–', '–', '–', '–', '–', '–', '–', '–']],
    {},
  )

  // 5. Differenziali e giustificazioni
  y = ensureSpace(doc, y, 30)
  y = sectionTitle(doc, y, '5. Differenziali oltre soglia e giustificazioni')
  y = bodyText(
    doc,
    y,
    `Gruppi di livello CCNL con |gap| superiore al ${EU_GAP_THRESHOLD_PCT}% e campione sufficiente. I gruppi senza testo di giustificativo sono elencati come «da documentare».`,
    pageWidth - MARGIN * 2,
  )
  const groups = payload.groupsAboveThreshold || []
  const gBody = groups.map((g) => [
    g.groupType || 'Livello CCNL',
    g.label || '–',
    fmtGapSigned(g.gapMean, { short: true }),
    fmtGapSigned(g.gapMedian, { short: true }),
    g.hasJustification ? 'Documentato' : 'Da documentare',
    g.hasJustification ? sanitizeText(g.justificationText, 800) : '—',
  ])
  if (!gBody.length) {
    y = bodyText(doc, y, 'Nessun gruppo oltre soglia con campione sufficiente.', pageWidth - MARGIN * 2)
  } else {
    y = addTable(
      doc,
      y,
      [['Tipo', 'Gruppo', 'Gap medio', 'Gap mediano', 'Stato doc.', 'Giustificativo']],
      gBody,
      { 5: { cellWidth: 'auto' } },
    )
  }

  // 6. Integrative
  const integ = payload.integrative || {}
  if (integ.includeFascia || integ.includeCostCenter) {
    y = ensureSpace(doc, y, 24)
    y = sectionTitle(doc, y, '6. Analisi integrative (non normative)')
    y = bodyText(
      doc,
      y,
      'Analisi organizzativa interna — non costituisce reporting normativo. Uso gestionale/diagnostico.',
      pageWidth - MARGIN * 2,
    )

    if (integ.includeFascia && (integ.fasciaRows || []).length) {
      y = ensureSpace(doc, y, 20)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(10)
      doc.text('Per fascia di grading (integrativa)', MARGIN, y)
      y += 5
      const fBody = integ.fasciaRows.map((r) => [
        r.levelLabel || '–',
        r.fasciaLabel || r.fasciaId || '–',
        r.nM ?? 0,
        r.nF ?? 0,
        r.insufficientSample ? 'n/d' : fmtGapSigned(r.gapMean, { short: true }),
        statusLabel(r.status, r.insufficientSample),
      ])
      y = addTable(
        doc,
        y,
        [['Livello', 'Fascia', 'N M', 'N F', 'Gap', 'Stato']],
        fBody,
        {},
      )
    }

    if (integ.includeCostCenter && (integ.costCenterRows || []).length) {
      y = ensureSpace(doc, y, 20)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(10)
      doc.text('Per centro di costo (integrativa)', MARGIN, y)
      y += 5
      if ((integ.costCenterHotspots || []).length) {
        y = bodyText(doc, y, 'Dove si concentra il gap (top centri di costo):', pageWidth - MARGIN * 2)
        for (const h of integ.costCenterHotspots) {
          y = bodyText(
            doc,
            y,
            `#${h.rank} ${h.groupLabel}: ${fmtGapSigned(h.gapMean, { short: true })} — peso ${fmtPct(h.headcountWeightPct)} (N=${h.nTotal})`,
            pageWidth - MARGIN * 2,
          )
        }
      }
      const cBody = integ.costCenterRows.map((r) => [
        r.costCenterLabel || r.groupLabel || '–',
        r.nTotal ?? 0,
        r.nM ?? 0,
        r.nF ?? 0,
        r.insufficientSample ? 'n/d' : fmtGapSigned(r.gapMean, { short: true }),
        statusLabel(r.status, r.insufficientSample),
      ])
      y = addTable(
        doc,
        y,
        [['Centro di costo', 'N', 'N M', 'N F', 'Gap medio', 'Stato']],
        cBody,
        {},
      )
    }
  }

  // 7. Appendice
  doc.addPage()
  y = 20
  y = sectionTitle(doc, y, '7. Appendice metodologica')
  const appendix = [
    `Retribuzione base: importo tabellare/fisso annuo.`,
    `Livello retributivo: base + componenti strutturali continuative/fisse (escluse voci individuali/discrezionali non strutturali).`,
    `Retribuzione totale: base + strutturali + individuali (analisi interna).`,
    `Normalizzazione FTE: valore / (% part-time / 100) per confronti equi tra full-time e part-time.`,
    `Soglia indicativa gap: ${EU_GAP_THRESHOLD_PCT}% (|gap| medio M vs F).`,
    `Campione minimo per gruppo: ${MIN_GENDER_SAMPLE} persone per genere.`,
    `Stati: OK (|gap| ≤ soglia); Da verificare (oltre soglia con giustificativo); Da correggere (oltre soglia senza giustificativo); Campione insufficiente.`,
    `Esclusioni analisi: dipendenti con giustificativo outlier quartile esclusi dai calcoli gap (se registrato).`,
    `Timestamp calcolo: ${payload.generatedAtIso || '–'}. Versione report: ${payload.version || GAP_REPORT_VERSION}.`,
  ]
  for (const line of appendix) {
    y = bodyText(doc, y, `• ${line}`, pageWidth - MARGIN * 2)
  }
  drawPageChrome(doc, payload)

  const totalPages = doc.internal.getNumberOfPages()
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p)
    drawPageChrome(doc, payload)
  }

  return doc.output('arraybuffer')
}

export function buildGapReportPdfBase64(payload) {
  const buf = buildGapReportPdfBuffer(payload)
  return Buffer.from(buf).toString('base64')
}
