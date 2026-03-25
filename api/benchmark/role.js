const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
const SERPER_URL = 'https://google.serper.dev/search'

function extractJson(text) {
  const cleaned = String(text || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim()
  try { return JSON.parse(cleaned) } catch {}
  const s = cleaned.indexOf('[')
  const e = cleaned.lastIndexOf(']')
  if (s >= 0 && e > s) {
    try { return JSON.parse(cleaned.slice(s, e + 1)) } catch {}
  }
  throw new Error('Risposta Gemini non in JSON valido')
}

function toNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function roleAliases(role) {
  const norm = normalizeText(role)
  const aliases = new Set()
  const map = {
    'data analyst': ['data analytics analyst', 'analytics analyst'],
    'software engineer': ['software developer', 'swe'],
    'product manager': ['pm'],
    'ux designer': ['ux ui designer', 'user experience designer'],
    'payroll specialist': ['payroll analyst'],
    'talent acquisition lead': ['ta lead', 'talent acquisition manager'],
  }
  if (norm === 'hr') {
    aliases.add('HR')
    aliases.add('Human Resources')
    aliases.add('HR Manager')
    aliases.add('HR Specialist')
  }
  if (norm === 'hrbp') {
    aliases.add('HR Business Partner')
    aliases.add('Human Resources Business Partner')
  }
  if (map[norm]) {
    map[norm].forEach((a) => aliases.add(a))
  }
  return Array.from(aliases)
}

function roleMatch(text, terms) {
  const hay = normalizeText(text)
  if (!hay) return false
  return (terms || []).some((t) => {
    const tokens = normalizeText(t).split(' ').filter((x) => x.length >= 2)
    if (!tokens.length) return false
    return tokens.every((tk) => hay.includes(tk))
  })
}

function isRelevantJobLink(link) {
  const u = String(link || '').toLowerCase()
  return (
    u.includes('linkedin.com/jobs/view') ||
    u.includes('indeed.com/viewjob') ||
    u.includes('indeed.com/job')
  )
}

function pointSalary(a) {
  if (a.salaryAnnualEur != null) return a.salaryAnnualEur
  if (a.salaryMinAnnualEur != null && a.salaryMaxAnnualEur != null) {
    return (a.salaryMinAnnualEur + a.salaryMaxAnnualEur) / 2
  }
  return a.salaryMinAnnualEur ?? a.salaryMaxAnnualEur ?? null
}

function percentileSorted(sorted, p) {
  if (!sorted.length) return null
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const serperKey = process.env.SERP_API_KEY || process.env.SERPER_API_KEY
  const geminiKey = process.env.GOOGLE_AI_API_KEY
  if (!serperKey) return res.status(500).json({ error: 'SERP_API_KEY non configurata sul server.' })
  if (!geminiKey) return res.status(500).json({ error: 'GOOGLE_AI_API_KEY non configurata sul server.' })

  try {
    const { role, sector, country = 'it', language = 'it' } = req.body || {}
    if (!role || !String(role).trim()) return res.status(400).json({ error: 'Ruolo mancante' })

    const qRole = String(role).trim()
    const qSector = String(sector || '').trim()
    const aliases = roleAliases(qRole)
    const roleTerms = [qRole, ...aliases]
    const roleGroup = Array.from(new Set(roleTerms)).map((x) => `"${x}"`).join(' OR ')
    const roleQuery = roleGroup ? `(${roleGroup})` : `"${qRole}"`
    const keywordGroup = '("RAL" OR "retribuzione" OR "stipendio" OR "annua" OR "lordo" OR "EUR" OR "€")'
    const sectorText = qSector ? `"${qSector}"` : ''
    const salaryQueries = [
      `site:it.linkedin.com/jobs/view ${roleQuery} ${sectorText} ${keywordGroup}`,
      `site:it.indeed.com/viewjob ${roleQuery} ${sectorText} ${keywordGroup}`,
      `site:it.indeed.com/job ${roleQuery} ${sectorText} ${keywordGroup}`,
    ]
    const fallbackQueries = [
      `site:it.linkedin.com/jobs/view ${roleQuery} ${sectorText}`,
      `site:it.indeed.com/viewjob ${roleQuery} ${sectorText}`,
      `site:it.indeed.com/job ${roleQuery} ${sectorText}`,
    ]

    async function fetchSerperQueries(queries, num = 10) {
      const settled = await Promise.allSettled(
        queries.map((q) =>
          fetch(SERPER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': serperKey },
            body: JSON.stringify({ q, gl: country, hl: language, num }),
          })
        ),
      )
      const ok = []
      for (const s of settled) {
        if (s.status !== 'fulfilled' || !s.value?.ok) continue
        const data = await s.value.json().catch(() => null)
        if (Array.isArray(data?.organic)) ok.push(...data.organic)
      }
      return ok
    }

    let organic = await fetchSerperQueries(salaryQueries, 10)
    if (!organic.length) organic = await fetchSerperQueries(fallbackQueries, 10)

    const filtered = organic
      .filter((r) => isRelevantJobLink(r?.link))
      .filter((r) => roleMatch(`${r?.title || ''} ${r?.snippet || ''}`, roleTerms))
    const dedup = Array.from(new Map(filtered.map((r) => [String(r.link || ''), r])).values())
      .filter((r) => String(r.link || '').trim())
      .slice(0, 30)

    const raw = dedup.map((r, i) => ({
      i: i + 1,
      title: r.title || '',
      snippet: r.snippet || '',
      link: r.link || '',
      source: r.source || '',
    }))

    if (!raw.length) return res.status(200).json({ role: qRole, sector: qSector, announcements: [], stats: null })

    const prompt = `Estrai SOLO annunci di lavoro con retribuzione/RAL esplicita in EUR annui o convertibile in annuo.
Ruolo target: ${qRole}
Settore target: ${qSector || 'non specificato'}

Input risultati web (JSON):
${JSON.stringify(raw)}

Restituisci SOLO JSON array. Per ogni annuncio incluso:
{
  "i": number,
  "title": string,
  "link": string,
  "source": string,
  "salaryText": string,
  "salaryMinAnnualEur": number|null,
  "salaryMaxAnnualEur": number|null,
  "salaryAnnualEur": number|null,
  "note": string
}

Regole:
- Includi solo se la RAL è in chiaro o ricavabile chiaramente dal testo.
- Se c'è range usa min/max.
- Se c'è un solo valore annuo usa salaryAnnualEur.
- Se mensile converti ad annuo x13 (default Italia) e specifica in note.
- Numeri interi in EUR annui.
- Nessun testo extra oltre il JSON array.`

    const geminiRes = await fetch(`${GEMINI_URL}?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json', maxOutputTokens: 4096 },
      }),
    })
    if (!geminiRes.ok) {
      const txt = await geminiRes.text()
      return res.status(502).json({ error: `Gemini API error ${geminiRes.status}: ${txt.slice(0, 240)}` })
    }
    const data = await geminiRes.json()
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p?.text || '').join('\n')
    const parsed = extractJson(text)
    const announcements = (Array.isArray(parsed) ? parsed : [])
      .map((a) => ({
        i: toNum(a.i),
        title: String(a.title || ''),
        link: String(a.link || ''),
        source: String(a.source || ''),
        salaryText: String(a.salaryText || ''),
        salaryMinAnnualEur: toNum(a.salaryMinAnnualEur),
        salaryMaxAnnualEur: toNum(a.salaryMaxAnnualEur),
        salaryAnnualEur: toNum(a.salaryAnnualEur),
        note: String(a.note || ''),
      }))
      .filter((a) => a.title && (a.salaryAnnualEur != null || a.salaryMinAnnualEur != null || a.salaryMaxAnnualEur != null))

    const values = announcements
      .map(pointSalary)
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b)

    const stats = values.length
      ? {
          n: values.length,
          min: values[0],
          q1: percentileSorted(values, 0.25),
          median: percentileSorted(values, 0.5),
          q3: percentileSorted(values, 0.75),
          max: values[values.length - 1],
        }
      : null

    return res.status(200).json({ role: qRole, sector: qSector, announcements, stats })
  } catch (err) {
    console.error('Benchmark role error:', err)
    return res.status(500).json({ error: err.message || 'Benchmark analysis failed' })
  }
}

