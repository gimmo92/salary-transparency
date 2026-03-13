import { GoogleGenerativeAI } from '@google/generative-ai'

export function getModel() {
  const key = process.env.GOOGLE_AI_API_KEY
  if (!key) throw new Error('GOOGLE_AI_API_KEY not configured on server.')
  const genAI = new GoogleGenerativeAI(key)
  return genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function errorResponse(message, status = 500) {
  return jsonResponse({ error: message }, status)
}

export async function askGeminiJson(model, prompt) {
  const result = await model.generateContent(prompt)
  const text = result.response.text()
  const cleaned = text.replace(/```json\s*/g, '').replace(/```/g, '').trim()
  return JSON.parse(cleaned)
}
