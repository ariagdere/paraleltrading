// Kombinasyon motoru: naif setup'ın değişken taraması. Saf hesaplar; veritabanına dokunmaz (okuma data.ts'te,
// zamanlama ve kayıt job.ts'te). 27 Ekim'deki betiklerin (build_prod.mts, search_v4.py) birebir karşılığı.
//
// Aday: her Axi 5m kapanışında (T) o ana kadar gelmiş son 12h heatmap'in 1. cluster'ları, bazla Axi fiyatına
// kaydırılmış. Yalnız bütün değişkenlerin dolu olduğu saatler: snapshot en çok 60 dk eski (o saatin heatmap'i), ZLEMA
// 15m/1h/4h/1d ve 8 L/S açısının hepsi var. Snapshot'tan (son sütunundan) sonra Axi 1m fiyatı cluster'lardan birine
// değdiyse bir sonraki heatmap'e kadar setup yok. Yön yakın cluster'a; TP o anki fiyattan (5m kapanışı, bid) yakın
// mesafenin %75'i, SL uzak mesafenin %75'i; TP 60 $'dan kısaysa aday yok. Giriş T'den sonraki ilk 1m mumunun
// açılışında (en çok 10 dk sonra); BUY ask'tan (bid + mumun spread'i), SELL bid'den. Çıkış 1m mumlarıyla; mum seviyenin
// ötesinde açılırsa açılıştan, aynı mumda TP ve SL olursa SL.
//
// Değişkenler işlem yönüne göre: ZLEMA (oluşan mumla; 4h ve 1d İstanbul'a hizalı) aynı/ters/nötr; L/S açısı (global
// ve TT; yayımlanmış son nokta, ts ≤ T − dilim, iki dilimden eski değil) aynı/ters × 0–15°, 15–30°, 30°+; yakın/uzak
// cluster mesafesi oranı 0–0,4, 0,4–0,7, 0,7–1.
//
// Arama long ve short için ayrı: aynı anda tek pozisyon, 1 ve 2 koşullu bütün kombinasyonlar, 3 ve 4 koşullular en
// iyi 20'nin üstüne birer koşul ekleyerek; en az 30 işlemliler toplam R'ye göre sıralı. Şans testi: işlem sonuçları
// adaylar arasında rastgele kaydırılıp aynı arama tekrarlanır, her tekrarın en iyi toplam R'si. Birleşik: en iyi long
// ve en iyi short ayrı yuvalarda (biri açıkken diğerinin sinyali de açılır). Geçerlilik: önceki koşunun seçtiği
// kurallar, önceki koşunun verisinin bittiği andan sonraki kararlarla.

import { zlemaZone, type Zone } from '../indicators.js'

export const SIM_ENGINE = 'v1'

export const SIM = {
  span: '12h',
  tpPct: 75,
  slPct: 75,
  minTpUsd: 60,
  maxSnapshotAgeMs: 60 * 60_000,
  entryMaxGapMs: 10 * 60_000,
  zlemaBars: 150,
  defaultSpreadUsd: 12,
  minTrades: 30,
  beam: 20,
  nullRuns: 200,
  topN: 10,
  validMinTrades: 10,
} as const

const M1 = 60_000
const M5 = 300_000
const IST = 3 * 3_600_000

export const ZTF = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 } as const
export type ZTf = keyof typeof ZTF
export const Z_TFS = Object.keys(ZTF) as ZTf[]
export const LS_METRICS = [
  ['global', 'global'],
  ['top_position', 'TT'],
] as const
export const LS_PERIODS = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 } as const
export type LsPeriod = keyof typeof LS_PERIODS
// Açı serilerinin sırası: global 5m, 15m, 1h, 4h, TT 5m … (değişken sırası bu sırayla)
export const ANGLE_KEYS = LS_METRICS.flatMap(([metric, label]) =>
  (Object.keys(LS_PERIODS) as LsPeriod[]).map((period) => ({ metric, period, name: `L/S ${label} ${period}` })),
)

