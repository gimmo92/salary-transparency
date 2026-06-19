import { buildPayCommunicationPdfBuffer } from '../../src/lib/payCommunicationPdf.js'

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '2mb',
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
    if (!payload.employee?.index && payload.employee?.index !== 0) {
      return res.status(400).json({ error: 'Dipendente non specificato nel payload' })
    }

    const pdfBuffer = Buffer.from(buildPayCommunicationPdfBuffer(payload))
    const stamp = (payload.generatedAtIso || new Date().toISOString()).slice(0, 10)
    const slug = String(payload.employee?.name || payload.employee?.index || 'dipendente')
      .replace(/[^\w\-àèéìòù]/gi, '-')
      .replace(/-+/g, '-')
      .slice(0, 40)
    const filename = `comunicazione-retributiva-${slug}-${stamp}.pdf`

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Content-Length', pdfBuffer.length)
    return res.status(200).send(pdfBuffer)
  } catch (err) {
    console.error('pay-communication pdf error:', err)
    return res.status(500).json({ error: err?.message || 'Generazione PDF non riuscita' })
  }
}
