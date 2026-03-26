const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
const SERPER_URL = 'https://google.serper.dev/search'

/** Rimuove virgole finali non valide in JSON (errore comune da LLM). */
function stripTrailingCommas(jsonLike) {
  return String(jsonLike).replace(/,(\s*[}\]])/g, '$1')
}

/**
 * Estrae il primo array JSON bilanciando le parentesi quadre (evita ] dentro stringhe).
 */
function extractBalancedJsonArray(text) {
  const s = text.indexOf('[')
  if (s < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  let q = ''
  for (let i = s; i < text.length; i++) {
    const c = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (inString) {
      if (c === '\\') {
        escape = true
        continue
      }
      if (c === q) inString = false
      continue
    }
    if (c === '"' || c === "'") {
      inString = true
      q = c
      continue
    }
    if (c === '[') depth++
    if (c === ']') {
      depth--
      if (depth === 0) return text.slice(s, i + 1)
    }
  }
  return null
}

/**
 * Parsa la risposta Gemini in array di annunci: prova più strategie (JSON mode a volte aggiunge testo).
 */
function extractJson(text) {
  const cleaned = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .trim()

  const attempts = [
    () => JSON.parse(cleaned),
    () => JSON.parse(stripTrailingCommas(cleaned)),
  ]
  for (const fn of attempts) {
    try {
      const v = fn()
      if (Array.isArray(v)) return v
      if (v && typeof v === 'object') {
        const arr = v.items || v.announcements || v.data || v.results
        if (Array.isArray(arr)) return arr
      }
    } catch {
      /* try next */
    }
  }

  const slice = extractBalancedJsonArray(cleaned)
  if (slice) {
    for (const fn of [() => JSON.parse(slice), () => JSON.parse(stripTrailingCommas(slice))]) {
      try {
        const v = fn()
        if (Array.isArray(v)) return v
      } catch {
        /* try next */
      }
    }
  }

  const objStart = cleaned.indexOf('{')
  if (objStart >= 0) {
    let depth = 0
    let inString = false
    let escape = false
    let q = ''
    for (let i = objStart; i < cleaned.length; i++) {
      const c = cleaned[i]
      if (escape) {
        escape = false
        continue
      }
      if (inString) {
        if (c === '\\') {
          escape = true
          continue
        }
        if (c === q) inString = false
        continue
      }
      if (c === '"' || c === "'") {
        inString = true
        q = c
        continue
      }
      if (c === '{') depth++
      if (c === '}') {
        depth--
        if (depth === 0) {
          const objSlice = cleaned.slice(objStart, i + 1)
          try {
            const v = JSON.parse(stripTrailingCommas(objSlice))
            const arr = v.items || v.announcements || v.data || v.results
            if (Array.isArray(arr)) return arr
          } catch {
            /* fall through */
          }
          break
        }
      }
    }
  }

  throw new Error('Risposta Gemini non in JSON valido')
}

/** Parsing EUR: numeri puri, stringhe IT (85.000,00) o EN (85,000.00). 0 = assente. */
function parseEurAmount(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v === 0) return null
    return Math.round(v)
  }
  const text = String(v).trim()
  if (!text) return null
  const multiplier = /[kK]\b/.test(text) ? 1000 : 1
  const cleaned = text.replace(/[^\d.,-]/g, '')
  if (!cleaned) return null
  const hasDot = cleaned.includes('.')
  const hasComma = cleaned.includes(',')
  let normalized = cleaned
  if (hasDot && hasComma) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.')
    } else {
      normalized = cleaned.replace(/,/g, '')
    }
  } else if (hasComma) {
    const parts = cleaned.split(',')
    if (parts.length === 2 && parts[1].length <= 2) {
      normalized = parts[0].replace(/\./g, '') + '.' + parts[1]
    } else {
      normalized = parts.join('')
    }
  } else if (hasDot) {
    const parts = cleaned.split('.')
    if (parts.length === 2 && parts[1].length <= 2) {
      normalized = parts[0].replace(/\./g, '') + '.' + parts[1]
    } else {
      normalized = parts.join('')
    }
  }
  const n = Number(normalized) * multiplier
  if (!Number.isFinite(n) || n === 0) return null
  return Math.round(n)
}

/**
 * Estrae min/max annuali da testo libero se i campi numerici da Gemini sono assenti/errati.
 * Mensile → annuo x13 se il testo suggerisce retribuzione mensile e importi plausibili.
 */
