// Doğrulama: core'un naif kararları (naive_decisions) ile eski sistemin gerçek naif işlemlerinin (legacy_orders, magic
// 7575) eşleştirilmesi ve özetleri. Saf hesap; veritabanına dokunmaz (okuma lib/validation-data.ts'te).
//
// Eşleşme: gerçek işlemin Apify çalıştırması kararın snapshot'ıyla aynıysa birebir (eski sistemden kopyalanan
// snapshot'lar, 15 Ekim'e kadar). Değilse (sonrasında eski sistemin snapshot'ları kopyalanmıyor, yeni sistem kendi
// saatlik snapshot'larıyla karar veriyor) döngüsü işlemin açılışına en yakın karar, ±20 dk içinde; aynı yönde sinyal
// varsa o.

export type Direction = 'LONG' | 'SHORT'

export type RealTrade = {
  id: number
  direction: Direction
  openedAt: number
  closedAt: number | null
  fill: number | null
  sl: number | null
  tp: number | null
  close: number | null
  exitReason: string | null
  volume: number | null
  pnl: number | null
  runId: string | null
  status: string
}

export type SimDecision = {
  snapshotId: number
  runId: string | null
  source: 'old_db' | 'collector'
  cycleAt: number
  decidedAt: number
  inWindow: boolean
  direction: Direction | null
  tp: number | null
  sl: number | null
  rr: number | null
  zone: string | null
  aligned: boolean
  signal: boolean
  reason: string | null
  entryBid: number | null
  entryPrice: number | null
  spread: number | null
  exitAt: number | null
  exitReason: 'TP' | 'SL' | null
  exitPrice: number | null
  r: number | null
  ambiguous: boolean | null
}

export type Pair = { real: RealTrade; sim: SimDecision | null; match: 'run' | 'time' | null }

const TIME_MATCH_MS = 20 * 60_000

// Gerçek işlemin R'si: dolum ve SL'e göre; açık işlemde null.
export function realR(t: RealTrade): number | null {
  if (t.fill === null || t.sl === null || t.close === null || t.closedAt === null) return null
  const risk = t.direction === 'LONG' ? t.fill - t.sl : t.sl - t.fill
  if (!(risk > 0)) return null
  return (t.direction === 'LONG' ? t.close - t.fill : t.fill - t.close) / risk
}

export function pairTrades(reals: RealTrade[], decisions: SimDecision[]): { pairs: Pair[]; unmatchedSignals: SimDecision[] } {
  const byRun = new Map<string, SimDecision>()
  for (const d of decisions) if (d.runId) byRun.set(d.runId, d)
  const used = new Set<number>()
  const pairs: Pair[] = []
  const sorted = [...decisions].sort((a, b) => a.cycleAt - b.cycleAt)
  for (const t of [...reals].sort((a, b) => a.openedAt - b.openedAt)) {
    const exact = t.runId ? byRun.get(t.runId) : undefined
    if (exact) {
      used.add(exact.snapshotId)
      pairs.push({ real: t, sim: exact, match: 'run' })
      continue
    }
    // yakın kararlar: önce aynı yönde, kullanılmamış sinyal; yoksa en yakın karar
    const near = sorted.filter((d) => Math.abs(d.cycleAt - t.openedAt) <= TIME_MATCH_MS && !used.has(d.snapshotId))
    const dist = (d: SimDecision) => Math.abs(d.cycleAt - t.openedAt)
    const best = near.filter((d) => d.signal && d.direction === t.direction).sort((a, b) => dist(a) - dist(b))[0] ?? near.sort((a, b) => dist(a) - dist(b))[0]
    if (best) {
      used.add(best.snapshotId)
      pairs.push({ real: t, sim: best, match: 'time' })
    } else pairs.push({ real: t, sim: null, match: null })
  }
  return { pairs, unmatchedSignals: decisions.filter((d) => d.signal && !used.has(d.snapshotId)) }
}

