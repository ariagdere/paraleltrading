import type {
  AutoscaleInfo,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  Logical,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts'
import type { ChartZone } from '@/lib/chart-shared'
import type { HeatGrid } from '@/lib/heatmap'

// Grafiğin üstüne çizilen katmanlar (Lightweight Charts eklentisi olarak): heatmap ısısı ve likidasyon profili,
// destek/direnç bantları. İkisi de mumların altında çizilir.

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0]

export function rgba(hex: string, a: number) {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

// Gerçek zamanı (ms) grafiğin mantıksal eksenine çevirir: i. mum [i − 0,5, i + 0,5) aralığını kaplar. Mumlar
// arasında boşluk varsa boşluktaki an önceki mumun sonuna düşer; ilk mumdan önce ve son mumdan sonra dilimle uzatılır.
export class TimeAxis {
  times: number[] = []
  tf = 900_000

  set(times: number[], tf: number) {
    this.times = times
    this.tf = tf
  }

  logical(t: number): number {
    const ts = this.times
    const n = ts.length
    if (n === 0) return NaN
    if (t < ts[0]!) return (t - ts[0]!) / this.tf - 0.5
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (ts[mid]! <= t) lo = mid
      else hi = mid - 1
    }
    const frac = (t - ts[lo]!) / this.tf
    return lo - 0.5 + (lo === n - 1 ? frac : Math.min(1, frac))
  }

  // mantıksal konumdaki gerçek an (imleç için)
  time(logical: number): number {
    const ts = this.times
    if (ts.length === 0) return NaN
    const i = Math.max(0, Math.min(ts.length - 1, Math.round(logical)))
    return ts[i]! + (logical - i + 0.5) * this.tf
  }
}

abstract class Layer implements ISeriesPrimitive<Time> {
  protected p: SeriesAttachedParameter<Time> | null = null
  protected on = true
  private readonly views: IPrimitivePaneView[]

  constructor(protected axis: TimeAxis) {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.p && this.on && this.draw(target) }
    this.views = [{ zOrder: (): PrimitivePaneViewZOrder => 'bottom', renderer: () => renderer }]
  }

  attached(p: SeriesAttachedParameter<Time>) {
    this.p = p
  }
  detached() {
    this.p = null
  }
  paneViews() {
    return this.views
  }
  update() {
    this.p?.requestUpdate()
  }
  setVisible(on: boolean) {
    this.on = on
    this.update()
  }

  // Zamanı x'e çeviren fonksiyon (çizim başına bir kez). Kütüphanenin logicalToCoordinate'i yalnız tam sayı alıyor;
  // eksen doğrusal olduğundan iki mumun konumundan ara değerler hesaplanır.
  protected xScale(): (t: number) => number | null {
    const ts = this.p!.chart.timeScale()
    const a = ts.logicalToCoordinate(0 as Logical)
    const b = ts.logicalToCoordinate(1 as Logical)
    if (a === null || b === null) return () => null
    return (t) => {
      const lg = this.axis.logical(t)
      return Number.isFinite(lg) ? a + lg * (b - a) : null
    }
  }
  protected y(price: number): number | null {
    return this.p!.series.priceToCoordinate(price)
  }

  protected abstract draw(target: Target): void
}

const BUCKETS = 24

// Heatmap: hücreler (koyuluk likidasyon miktarı, 0,7 üslü ölçek), snapshot anı çizgisi ve sağ kenarda fiyat
// seviyesine göre toplam likidasyon profili (uzun aralıkta ısının kapsamadığı yerde de görünür).
export class HeatLayer extends Layer {
  private grid: HeatGrid | null = null
  private at: number | null = null
  private buckets: number[][] = [] // her koyuluk dilimindeki hücrelerin ızgaradaki sırası
  private sums: number[] = []
  private sumMax = 0
  private extent: [number, number] | null = null
  color = '#f5c84c'
  text = '#e9edf5'
  font = 'sans-serif'
  label = ''