const Z_BUCKETS = ['ayni', 'ters', 'notr'] as const
const A_BUCKETS = ['ayni_0_15', 'ayni_15_30', 'ayni_30', 'ters_0_15', 'ters_15_30', 'ters_30'] as const
const RR_NAME = 'Yakın/uzak oranı'
const RR_BUCKETS = [
  ['0–0,4', 0, 0.4],
  ['0,4–0,7', 0.4, 0.7],
  ['0,7–1', 0.7, 1.01],
] as const

export type Side = 'LONG' | 'SHORT'
export type Cond = [string, string] // [değişken, aralık], ör. ['ZLEMA 1h', 'notr']

// ─── Girdiler ────────────────────────────────────────────────────────────────────────────────────────────────
export type Bar = { t: number; o: number; h: number; l: number; c: number }
export type Bar1 = Bar & { s: number | null } // s: spread ($); mumda yoksa null
export type Snap = { id: number; avail: number; t1: number; up: number; dn: number } // up/dn Axi fiyatıyla (seviye − baz)
export type AngleSeries = { ts: number[]; a: (number | null)[] }
export type Inputs = {
  m1: Bar1[]
  m5: Bar[]
  tf: Record<ZTf, Bar[]>
  snaps: Snap[] // avail'e göre sıralı
  angles: Record<string, AngleSeries> // `${metric}_${period}`
}

// Sıralı dizide t'den küçük ya da eşit son öğenin sırası (yoksa -1).
function lastAtOrBefore(arr: { t: number }[] | number[], t: number): number {
  let lo = 0
  let hi = arr.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const v = typeof arr[mid] === 'number' ? (arr[mid] as number) : (arr[mid] as { t: number }).t
    if (v <= t) ((ans = mid), (lo = mid + 1))
    else hi = mid - 1
  }
  return ans
}

// Uzun hesapların arasında olay döngüsüne nefes aldırmak için (core'un diğer işleri beklemesin).
export type Pause = () => Promise<void>
export const noPause: Pause = async () => {}

// ─── Adaylar ─────────────────────────────────────────────────────────────────────────────────────────────────
export type Candidates = {
  n: number
  T: number[]
  long: boolean[]
  P: number[]
  near: number[]
  far: number[]
  R: (number | null)[]
  exitT: (number | null)[]
  zones: Zone[][] // [i][Z_TFS sırası]
  angles: number[][] // [i][ANGLE_KEYS sırası]
  snapId: number[]
  from: number | null
  to: number
}

const bucketStart = (tf: ZTf, T: number) => {
  const step = ZTF[tf]
  return tf === '4h' || tf === '1d' ? Math.floor((T + IST) / step) * step - IST : Math.floor(T / step) * step
}

// T anındaki ZLEMA bölgesi, oluşan mumla: oluşan aralıktan önceki son 149 kapanmış mum ve o ana kadar kapanmış 1m
// mumlarından oluşan mum (hiç yoksa son fiyatla tek değerli mum). Geçmiş yetmezse null.
function zoneForming(inp: Inputs, tf: ZTf, T: number): Zone | null {
  const f = bucketStart(tf, T)
  const bs = inp.tf[tf]
  const k = lastAtOrBefore(bs, f - 1)
  if (k < SIM.zlemaBars - 2) return null
  const closed = bs.slice(k - (SIM.zlemaBars - 2), k + 1)
  const m1 = inp.m1
  const end = lastAtOrBefore(m1, T - M1)
  let o = NaN
  let h = -Infinity
  let l = Infinity
  let c = NaN
  for (let i = end; i >= 0 && m1[i]!.t >= f; i--) {
    const b = m1[i]!
    if (Number.isNaN(c)) c = b.c
    o = b.o
    if (b.h > h) h = b.h
    if (b.l < l) l = b.l
  }
  if (Number.isNaN(c)) {
    const last = end >= 0 ? m1[end]!.c : closed[closed.length - 1]!.c
    o = h = l = c = last
  }
  return zlemaZone([...closed, { t: f, o, h, l, c }].map((b) => ({ high: b.h, low: b.l, close: b.c }))).zone
}

