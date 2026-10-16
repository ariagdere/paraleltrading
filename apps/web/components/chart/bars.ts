import type { CandleRow } from '@/lib/chart-shared'
import type { LiveQuote } from '../live'

// Grafiğin son mumlarının saf hesapları (tarayıcıya ve teste ortak): canlı quote'un oluşan muma işlenmesi ve
// sunucudan gelen son mumların ekrandakilerle birleştirilmesi.

export type CandleBody = { rows: CandleRow[]; forming: CandleRow[] }
export const same = (a: CandleRow, b: CandleRow) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4]

// Quote'u (bid) son muma işler ya da dilim dolduysa yeni mum açar (açılış son mumun açılışına dilim katı eklenerek:
// İstanbul hizası korunur). Kayıtlı (kapanmış) muma dokunmaz.
export function applyQuote(cur: CandleRow[], stored: number, q: LiveQuote, step: number): 'none' | 'updated' | 'added' {
  const last = cur[cur.length - 1]
  if (!last || q.t < last[0]) return 'none'
  if (q.t >= last[0] + step) {
    cur.push([last[0] + Math.floor((q.t - last[0]) / step) * step, q.bid, q.bid, q.bid, q.bid])
    return 'added'
  }
  if (cur.length <= stored) return 'none'
  const next: CandleRow = [last[0], last[1], Math.max(last[2], q.bid), Math.min(last[3], q.bid), q.bid]
  if (same(last, next)) return 'none'
  cur[cur.length - 1] = next
  return 'updated'
}

// Sunucunun son mumlarını ekrandakilerle birleştirir. Kayıtlı mumlar olduğu gibi yerine geçer; oluşan mum ekranda
// zaten varsa tepesi ve dibi birleşir (quote'larla görülen uçlar kaybolmasın). Dönüş: ilk değişen sıra (-1: değişen
// yok), kayıtlı mum sayısı, araya mum girip girmediği.
export function mergeTail(cur: CandleRow[], stored: number, body: CandleBody): { from: number; stored: number; inserted: boolean } {
  let from = Infinity
  let inserted = false
  const idx = (t: number) => {
    for (let i = cur.length - 1; i >= 0 && cur[i]![0] >= t; i--) if (cur[i]![0] === t) return i
    return -1
  }
  const put = (r: CandleRow) => {
    const i = idx(r[0])
    if (i >= 0) {
      if (!same(cur[i]!, r)) ((cur[i] = r), (from = Math.min(from, i)))
    } else if (cur.length === 0 || r[0] > cur[cur.length - 1]![0]) {
      cur.push(r)
      from = Math.min(from, cur.length - 1)
    } else {
      cur.splice(
        cur.findIndex((x) => x[0] > r[0]),
        0,
        r,
      )
      inserted = true
    }
  }
  let lastStored = stored > 0 ? cur[stored - 1]![0] : -Infinity
  for (const r of body.rows) {
    put(r)
    lastStored = Math.max(lastStored, r[0])
  }
  let n = cur.length
  while (n > 0 && cur[n - 1]![0] > lastStored) n--
  for (const f of body.forming) {
    if (f[0] <= lastStored) continue
    const i = idx(f[0])
    put(i >= 0 ? [f[0], f[1], Math.max(cur[i]![2], f[2]), Math.min(cur[i]![3], f[3]), f[4]] : f)
  }
  return { from: from === Infinity ? -1 : from, stored: n, inserted }
}
