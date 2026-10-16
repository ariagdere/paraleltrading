// L/S açılarının saf hesabı; veritabanına dokunmaz.
//
// Eski sistemin formülü (hakari-lsr-refresher/lsrAngle.js; Python lsr_order_report.py ile doğrulanmış): son 30
// noktanın ortalamaya göre normalize değerlerine x = 0…1 doğrusu oturtulur; eğim pencere boyunca toplam
// normalize değişim, R² uyumun güvenilirliği. Referans, o noktaya kadarki bütün geçerli pencerelerin |eğim|
// değerlerinin %90'lık değeri (numpy.percentile gibi doğrusal ara değerle; en az 100 pencere). Açı =
// atan(eğim / referans), derece. Pencere yalnız aralıksız noktalardan oluşur; arada eksik nokta varsa eğim yok.
//
// Eski sistem açıyı t anında hesaplarken ts ≤ t − dilim olan son noktayı kullanıyordu (lag 1). Burada her nokta
// için o noktada biten pencerenin açısı saklanır: t anındaki eski açı = ts ≤ t − dilim olan son noktanın açısı
// (o nokta t − dilim'den iki dilim ya da daha eskiyse açı yok).

export const WINDOW = 30
export const MIN_REF = 100

// windowStats birebir (işlem sırası da aynı, sonuç bit bit aynı çıksın).
export function windowStats(y: number[]): { slope: number; r2: number } {
  const n = y.length
  const mean = y.reduce((a, b) => a + b, 0) / n
  const yn = y.map((v) => v / mean - 1)
  const ynMean = yn.reduce((a, b) => a + b, 0) / n
  const yc = yn.map((v) => v - ynMean)
  const xc: number[] = new Array(n)
  for (let i = 0; i < n; i++) xc[i] = n === 1 ? 0 : i / (n - 1)
  const xcMean = xc.reduce((a, b) => a + b, 0) / n
  for (let i = 0; i < n; i++) xc[i] = xc[i]! - xcMean
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    sxx += xc[i]! * xc[i]!
    syy += yc[i]! * yc[i]!
    sxy += xc[i]! * yc[i]!
  }
  const slope = sxx > 0 ? sxy / sxx : 0
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0
  return { slope, r2 }
}

// Büyüyen bir kümenin %90'lık değeri, her eklemede O(log n): alttaki (lo + 1) değer bir max-yığında, kalanlar bir
// min-yığında. Eski percentile90 ile aynı sıra istatistiklerini ve aynı ara değer işlemini kullanır.
class Heap {
  private a: number[] = []
  constructor(private readonly before: (x: number, y: number) => boolean) {}
  get size() {
    return this.a.length
  }
  top() {
    return this.a[0]!
  }
  push(x: number) {
    const a = this.a
    a.push(x)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.before(a[i]!, a[p]!)) break
      ;[a[i], a[p]] = [a[p]!, a[i]!]
      i = p
    }
  }
  pop(): number {
    const a = this.a
    const top = a[0]!
    const last = a.pop()!
    if (a.length > 0) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && this.before(a[l]!, a[m]!)) m = l
        if (r < a.length && this.before(a[r]!, a[m]!)) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m]!, a[i]!]
        i = m
      }
    }
    return top
  }
}

export class RunningP90 {
  private low = new Heap((x, y) => x > y) // en küçük (lo + 1) değer; tepede en büyüğü
  private high = new Heap((x, y) => x < y) // kalanlar; tepede en küçüğü
  get size() {
    return this.low.size + this.high.size
  }
  add(x: number) {
    if (this.low.size > 0 && x <= this.low.top()) this.low.push(x)
    else this.high.push(x)
    const lo = Math.floor(0.9 * (this.size - 1))
    while (this.low.size > lo + 1) this.high.push(this.low.pop())
    while (this.low.size < lo + 1 && this.high.size > 0) this.low.push(this.high.pop())
  }
  value(): number {
    const idx = 0.9 * (this.size - 1)
    const lo = Math.floor(idx)
    const hi = Math.ceil(idx)
    const sLo = this.low.top()
    if (lo === hi) return sLo
    return sLo + (this.high.top() - sLo) * (idx - lo)
  }
}

export type AnglePoint = { slope: number | null; r2: number | null; ref: number | null; nRef: number; angle: number | null }

// Serinin her noktası için (ts artan, eşsiz; step dilim ms). Pencere ya da referans yetersizse null.
export function angleSeries(ts: number[], v: number[], step: number): AnglePoint[] {
  const out: AnglePoint[] = []
  const p90 = new RunningP90()
  for (let i = 0; i < ts.length; i++) {
    let slope: number | null = null
    let r2: number | null = null
    if (i >= WINDOW - 1 && ts[i]! - ts[i - WINDOW + 1]! === (WINDOW - 1) * step) {
      ;({ slope, r2 } = windowStats(v.slice(i - WINDOW + 1, i + 1)))
      p90.add(Math.abs(slope))
    }
    let ref: number | null = null
    let angle: number | null = null
    if (slope !== null && p90.size >= MIN_REF) {
      const r = p90.value()
      if (r > 0) {
        ref = r
        angle = (Math.atan(slope / r) * 180) / Math.PI
      }
    }
    out.push({ slope, r2, ref, nRef: p90.size, angle })
  }
  return out
}
