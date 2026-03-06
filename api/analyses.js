import { randomUUID } from 'node:crypto'
import { insertAnalysis } from './_db.js'

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return res.status(405).json({ error: 'Method not allowed' })
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    const analysisType = String(body.analysisType || '').trim()
    if (!analysisType) return res.status(400).json({ error: 'analysisType is required' })

    const id = randomUUID()
    await insertAnalysis({
      id,
      analysisType,
      sourceUrl: body.sourceUrl,
      headerRowIndex: body.headerRowIndex,
      headers: body.headers,
      mapping: body.mapping,
      rows: body.rows,
      results: body.results,
      calculationSource: body.calculationSource,
    })

    return res.status(201).json({ id })
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected server error' })
  }
}