  setData(grid: HeatGrid | null, at: number | null, label: string) {
    this.grid = grid
    this.at = at
    this.label = label
    this.buckets = Array.from({ length: BUCKETS }, () => [])
    this.sums = grid ? new Array(grid.levels.length).fill(0) : []
    this.sumMax = 0
    if (grid && grid.max > 0) {
      const c = grid.cells
      for (let i = 0; i < c.length; i += 3) {
        const b = Math.min(BUCKETS - 1, Math.floor((c[i + 2]! / grid.max) * BUCKETS))
        this.buckets[b]!.push(i)
        this.sums[c[i + 1]!]! += c[i + 2]!
      }
      this.sumMax = Math.max(0, ...this.sums)
    }
    this.update()
  }

  // Fiyat ekseni şu aralığı da kapsasın (en yakın cluster'lar); yalnız grafiğin sağ ucu görünürken.
  setExtent(e: [number, number] | null) {
    this.extent = e
    this.update()
  }
  autoscaleInfo(_from: Logical, to: Logical): AutoscaleInfo | null {
    if (!this.extent || to < this.axis.times.length - 3) return null
    return { priceRange: { minValue: this.extent[0], maxValue: this.extent[1] } }
  }

  // imlecin altındaki hücrenin likidasyonu ($)
  valueAt(t: number, price: number): number | null {
    const g = this.grid
    if (!g || g.cols.length === 0) return null
    const col = Math.floor((t - g.cols[0]!) / g.step)
    if (col < 0 || col >= g.cols.length) return null
    let li = -1
    let best = Infinity
    for (let i = 0; i < g.levels.length; i++) {
      const d = Math.abs(g.levels[i]! - price)
      if (d < best) {
        best = d
        li = i
      }
    }
    const half = g.levels.length > 1 ? Math.abs(g.levels[1]! - g.levels[0]!) / 2 : 25
    if (best > half) return null
    const c = g.cells
    for (let i = 0; i < c.length; i += 3) if (c[i] === col && c[i + 1] === li) return c[i + 2]! * 1000
    return 0
  }

  protected draw(target: Target) {
    const g = this.grid
    if (!g || g.cols.length === 0) return
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const W = bitmapSize.width
      const H = bitmapSize.height
      const X = this.xScale()
      const nc = g.cols.length
      const colX: number[] = new Array(nc + 1)
      for (let i = 0; i <= nc; i++) {
        const x = X(i < nc ? g.cols[i]! : g.cols[nc - 1]! + g.step)
        colX[i] = x === null ? NaN : x * hr
      }
      const half = g.levels.length > 1 ? Math.abs(g.levels[1]! - g.levels[0]!) / 2 : 25
      const top: number[] = []
      const bot: number[] = []
      for (const lv of g.levels) {
        const a = this.y(lv + half)
        const b = this.y(lv - half)
        top.push(a === null ? NaN : a * vr)
        bot.push(b === null ? NaN : b * vr)
      }
      const c = g.cells
      for (let b = 0; b < BUCKETS; b++) {
        const idx = this.buckets[b]!
        if (idx.length === 0) continue
        ctx.fillStyle = rgba(this.color, Math.min(0.92, 0.04 + 0.88 * ((b + 0.5) / BUCKETS) ** 0.7))
        for (const i of idx) {
          const x0 = colX[c[i]!]!
          const x1 = colX[c[i]! + 1]!
          if (!(x1 >= 0 && x0 <= W)) continue
          const y0 = top[c[i + 1]!]!
          const y1 = bot[c[i + 1]!]!
          if (!(y1 >= 0 && y0 <= H)) continue
          ctx.fillRect(x0, y0, Math.max(1, x1 - x0 + 0.6 * hr), Math.max(1, y1 - y0 + 0.6 * vr))
        }
      }
      // sağ kenarda profil (ısıdan ayrılsın diye nötr renkte)
      if (this.sumMax > 0) {
        const pw = Math.min(110 * hr, W * 0.14)
        ctx.fillStyle = rgba(this.text, 0.3)
        for (let i = 0; i < this.sums.length; i++) {
          const s = this.sums[i]!
          if (s <= 0 || !(bot[i]! >= 0 && top[i]! <= H)) continue
          const w = (s / this.sumMax) * pw
          ctx.fillRect(W - w, top[i]!, w, Math.max(1, bot[i]! - top[i]!))
        }
      }
      // snapshot anı
      if (this.at !== null) {
        const xs = X(this.at)
        if (xs !== null && xs * hr >= 0 && xs * hr <= W) {
          const xl = Math.round(xs * hr) + 0.5
          ctx.strokeStyle = rgba(this.text, 0.45)
          ctx.lineWidth = Math.max(1, hr)
          ctx.setLineDash([4 * hr, 4 * hr])
          ctx.beginPath()
          ctx.moveTo(xl, 0)
          ctx.lineTo(xl, H)
          ctx.stroke()
          ctx.setLineDash([])
          ctx.font = `${12 * vr}px ${this.font}`
          ctx.fillStyle = rgba(this.text, 0.75)
          ctx.textBaseline = 'top'
          const w = ctx.measureText(this.label).width
          const right = xl + 6 * hr + w > W
          ctx.textAlign = right ? 'right' : 'left'
          ctx.fillText(this.label, xl + (right ? -6 : 6) * hr, 6 * vr)
        }
      }
    })
  }
}

