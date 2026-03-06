import { Pool } from 'pg'

let pool
let schemaReady = false

function getPool() {
  if (pool) return pool
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('Missing DATABASE_URL')
  pool = new Pool({
    connectionString,
    ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
  })
  return pool
}

export async function ensureSchema() {
  if (schemaReady) return
  const p = getPool()
  await p.query(`
    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY,
      analysis_type TEXT NOT NULL,
      source_url TEXT,
      header_row_index INTEGER,
      headers_json JSONB,
      mapping_json JSONB,
      rows_json JSONB,
      results_json JSONB,
      calculation_source TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)
  schemaReady = true
}

export async function insertAnalysis(record) {
  await ensureSchema()
  const p = getPool()
  await p.query(
    `INSERT INTO analyses (
      id, analysis_type, source_url, header_row_index, headers_json, mapping_json, rows_json, results_json, calculation_source
    ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9)`,
    [
      record.id,
      record.analysisType,
      record.sourceUrl ?? null,
      Number.isFinite(record.headerRowIndex) ? record.headerRowIndex : null,
      JSON.stringify(record.headers ?? []),
      JSON.stringify(record.mapping ?? {}),
      JSON.stringify(record.rows ?? []),
      JSON.stringify(record.results ?? {}),
      record.calculationSource ?? null,
    ]
  )
}