function angleAt(s: AngleSeries | undefined, step: number, T: number): number | null {
  if (!s) return null
  const i = lastAtOrBefore(s.ts, T - step)
  if (i < 0 || s.ts[i]! <= T - 3 * step) return null
  return s.a[i] ?? null
}

// [from, to] aralığındaki 5m kapanışlarının adayları; yalnız bütün değişkenleri dolu olanlar.
export async function buildCandidates(inp: Inputs, to: number, pause: Pause = noPause): Promise<Candidates> {
  const { m1, m5, snaps } = inp
  const t1m = m1.map((b) => b.t)
  const spread = (b: Bar1) => b.s ?? SIM.defaultSpreadUsd
  const avails = snaps.map((p) => p.avail)
  // Snapshot'tan sonra cluster'lardan birine ilk değme (o 1m mumunun kapanışı); karar en çok 60 dk sonraya kadar
  // olduğundan arama orada biter.
  const invalidFrom = snaps.map((p) => {
    const until = p.avail + SIM.maxSnapshotAgeMs + M1
    for (let i = lastAtOrBefore(t1m, p.t1 - 1) + 1; i < m1.length && m1[i]!.t <= until; i++) {
      const b = m1[i]!
      if (b.h >= p.up || b.l <= p.dn) return b.t + M1
    }
    return Infinity
  })
  const out: Candidates = { n: 0, T: [], long: [], P: [], near: [], far: [], R: [], exitT: [], zones: [], angles: [], snapId: [], from: null, to }
  const pct = SIM.tpPct / 100
  const slPct = SIM.slPct / 100
  let work = 0
  for (const b of m5) {
    const T = b.t + M5
    if (T > to) break
    const si = lastAtOrBefore(avails, T)
    if (si < 0) continue
    const sp = snaps[si]!
    if (Math.round((T - sp.avail) / M1) * M1 > SIM.maxSnapshotAgeMs) continue // o saatin heatmap'i yok (yaş dakikaya yuvarlı)
    if (T >= invalidFrom[si]!) continue
    const P = b.c
    const dUp = sp.up - P
    const dDn = P - sp.dn
    if (!(dUp > 0 && dDn > 0)) continue
    const long = dUp < dDn
    const near = long ? dUp : dDn
    const far = long ? dDn : dUp
    if (pct * near < SIM.minTpUsd) continue
    const tp = long ? P + pct * dUp : P - pct * dDn
    const sl = long ? P - slPct * dDn : P + slPct * dUp
    const k = lastAtOrBefore(t1m, T - 1) + 1
    if (k >= m1.length || m1[k]!.t - T > SIM.entryMaxGapMs) continue
    const e = m1[k]!
    const es = spread(e)
    if (long ? !(sl < e.o && e.o < tp) : !(sl > e.o + es && e.o + es > tp)) continue
    const zones: Zone[] = []
    for (const tf of Z_TFS) {
      const z = zoneForming(inp, tf, T)
      if (z === null) break
      zones.push(z)
    }
    if (zones.length < Z_TFS.length) continue
    const angles: number[] = []
    for (const a of ANGLE_KEYS) {
      const v = angleAt(inp.angles[`${a.metric}_${a.period}`], LS_PERIODS[a.period], T)
      if (v === null) break
      angles.push(v)
    }
    if (angles.length < ANGLE_KEYS.length) continue
    // işlem
    const entry = long ? e.o + es : e.o
    let exitT: number | null = null
    let exitPx: number | null = null
    for (let j = k; j < m1.length; j++) {
      const x = m1[j]!
      const xs = spread(x)
      if (long) {
        if (j > k && x.o <= sl) exitPx = x.o
        else if (j > k && x.o >= tp) exitPx = x.o
        else if (x.l <= sl) exitPx = sl
        else if (x.h >= tp) exitPx = tp
      } else {
        const ao = x.o + xs
        if (j > k && ao >= sl) exitPx = ao
        else if (j > k && ao <= tp) exitPx = ao
        else if (x.h + xs >= sl) exitPx = sl
        else if (x.l + xs <= tp) exitPx = tp
      }
      if (exitPx !== null) {
        exitT = x.t + M1
        break
      }
    }
    const R = exitPx === null ? null : long ? (exitPx - entry) / (entry - sl) : (entry - exitPx) / (sl - entry)
    out.T.push(T)
    out.long.push(long)
    out.P.push(P)
    out.near.push(near)
    out.far.push(far)
    out.R.push(R)
    out.exitT.push(exitT)
    out.zones.push(zones)
    out.angles.push(angles)
    out.snapId.push(sp.id)
    if (out.from === null) out.from = T
    if (++work % 200 === 0) await pause()
  }
  out.n = out.T.length
  return out
}

