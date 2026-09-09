import { MAPPING_SAMPLE_ROWS } from './column-mapping.js'

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const raw = await res.text().catch(() => '')
    let msg = `API error ${res.status}`
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed?.error === 'string' && parsed.error) msg = parsed.error
      else if (typeof parsed?.error?.message === 'string' && parsed.error.message) {
        msg = parsed.error.message
      }
    } catch {
      if (raw) msg = `${msg}: ${raw.slice(0, 180)}`
    }
    throw new Error(msg)
  }
  return res.json()
}

export async function checkGeminiAvailable() {
  try {
    const res = await fetch('/api/gemini/status')
    if (!res.ok) return false
    const data = await res.json()
    return !!(data.aiEnabled ?? data.geminiEnabled)
  } catch {
    return false
  }
}

export async function suggestColumnMappingWithGemini(headers, rows) {
  return postJson('/api/gemini/mapping', {
    headers,
    rows: (rows || []).slice(0, MAPPING_SAMPLE_ROWS),
  })
}

export async function computeIndicatorsWithGemini(normalizedData) {
  return postJson('/api/gemini/indicators', {
    normalizedData: (normalizedData || []).slice(0, 200),
  })
}

export async function scoreJobRolesWithGemini(roles) {
  return postJson('/api/gemini/job-scoring', { roles: (roles || []).slice(0, 50) })
}