export type Stats = {
  decisions: number
  signals: number
  reals: number
  paired: number // gerçek işlemin karşılığında sinyal var
  sameTp: number
  sameSl: number
  closedBoth: number // ikisi de kapanmış eşleşmeler
  sameExit: number
  realR: number // eşleşen ve ikisi de kapanmışlarda
  simR: number
  realOnlyR: number // karşılığında sinyal olmayan gerçek işlemler
  simOnlyR: number // gerçek karşılığı olmayan sinyaller (kapanmış)
  missedByReason: Record<string, number> // gerçek işlem var, sinyal yok: neden
  simOnly: number
}

const near = (a: number | null, b: number | null, tol = 0.015) => a !== null && b !== null && Math.abs(a - b) <= tol

export function summarize(pairs: Pair[], unmatchedSignals: SimDecision[], decisions: SimDecision[]): Stats {
  const s: Stats = {
    decisions: decisions.length,
    signals: decisions.filter((d) => d.signal).length,
    reals: pairs.length,
    paired: 0,
    sameTp: 0,
    sameSl: 0,
    closedBoth: 0,
    sameExit: 0,
    realR: 0,
    simR: 0,
    realOnlyR: 0,
    simOnlyR: 0,
    missedByReason: {},
    simOnly: unmatchedSignals.length,
  }
  for (const p of pairs) {
    const rr = realR(p.real)
    if (p.sim?.signal) {
      s.paired++
      if (near(p.real.tp, p.sim.tp)) s.sameTp++
      if (near(p.real.sl, p.sim.sl)) s.sameSl++
      if (rr !== null && p.sim.r !== null) {
        s.closedBoth++
        s.realR += rr
        s.simR += p.sim.r
        if (p.real.exitReason === p.sim.exitReason) s.sameExit++
      }
    } else {
      const why = p.sim ? (p.sim.reason ?? 'sinyal_yok') : 'karar_yok'
      s.missedByReason[why] = (s.missedByReason[why] ?? 0) + 1
      if (rr !== null) s.realOnlyR += rr
    }
  }
  for (const d of unmatchedSignals) if (d.r !== null) s.simOnlyR += d.r
  return s
}

// Dağılımın yüzdelikleri (doğrusal ara değer); boş dizide null.
export function quantiles(values: number[], qs: number[]): (number | null)[] {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length === 0) return qs.map(() => null)
  return qs.map((q) => {
    const i = q * (v.length - 1)
    const lo = Math.floor(i)
    const hi = Math.ceil(i)
    return v[lo]! + (v[hi]! - v[lo]!) * (i - lo)
  })
}

export type Calibration = {
  n: number
  entry: (number | null)[] // gerçek dolum − benzetim girişi, aleyhe pozitif ($): p10, p50, p90
  latency: (number | null)[] // gerçek açılış − karar anı (sn)
  tpFill: (number | null)[] // TP'de kapanan: kapanış − TP, lehe pozitif ($)
  slFill: (number | null)[] // SL'de kapanan: kapanış − SL, aleyhe pozitif ($)
  exitLag: (number | null)[] // aynı sonuçta çıkış anı farkı (dk; gerçek − benzetim)
}

const Q = [0.1, 0.5, 0.9]

export function calibrate(pairs: Pair[]): Calibration {
  const entry: number[] = []
  const latency: number[] = []
  const tpFill: number[] = []
  const slFill: number[] = []
  const exitLag: number[] = []
  let n = 0
  for (const { real: t, sim: d } of pairs) {
    if (!d?.signal || d.entryPrice === null) continue
    n++
    const long = t.direction === 'LONG'
    if (t.fill !== null) entry.push(long ? t.fill - d.entryPrice : d.entryPrice - t.fill)
    latency.push((t.openedAt - d.decidedAt) / 1000)
    if (t.close !== null && t.exitReason === 'TP' && t.tp !== null) tpFill.push(long ? t.close - t.tp : t.tp - t.close)
    if (t.close !== null && t.exitReason === 'SL' && t.sl !== null) slFill.push(long ? t.sl - t.close : t.close - t.sl)
    if (t.closedAt !== null && d.exitAt !== null && t.exitReason === d.exitReason) exitLag.push((t.closedAt - d.exitAt) / 60_000)
  }
  return {
    n,
    entry: quantiles(entry, Q),
    latency: quantiles(latency, Q),
    tpFill: quantiles(tpFill, Q),
    slFill: quantiles(slFill, Q),
    exitLag: quantiles(exitLag, Q),
  }
}