// ─── Arama ───────────────────────────────────────────────────────────────────────────────────────────────────
export type Stats = { n: number; sumR: number; avgR: number; win: number; maxDD: number }

const condKey = (c: Cond) => `${c[0]}\u0000${c[1]}`
const cmpCond = (a: Cond, b: Cond) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)

// Bir yönün adayları (zaman sırasıyla) ve koşul maskeleri (bit kümeleri).
export class SideSet {
  readonly side: Side
  readonly idx: number[] // Candidates içindeki sıra
  readonly n: number
  readonly T: Float64Array
  readonly R: Float64Array // açık işlem NaN
  readonly EX: Float64Array // açık işlem Infinity
  readonly words: number
  readonly keys: Cond[] = []
  readonly masks = new Map<string, Uint32Array>()

  constructor(c: Candidates, side: Side) {
    this.side = side
    const long = side === 'LONG'
    this.idx = []
    for (let i = 0; i < c.n; i++) if (c.long[i] === long) this.idx.push(i)
    this.n = this.idx.length
    this.T = Float64Array.from(this.idx, (i) => c.T[i]!)
    this.R = Float64Array.from(this.idx, (i) => c.R[i] ?? NaN)
    this.EX = Float64Array.from(this.idx, (i) => c.exitT[i] ?? Infinity)
    this.words = Math.ceil(this.n / 32)
    const same: Zone = long ? 'LONG' : 'SHORT'
    const opp: Zone = long ? 'SHORT' : 'LONG'
    const add = (cond: Cond, test: (i: number) => boolean) => {
      const m = new Uint32Array(this.words)
      this.idx.forEach((ci, k) => {
        if (test(ci)) m[k >> 5]! |= 1 << (k & 31)
      })
      this.keys.push(cond)
      this.masks.set(condKey(cond), m)
    }
    Z_TFS.forEach((tf, zi) => {
      const name = `ZLEMA ${tf}`
      add([name, 'ayni'], (i) => c.zones[i]![zi] === same)
      add([name, 'ters'], (i) => c.zones[i]![zi] === opp)
      add([name, 'notr'], (i) => c.zones[i]![zi] === 'NO_TRADE')
    })
    ANGLE_KEYS.forEach((a, ai) => {
      for (const b of A_BUCKETS) {
        const [sideWord, rest] = [b.slice(0, 4), b.slice(5)]
        add([a.name, b], (i) => {
          const v = c.angles[i]![ai]! * (long ? 1 : -1)
          if (Number.isNaN(v)) return false
          const m = Math.abs(v)
          const sideOk = sideWord === 'ayni' ? v >= 0 : v < 0
          const rangeOk = rest === '0_15' ? m < 15 : rest === '15_30' ? m >= 15 && m < 30 : m >= 30
          return sideOk && rangeOk
        })
      }
    })
    for (const [name, lo, hi] of RR_BUCKETS) {
      add([RR_NAME, name], (i) => {
        const rr = c.near[i]! / c.far[i]!
        return rr >= lo && rr < hi
      })
    }
  }

  mask(conds: Cond[], extra?: Uint32Array): Uint32Array {
    const m = new Uint32Array(this.words)
    if (conds.length === 0) {
      m.fill(0xffffffff)
      if (this.n % 32) m[this.words - 1] = (1 << (this.n % 32)) - 1 // >>> 0 gerekmez: & ile kullanılıyor
    } else {
      m.set(this.masks.get(condKey(conds[0]!))!)
      for (let k = 1; k < conds.length; k++) {
        const o = this.masks.get(condKey(conds[k]!))
        if (!o) throw new Error(`bilinmeyen koşul: ${conds[k]!.join(' ')}`)
        for (let w = 0; w < this.words; w++) m[w]! &= o[w]!
      }
    }
    if (extra) for (let w = 0; w < this.words; w++) m[w]! &= extra[w]!
    return m
  }

