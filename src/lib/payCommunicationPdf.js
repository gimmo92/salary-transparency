/**
 * PDF comunicazione retributiva individuale (server-side, testo selezionabile).
 */
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { PAY_COMMUNICATION_VERSION } from './payCommunicationPayload.js'
import { fmtEuro, fmtPct, sanitizeText } from './gapReportFormat.js'

const MARGIN = 14
const FOOTER_Y_OFFSET = 8

function ensureSpace(doc, y, needed, top = 22) {
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
  const emp = payload.employee || {}

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(80, 80, 80)
  doc.text(`${payload.companyName || 'Azienda'} · ${emp.name || '–'}`, MARGIN, 10)
  doc.text(`Generato: ${payload.generatedAtLabel || '–'}`, pageWidth - MARGIN, 10, {
    align: 'right',
  })
  doc.text(`Pag. ${page}`, pageWidth / 2, pageHeight - FOOTER_Y_OFFSET, { align: 'center' })
  doc.text(
    `Comunicazione v${payload.version || PAY_COMMUNICATION_VERSION} · ${payload.generatedAtIso || '–'}`,
    MARGIN,
    pageHeight - FOOTER_Y_OFFSET,
  )
  doc.setTextColor(0, 0, 0)
}

function sectionTitle(doc, y, title) {
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
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
  headStyles: { fillColor: [45, 55, 72], fontSize: 8, halign: 'left' },
  bodyStyles: { fontSize: 8.5, overflow: 'linebreak' },
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

function drawHeader(doc, payload) {
  const pageWidth = doc.internal.pageSize.getWidth()
  let y = 22
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text('Comunicazione retributiva', pageWidth / 2, y, { align: 'center' })
  y += 8
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9.5)
  doc.text('Risposta al diritto di informazione retributiva', pageWidth / 2, y, {
    align: 'center',
  })
  y += 14

  const emp = payload.employee || {}
  const rows = [
    ['Ragione sociale datore di lavoro', payload.companyName || '–'],
    ['Data di generazione', payload.generatedAtLabel || '–'],
    ['Richiedente', emp.name || '–'],
    ['Livello di inquadramento CCNL', emp.levelLabel || '–'],
    ['CCNL applicato', emp.ccnlLabel || '–'],
    ['Periodo di riferimento dati', payload.referencePeriod || '–'],
  ]
  for (const [label, val] of rows) {
    doc.setFont('helvetica', 'bold')
    doc.text(`${label}:`, MARGIN, y)
    doc.setFont('helvetica', 'normal')
    doc.text(String(val), MARGIN + 68, y)
    y += 6.5
  }

  y += 4
  doc.setFont('helvetica', 'italic')
  doc.setFontSize(8.5)
  y = bodyText(doc, y, payload.metricDeclaration || '', pageWidth - MARGIN * 2)
  return y + 4
}

function drawSection1(doc, payload, startY) {
  const pageWidth = doc.internal.pageSize.getWidth()
  let y = ensureSpace(doc, startY, 40)
  y = sectionTitle(doc, y, '1. Retribuzione del richiedente')

  const emp = payload.employee || {}
  const body = [['Livello retributivo (FTE)', fmtEuro(emp.salaryFte)]]

  if (emp.partTimePct != null) {
    body.push(['Contratto part-time', `${emp.partTimePct}%`])
    body.push(['Livello retributivo annuo (grezzo, prima normalizzazione FTE)', fmtEuro(emp.partTimeRawSalary)])
    body.push([
      'Normalizzazione',
      `Valore FTE = retribuzione annua grezza ÷ ${emp.partTimePct}%`,
    ])
  }

  if (emp.seniority != null && String(emp.seniority).trim()) {
    body.push(['Anzianità di servizio (dati di origine)', String(emp.seniority)])
  }

  y = addTable(doc, y, [['Voce', 'Valore']], body, {
    0: { cellWidth: 95 },
    1: { halign: 'right' },
  })

  y = ensureSpace(doc, y, 16)
  return bodyText(
    doc,
    y,
    'Il livello retributivo comprende la retribuzione base e le componenti strutturali continuative e fisse; sono esclusi i trattamenti individuali non strutturali.',
    pageWidth - MARGIN * 2,
  )
}

