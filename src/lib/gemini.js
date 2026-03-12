export async function suggestColumnMappingWithGemini(_apiKey, _headers, _rows) {
  // Placeholder: rely on heuristic mapping from excel.js
  return {}
}

export async function computeIndicatorsWithGemini(_apiKey, _normalizedData) {
  // Placeholder: fall back to local computation in App.vue when this fails
  throw new Error('Gemini non configurato lato client.')
}

export async function scoreJobRolesWithGemini(_apiKey, _roles) {
  // Placeholder for future AI-based scoring
  throw new Error('Gemini non configurato lato client.')
}