  has(c: Cond) {
    return this.masks.has(condKey(c))
  }

  // T'si `after`'dan büyük adaylar
  timeMask(after: number): Uint32Array {
    const m = new Uint32Array(this.words)
    for (let k = 0; k < this.n; k++) if (this.T[k]! > after) m[k >> 5]! |= 1 << (k & 31)
    return m
  }

  // Aynı anda tek pozisyon: maskedeki ilk adayı al, işlem kapanınca (kapanış mumunun sonu) sıradakini ara. Açık kalan
  // işlem sırayı bitirir ve sonuca girmez.
  take(mask: Uint32Array, R: Float64Array = this.R, EX: Float64Array = this.EX): number[] {
    const out: number[] = []
    let cur = -Infinity
    const T = this.T
    for (let w = 0; w < this.words; w++) {
      let bits = mask[w]!
      while (bits !== 0) {
        const b = 31 - Math.clz32(bits & -bits)
        bits &= bits - 1
        const k = (w << 5) | b
        if (T[k]! < cur) continue
        out.push(k)
        cur = EX[k]!
        if (!Number.isFinite(cur)) return out.filter((x) => !Number.isNaN(R[x]!))
      }
    }
    return out.filter((x) => !Number.isNaN(R[x]!))
  }
}

export function statsOf(r: number[]): Stats {
  const n = r.length
  if (n === 0) return { n: 0, sumR: 0, avgR: 0, win: 0, maxDD: 0 }
  let sum = 0
  let wins = 0
  let peak = 0
  let dd = 0
  for (const x of r) {
    sum += x
    if (x > 0) wins++
    if (sum > peak) peak = sum
    if (peak - sum > dd) dd = peak - sum
  }
  return { n, sumR: sum, avgR: sum / n, win: wins / n, maxDD: dd }
}

type Eval = { conds: Cond[]; level: number; n: number; sumR: number }

// Tekli ve ikili bütün kombinasyonlar, üçlü ve dörtlü en iyi `beam`'in üstüne birer koşul ekleyerek.
export async function search(s: SideSet, R: Float64Array, EX: Float64Array, pause: Pause = noPause): Promise<Eval[]> {
  const res: Eval[] = []
  let work = 0
  const ev = async (conds: Cond[], level: number) => {
    const sel = s.take(s.mask(conds), R, EX)
    let sum = 0
    for (const k of sel) sum += R[k]!
    const e = { conds, level, n: sel.length, sumR: sel.length ? sum : -1e9 }
    res.push(e)
    if (++work % 300 === 0) await pause()
    return e
  }
  const lvl: Record<number, Eval[]> = { 1: [], 2: [] }
  for (const k of s.keys) lvl[1]!.push(await ev([k], 1))
  for (let i = 0; i < s.keys.length; i++)
    for (let j = i + 1; j < s.keys.length; j++) if (s.keys[i]![0] !== s.keys[j]![0]) lvl[2]!.push(await ev([s.keys[i]!, s.keys[j]!], 2))
  for (const L of [3, 4]) {
    const prev = lvl[L - 1]!.filter((x) => x.n >= SIM.minTrades)
      .sort((a, b) => b.sumR - a.sumR)
      .slice(0, SIM.beam)
    const seen = new Set<string>()
    lvl[L] = []
    for (const p of prev) {
      const used = new Set(p.conds.map((c) => c[0]))
      for (const k of s.keys) {
        if (used.has(k[0])) continue
        const conds = [...p.conds, k].sort(cmpCond)
        const key = conds.map(condKey).join('\u0001')
        if (seen.has(key)) continue
        seen.add(key)
        lvl[L]!.push(await ev(conds, L))
      }
    }
  }
  return res
}

