import { randomUUID } from 'node:crypto'
import { insertAnalysis, listAnalyses, deleteAnalysis } from './_db.js'

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const rows = await listAnalyses()
      return res.status(200).json(rows)
    }

    if (req.method === 'DELETE') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
      const id = String(body.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id is required' })
      const deleted = await deleteAnalysis(id)
      if (!deleted) return res.status(404).json({ error: 'Analysis not found' })
      return res.status(200).json({ deleted: true })
    }

    if (req.method === 'POST') {
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
    }

    res.setHeader('Allow', 'GET, POST, DELETE')
    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected server error' })
  }
}