function categoryAvgCell(avg, suppressed, privacyNote) {
  if (suppressed) return privacyNote
  return fmtEuro(avg)
}

function drawSection2(doc, payload, startY) {
  const pageWidth = doc.internal.pageSize.getWidth()
  const cat = payload.category || {}
  const pos = payload.positioning || {}
  let y = ensureSpace(doc, startY, 50)
  y = sectionTitle(doc, y, '2. Confronto con la categoria')

  y = bodyText(
    doc,
    y,
    `Categoria di riferimento: stesso livello di inquadramento («${cat.levelLabel || '–'}») nello stesso CCNL («${cat.ccnlLabel || '–'}»). Numerosità categoria: ${cat.nTotal ?? '–'} (uomini: ${cat.nM ?? '–'}, donne: ${cat.nF ?? '–'}).`,
    pageWidth - MARGIN * 2,
  )
  y += 2

  const compareBody = []
  if (cat.showDisaggregated) {
    compareBody.push([
      'Media uomini (livello retributivo FTE)',
      categoryAvgCell(cat.avgM, cat.suppressedM, cat.privacyNote),
    ])
    compareBody.push([
      'Media donne (livello retributivo FTE)',
      categoryAvgCell(cat.avgF, cat.suppressedF, cat.privacyNote),
    ])
  } else {
    compareBody.push([
      'Media complessiva di categoria (livello retributivo FTE)',
      fmtEuro(cat.avgOverall),
    ])
    compareBody.push(['Nota', cat.privacyNote])
  }

  y = addTable(doc, y, [['Indicatore di categoria', 'Valore']], compareBody, {
    0: { cellWidth: 95 },
    1: { halign: 'right' },
  })

  y = ensureSpace(doc, y, 30)
  y = sectionTitle(doc, y, 'Posizionamento del richiedente')

  const posRows = []
  if (pos.vsOwnGender) {
    posRows.push([
      pos.vsOwnGender.reference,
      fmtEuro(pos.vsOwnGender.avg),
      fmtPct(pos.vsOwnGender.deviationPct),
      pos.vsOwnGender.positionText,
    ])
  }
  if (pos.vsOtherGender) {
    posRows.push([
      pos.vsOtherGender.reference,
      fmtEuro(pos.vsOtherGender.avg),
      fmtPct(pos.vsOtherGender.deviationPct),
      pos.vsOtherGender.positionText,
    ])
  }
  if (pos.vsOverall) {
    posRows.push([
      pos.vsOverall.reference,
      fmtEuro(pos.vsOverall.avg),
      fmtPct(pos.vsOverall.deviationPct),
      pos.vsOverall.positionText,
    ])
  }

  if (posRows.length) {
    y = addTable(
      doc,
      y,
      [['Riferimento', 'Media categoria', 'Scostamento %', 'Posizionamento']],
      posRows,
      {
        0: { cellWidth: 52 },
        1: { halign: 'right', cellWidth: 28 },
        2: { halign: 'right', cellWidth: 24 },
        3: { cellWidth: 62 },
      },
    )
  }

  y = ensureSpace(doc, y, 14)
  return bodyText(
    doc,
    y,
    'I confronti utilizzano esclusivamente medie aggregate della categoria; non sono riportate retribuzioni nominali di altri dipendenti.',
    pageWidth - MARGIN * 2,
  )
}

function drawSection3(doc, payload, startY) {
  const pageWidth = doc.internal.pageSize.getWidth()
  let y = ensureSpace(doc, startY, 40)
  y = sectionTitle(doc, y, '3. Criteri di determinazione della retribuzione')
  const text = sanitizeText(payload.criteriaText, 8000)
  return bodyText(doc, y, text, pageWidth - MARGIN * 2)
}

export function buildPayCommunicationPdfBuffer(payload) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  let y = drawHeader(doc, payload)
  y = drawSection1(doc, payload, y + 4)
  y = drawSection2(doc, payload, y + 6)
  drawSection3(doc, payload, y + 6)

  const total = doc.internal.getNumberOfPages()
  for (let i = 1; i <= total; i++) {
    doc.setPage(i)
    drawPageChrome(doc, payload)
  }

  return doc.output('arraybuffer')
}