// numpy.percentile (doğrusal ara değer)
export function percentile(values: number[], q: number): number {
  if (values.length === 0) return NaN
  const v = [...values].sort((a, b) => a - b)
  const pos = (v.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return v[lo]! + (v[hi]! - v[lo]!) * (pos - lo)
}

// Tohumlu rastgele sayı (mulberry32): aynı veriyle aynı şans testi.
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Top = Stats & { conds: Cond[]; level: number; label: string; sel: number[] }
export type SideResult = {
  candidates: number
  base: Stats
  tested: number
  enough: number
  top: Top[]
  null: { runs: number; p50: number; p95: number; rank: number | null; values: number[] }
}

const SIDE_WORD: Record<string, string> = { ayni: 'aynı', ters: 'ters', notr: 'nötr' }
const RANGE_WORD: Record<string, string> = { '0_15': '0–15°', '15_30': '15–30°', '30': '30°+' }

export function condText(conds: Cond[]): string {
  return conds
    .map(([name, b]) => {
      if (name.startsWith('ZLEMA')) return `${name} ${SIDE_WORD[b] ?? b}`
      if (name === RR_NAME) return `${name} ${b}`
      const side = b.slice(0, 4)
      return `${name} ${SIDE_WORD[side] ?? side} ${RANGE_WORD[b.slice(5)] ?? b.slice(5)}`
    })
    .join(' · ')
}

export async function runSide(s: SideSet, seed: number, nullRuns: number = SIM.nullRuns, pause: Pause = noPause): Promise<SideResult> {
  const base = statsOf(s.take(s.mask([])).map((k) => s.R[k]!))
  const res = await search(s, s.R, s.EX, pause)
  const ranked = res.filter((x) => x.n >= SIM.minTrades).sort((a, b) => b.sumR - a.sumR)
  const top: Top[] = []
  const seenSets = new Set<string>()
  for (const x of ranked) {
    const sel = s.take(s.mask(x.conds))
    const key = sel.join(',')
    if (seenSets.has(key)) continue
    seenSets.add(key)
    top.push({ conds: x.conds, level: x.level, label: condText(x.conds), ...statsOf(sel.map((k) => s.R[k]!)), sel })
    if (top.length === SIM.topN) break
  }
  const rand = rng(seed)
  const values: number[] = []
  const N = s.n
  for (let run = 0; run < nullRuns && N > 10; run++) {
    const lo = Math.floor(0.1 * N)
    const hi = Math.floor(0.9 * N)
    const k = lo + Math.floor(rand() * (hi - lo))
    const R0 = new Float64Array(N)
    const EX0 = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      const j = (i + k) % N
      R0[i] = s.R[j]!
      EX0[i] = s.T[i]! + (s.EX[j]! - s.T[j]!)
    }
    const ok = (await search(s, R0, EX0, pause)).filter((x) => x.n >= SIM.minTrades)
    values.push(ok.length ? Math.max(...ok.map((x) => x.sumR)) : 0)
    await pause()
  }
  return {
    candidates: N,
    base,
    tested: res.length,
    enough: ranked.length,
    top,
    null: {
      runs: values.length,
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      rank: top.length && values.length ? values.filter((v) => v < top[0]!.sumR).length / values.length : null,
      values,
    },
  }
}

// ─── Birleşik ve eğriler ─────────────────────────────────────────────────────────────────────────────────────
type Leg = { s: SideSet; sel: number[] }
export type Merged = Stats & { overlapHours: number; curve: Array<[number, number]> }

// İki yuvanın işlemleri kapanış sırasıyla; aynı anda iki yönün de açık kaldığı süre.
export function merge(legs: Leg[]): Merged {
  const rows: Array<{ T: number; EX: number; R: number; side: Side }> = []
  for (const { s, sel } of legs) for (const k of sel) rows.push({ T: s.T[k]!, EX: s.EX[k]!, R: s.R[k]!, side: s.side })
  rows.sort((a, b) => a.EX - b.EX)
  const st = statsOf(rows.map((r) => r.R))
  let both = 0
  const L = rows.filter((r) => r.side === 'LONG')
  const S = rows.filter((r) => r.side === 'SHORT')
  for (const a of L) for (const b of S) both += Math.max(0, Math.min(a.EX, b.EX) - Math.max(a.T, b.T))
  let cum = 0
  const curve = rows.map((r): [number, number] => [r.EX, Math.round((cum += r.R) * 1000) / 1000])
  return { ...st, overlapHours: both / 3_600_000, curve }
}

