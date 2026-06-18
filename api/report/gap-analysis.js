import { buildGapReportPdfBuffer } from '../../src/lib/gapReportPdf.js'

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '4mb',
    },
  },
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const payload = req.body
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Payload JSON richiesto' })
    }

    const pdfBuffer = Buffer.from(buildGapReportPdfBuffer(payload))
    const stamp = (payload.generatedAtIso || new Date().toISOString()).slice(0, 10)
    const filename = `report-divario-retributivo-${stamp}.pdf`

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Content-Length', pdfBuffer.length)
    return res.status(200).send(pdfBuffer)
  } catch (err) {
    console.error('gap-report pdf error:', err)
    return res.status(500).json({ error: err?.message || 'Generazione PDF non riuscita' })
  }
}
