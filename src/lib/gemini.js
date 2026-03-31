async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `API error ${res.status}`)
  }
  return res.json()
}

export async function checkGeminiAvailable() {
  try {
    const res = await fetch('/api/gemini/status')
    if (!res.ok) return false
    const data = await res.json()
    return !!data.geminiEnabled
  } catch {
    return false
  }
}

export async function suggestColumnMappingWithGemini(headers, rows) {
  return postJson('/api/gemini/mapping', { headers, rows })
}

export async function computeIndicatorsWithGemini(normalizedData) {
  return postJson('/api/gemini/indicators', { normalizedData })
}

export async function scoreJobRolesWithGemini(roles) {
  return postJson('/api/gemini/job-scoring', { roles })
}

export async function suggestJustificationWithGemini(roleData) {
  return postJson('/api/gemini/justify', roleData)
}

export async function benchmarkRoleMarketWithSerper(payload) {
  return postJson('/api/benchmark/role', payload)
}