// ─── Geçerlilik ──────────────────────────────────────────────────────────────────────────────────────────────
export type PrevRule = { side: Side; conds: Cond[]; label: string; rank: number; previous: { n: number; sumR: number; avgR: number } }
export type Verdict = 'tutuyor' | 'tutmuyor' | 'veri_az' | 'gecersiz'
export type RuleCheck = PrevRule & { forward: Stats | null; baseForward: Stats; verdict: Verdict }
export type Validation = {
  previousRunId: number
  from: number // önceki koşunun verisinin bittiği an; bundan sonraki kararlar
  to: number
  rules: RuleCheck[]
  combined: (Merged & { verdict: Verdict; baseForward: Merged }) | null
}

// Kural: en az 10 işlem; toplam R artıda ve işlem başına ortalama aynı dönemin filtresiz tabanından aşağı değil.
export function verdictOf(f: Stats, base: Stats): Verdict {
  if (f.n < SIM.validMinTrades) return 'veri_az'
  return f.sumR > 0 && f.avgR >= base.avgR ? 'tutuyor' : 'tutmuyor'
}

export function validate(sides: Record<Side, SideSet>, prev: { id: number; dataTo: number; rules: PrevRule[] }, to: number): Validation {
  const tm = { LONG: sides.LONG.timeMask(prev.dataTo), SHORT: sides.SHORT.timeMask(prev.dataTo) }
  const baseSel = { LONG: sides.LONG.take(tm.LONG), SHORT: sides.SHORT.take(tm.SHORT) }
  const baseSt = { LONG: statsOf(baseSel.LONG.map((k) => sides.LONG.R[k]!)), SHORT: statsOf(baseSel.SHORT.map((k) => sides.SHORT.R[k]!)) }
  const firstSel: Partial<Record<Side, number[]>> = {}
  const rules = prev.rules.map((r): RuleCheck => {
    const s = sides[r.side]
    if (!r.conds.every((c) => s.has(c))) return { ...r, forward: null, baseForward: baseSt[r.side], verdict: 'gecersiz' }
    const sel = s.take(s.mask(r.conds, tm[r.side]))
    if (r.rank === 1) firstSel[r.side] = sel
    const f = statsOf(sel.map((k) => s.R[k]!))
    return { ...r, forward: f, baseForward: baseSt[r.side], verdict: verdictOf(f, baseSt[r.side]) }
  })
  let combined: Validation['combined'] = null
  if (firstSel.LONG && firstSel.SHORT) {
    const m = merge([
      { s: sides.LONG, sel: firstSel.LONG },
      { s: sides.SHORT, sel: firstSel.SHORT },
    ])
    const b = merge([
      { s: sides.LONG, sel: baseSel.LONG },
      { s: sides.SHORT, sel: baseSel.SHORT },
    ])
    combined = { ...m, baseForward: b, verdict: verdictOf(m, b) }
  }
  return { previousRunId: prev.id, from: prev.dataTo, to, rules, combined }
}

// ─── Koşu ────────────────────────────────────────────────────────────────────────────────────────────────────
export type MonthRow = { month: string; days: number; heatmapHours: number; decisions: number; baseTrades: number; baseSumR: number }

export type SimResults = {
  engine: string
  params: typeof SIM & { zlema: 'olusan' }
  data: { from: number | null; to: number; candidates: Record<Side, number>; months: MonthRow[] }
  sides: Record<Side, Omit<SideResult, 'top'> & { top: Array<Omit<Top, 'sel'>> }>
  combined: (Merged & { nullSumP50: number; nullSumP95: number }) | null
  base2: Merged
  validation: Validation | null
  rules: PrevRule[] // bu koşunun seçtikleri (sonraki koşu bunları denetler)
}