function extractAnnualRangeFromText(text) {
  const raw = String(text || '')
  if (!raw.trim()) return null
  const lower = raw.toLowerCase()
  const monthlyHint =
    /€\s*\d[\d.,]*\s*\/?\s*mo\b/.test(lower) ||
    /\b(al mese|mensile|mensilit|mensilità|\/mese)\b/i.test(lower)
  const annualHint = /\b(annu|ral|lordo|\/anno|eur\/a|stipendio annu)\b/i.test(lower) || /all['']anno/i.test(lower)

  const patterns = [
    /(\d[\d.,]*)\s*(?:€|eur|euro)?\s*(?:-|–|a)\s*(\d[\d.,]*)\s*(?:€|eur|euro)?/gi,
    /(?:€|eur)\s*(\d[\d.,]*)\s*(?:-|–)\s*(\d[\d.,]*)/gi,
    /(?:tra|fra)\s*(\d[\d.,]*)\s*(?:e|a)\s*(\d[\d.,]*)/gi,
  ]
  let best = null
  for (const re of patterns) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(raw)) !== null) {
      const x = parseEurAmount(m[1])
      const y = parseEurAmount(m[2])
      if (x == null || y == null) continue
      let lo = Math.min(x, y)
      let hi = Math.max(x, y)
      if (monthlyHint && hi <= 12000 && !annualHint) {
        lo *= 13
        hi *= 13
      }
      if (hi >= 8000 && hi <= 600000) {
        best = { min: lo, max: hi }
        if (hi >= 15000) break
      }
    }
    if (best && best.max >= 15000) break
  }
  if (best) return best
  const single =
    raw.match(/(?:ral|retribuz|stipendio)\s*[:\s]*(\d[\d.,]*)/i) ||
    raw.match(/€\s*(\d[\d.,]*)\s*(?:all['']anno|annui)/i)
  if (single) {
    const v = parseEurAmount(single[1])
    if (v != null && v >= 8000) return { min: v, max: v }
  }
  return null
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
    const { role, country = 'it', language = 'it' } = req.body || {}
    if (!role || !String(role).trim()) return res.status(400).json({ error: 'Ruolo mancante' })

    const qRole = String(role).trim()
    const aliases = roleAliases(qRole)
    const roleTerms = [qRole, ...aliases]
    const roleGroup = Array.from(new Set(roleTerms)).map((x) => `"${x}"`).join(' OR ')
    const roleQuery = roleGroup ? `(${roleGroup})` : `"${qRole}"`
    const keywordGroup = '("RAL" OR "retribuzione" OR "stipendio" OR "annua" OR "lordo" OR "EUR" OR "€")'
    /** Ambito geografico: solo annunci in contesto Italia (Serper gl=it + hint in query) */
    const geoHint = '(Italia OR Italy OR "in Italia")'
    const salaryQueries = [
      `site:it.linkedin.com/jobs/view ${roleQuery} ${keywordGroup} ${geoHint}`,
      `site:it.indeed.com/viewjob ${roleQuery} ${keywordGroup} ${geoHint}`,
      `site:it.indeed.com/job ${roleQuery} ${keywordGroup} ${geoHint}`,
    ]
    const fallbackQueries = [
      `site:it.linkedin.com/jobs/view ${roleQuery} ${geoHint}`,
      `site:it.indeed.com/viewjob ${roleQuery} ${geoHint}`,
      `site:it.indeed.com/job ${roleQuery} ${geoHint}`,
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

    let organic = await fetchSerperQueries(salaryQueries, 15)
    if (!organic.length) organic = await fetchSerperQueries(fallbackQueries, 15)

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

    if (!raw.length) return res.status(200).json({ role: qRole, announcements: [], stats: null })

    const prompt = `Estrai SOLO annunci di lavoro con retribuzione/RAL esplicita in EUR annui o convertibile in annuo.
Contesto: annunci riferiti al mercato del lavoro in Italia per il ruolo indicato (nessun filtro per settore).
Ruolo target: ${qRole}

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
- Per salaryMinAnnualEur, salaryMaxAnnualEur, salaryAnnualEur usa SOLO numeri interi senza separatori (es. 85000), mai stringhe tipo "85.000".
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
    const cand = data.candidates?.[0]
    const text = (cand?.content?.parts || []).map((p) => p?.text || '').join('\n')
    if (!String(text || '').trim()) {
      const r = cand?.finishReason || ''
      console.error('Benchmark Gemini empty text', { finishReason: r, raw: JSON.stringify(data).slice(0, 1200) })
      throw new Error(
        r === 'SAFETY'
          ? 'Gemini ha bloccato la risposta (policy).'
          : 'Risposta Gemini vuota o incompleta.',
      )
    }
    const parsed = extractJson(text)
    const announcements = (Array.isArray(parsed) ? parsed : [])
      .map((a) => {
        const salaryText = String(a.salaryText || '')
        const title = String(a.title || '')
        let salaryMinAnnualEur = parseEurAmount(a.salaryMinAnnualEur)
        let salaryMaxAnnualEur = parseEurAmount(a.salaryMaxAnnualEur)
        let salaryAnnualEur = parseEurAmount(a.salaryAnnualEur)
        const idx = typeof a.i === 'number' ? a.i : parseInt(String(a.i), 10)
        let row = {
          i: Number.isFinite(idx) ? idx : null,
          title,
          link: String(a.link || ''),
          source: String(a.source || ''),
          salaryText,
          salaryMinAnnualEur,
          salaryMaxAnnualEur,
          salaryAnnualEur,
          note: String(a.note || ''),
        }
        let pt = pointSalary(row)
        if (pt == null || pt === 0) {
          const fromText = extractAnnualRangeFromText(`${salaryText} ${title}`)
          if (fromText) {
            row = {
              ...row,
              salaryMinAnnualEur: fromText.min,
              salaryMaxAnnualEur: fromText.max,
              salaryAnnualEur: null,
            }
          }
        }
        return row
      })
      .filter((a) => {
        if (!a.title) return false
        const p = pointSalary(a)
        return p != null && p > 0
      })

    const values = announcements
      .map(pointSalary)
      .filter((v) => Number.isFinite(v) && v > 0)
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

    return res.status(200).json({ role: qRole, announcements, stats })
  } catch (err) {
    console.error('Benchmark role error:', err)
    return res.status(500).json({ error: err.message || 'Benchmark analysis failed' })
  }
}

