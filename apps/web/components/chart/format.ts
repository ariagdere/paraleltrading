// Grafiğin ortak biçimleri. Saatler İstanbul.

export const fmtP = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 })
export const fmt1 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const fmtUsd = new Intl.NumberFormat('tr-TR', { notation: 'compact', maximumFractionDigits: 1 })
export const usd = (v: number) => `${fmtUsd.format(v)} $`
export const hm = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit' })
export const dm = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', day: 'numeric', month: 'short' })
export const dmh = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
export const pct = (a: number, b: number) => {
  const v = ((a - b) / b) * 100
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}%${Math.abs(v).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}`
}