export type ZoneView = ChartZone & { emphasis: 'near' | 'active' | 'ended' }

// Destek/direnç bantları: oluştuğu andan bittiği ana (sürüyorsa sağ kenara) kadar, boyut değişimleriyle. Fiyatın
// hemen üstündeki ve altındaki bölge (o anki hedefler) belirgin, diğer geçerli bölgeler soluk, bitenler istenirse
// çok soluk.
export class ZoneLayer extends Layer {
  private zones: ZoneView[] = []
  color = '#9085e9'

  setZones(zones: ZoneView[]) {
    this.zones = zones
    this.update()
  }

  protected draw(target: Target) {
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const W = bitmapSize.width
      const H = bitmapSize.height
      const X = this.xScale()
      const order = { ended: 0, active: 1, near: 2 }
      for (const z of [...this.zones].sort((a, b) => order[a.emphasis] - order[b.emphasis])) {
        const [fill, edge] = z.emphasis === 'near' ? [0.26, 0.95] : z.emphasis === 'active' ? [0.09, 0.38] : [0.07, 0.32]
        for (let k = 0; k < z.bands.length; k++) {
          const [t0, lo, hi] = z.bands[k]!
          const t1 = k + 1 < z.bands.length ? z.bands[k + 1]![0] : z.endedAt
          const a = X(t0)
          const b = t1 === null ? W / hr : X(t1)
          if (a === null || b === null) continue
          const x0 = Math.max(0, a * hr)
          const x1 = Math.min(W, b * hr)
          if (x1 <= 0 || x0 >= W || x1 <= x0) continue
          const yt = this.y(hi)
          const yb = this.y(lo)
          if (yt === null || yb === null) continue
          const y0 = yt * vr
          const y1 = yb * vr
          if (y1 < 0 || y0 > H) continue
          ctx.fillStyle = rgba(this.color, fill)
          ctx.fillRect(x0, y0, x1 - x0, Math.max(1, y1 - y0))
          ctx.strokeStyle = rgba(this.color, edge)
          ctx.lineWidth = Math.max(1, hr)
          ctx.beginPath()
          ctx.moveTo(x0, Math.round(y0) + 0.5)
          ctx.lineTo(x1, Math.round(y0) + 0.5)
          ctx.moveTo(x0, Math.round(y1) + 0.5)
          ctx.lineTo(x1, Math.round(y1) + 0.5)
          ctx.stroke()
        }
      }
    })
  }
}

// Bir andaki bant (o andan önceki son oluşma ya da boyut değişimi).
export function bandAt(z: ChartZone, t: number): [number, number] | null {
  if (t < z.createdAt || (z.endedAt !== null && t >= z.endedAt)) return null
  let band: [number, number] | null = null
  for (const [bt, lo, hi] of z.bands) if (bt <= t) band = [lo, hi]
  return band
}