const monthKey = (t: number) => {
  const d = new Date(t + IST)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export async function runSim(
  inp: Inputs,
  opts: { to: number; previous: { id: number; dataTo: number; rules: PrevRule[] } | null; nullRuns?: number; seed?: number },
  pause: Pause = noPause,
): Promise<SimResults> {
  const c = await buildCandidates(inp, opts.to, pause)
  const sides = { LONG: new SideSet(c, 'LONG'), SHORT: new SideSet(c, 'SHORT') }
  const seed = opts.seed ?? 42
  const L = await runSide(sides.LONG, seed, opts.nullRuns, pause)
  const S = await runSide(sides.SHORT, seed + 1, opts.nullRuns, pause)
  let combined: SimResults['combined'] = null
  if (L.top[0] && S.top[0]) {
    const m = merge([
      { s: sides.LONG, sel: L.top[0].sel },
      { s: sides.SHORT, sel: S.top[0].sel },
    ])
    const pair = L.null.values.slice(0, Math.min(L.null.values.length, S.null.values.length)).map((v, i) => v + S.null.values[i]!)
    combined = { ...m, nullSumP50: percentile(pair, 0.5), nullSumP95: percentile(pair, 0.95) }
  }
  const baseSel = { LONG: sides.LONG.take(sides.LONG.mask([])), SHORT: sides.SHORT.take(sides.SHORT.mask([])) }
  const base2 = merge([
    { s: sides.LONG, sel: baseSel.LONG },
    { s: sides.SHORT, sel: baseSel.SHORT },
  ])
  // aylara göre kapsam (İstanbul ayı): gün, heatmap'li saat, karar noktası, filtresiz taban (iki yuva)
  const months = new Map<string, MonthRow>()
  const row = (key: string) => {
    let r = months.get(key)
    if (!r) months.set(key, (r = { month: key, days: 0, heatmapHours: 0, decisions: 0, baseTrades: 0, baseSumR: 0 }))
    return r
  }
  if (c.from !== null) {
    for (let t = c.from; t <= opts.to; t += 86_400_000) row(monthKey(t))
    for (const p of inp.snaps) if (p.avail >= c.from - SIM.maxSnapshotAgeMs && p.avail <= opts.to) row(monthKey(p.avail)).heatmapHours++
    for (const t of c.T) row(monthKey(t)).decisions++
    for (const side of ['LONG', 'SHORT'] as Side[])
      for (const k of baseSel[side]) {
        const r = row(monthKey(sides[side].T[k]!))
        r.baseTrades++
        r.baseSumR += sides[side].R[k]!
      }
    // gün sayısı: aralığın o aya düşen kısmı
    for (const r of months.values()) {
      const [y, m] = r.month.split('-').map(Number) as [number, number]
      const start = Math.max(c.from, Date.UTC(y, m - 1, 1) - IST)
      const end = Math.min(opts.to, Date.UTC(y, m, 1) - IST)
      r.days = Math.round(((end - start) / 86_400_000) * 10) / 10
      r.baseSumR = Math.round(r.baseSumR * 100) / 100
    }
  }
  const strip = (r: SideResult) => ({ ...r, top: r.top.map(({ sel: _sel, ...t }) => t) })
  // sonraki koşunun denetleyeceği bulgular: en iyi 10'dan toplam R'si artıda olanlar (eksidekiler bulgu değil)
  const rules: PrevRule[] = []
  for (const [side, r] of [
    ['LONG', L],
    ['SHORT', S],
  ] as const)
    r.top.forEach((t, i) => {
      if (t.sumR > 0) rules.push({ side, conds: t.conds, label: t.label, rank: i + 1, previous: { n: t.n, sumR: t.sumR, avgR: t.avgR } })
    })
  return {
    engine: SIM_ENGINE,
    params: { ...SIM, zlema: 'olusan' },
    data: { from: c.from, to: opts.to, candidates: { LONG: sides.LONG.n, SHORT: sides.SHORT.n }, months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)) },
    sides: { LONG: strip(L), SHORT: strip(S) },
    combined,
    base2,
    validation: opts.previous ? validate(sides, opts.previous, opts.to) : null,
    rules,
  }
}
