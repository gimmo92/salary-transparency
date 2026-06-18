/** Formattazione numeri coerente con l'UI (PDF e payload). */

export function fmtNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return '–'
  return Number(n).toLocaleString('it-IT', { maximumFractionDigits: 2 })
}

export function fmtEuro(n) {
  if (n == null || !Number.isFinite(Number(n))) return '–'
  return `${fmtNum(n)} €`
}

export function fmtPct(n) {
  if (n == null || !Number.isFinite(Number(n))) return '–'
  return `${Number(n).toFixed(2)}%`
}

/** Gap M/F con segno (M+ / F+), come in dashboard. */
export function fmtGapSigned(gap, { short = false } = {}) {
  if (gap == null || !Number.isFinite(gap)) return '–'
  const a = Math.abs(gap)
  if (a < 1e-9) return '0%'
  const letter = gap > 0 ? 'M' : 'F'
  const body = `${letter}+${a.toFixed(2)}%`
  return short ? body : `Gap: ${body}`
}

export function statusLabel(status, insufficientSample = false) {
  if (insufficientSample || status === 'insufficient') return 'Campione insufficiente'
  if (status === 'green') return 'OK'
  if (status === 'yellow') return 'Da verificare (documentato)'
  if (status === 'red') return 'Da correggere (non documentato)'
  return '–'
}

export function sanitizeText(text, maxLen = 2000) {
  const t = String(text || '')
    .trim()
    .replace(/\r\n/g, '\n')
  if (t.length <= maxLen) return t
  return `${t.slice(0, maxLen)}…`
}
