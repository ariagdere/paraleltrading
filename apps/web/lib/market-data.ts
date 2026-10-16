import { gunzipSync } from 'node:zlib'
import { db } from './db'
import { decodeHeatmap, type HeatGrid } from './heatmap'

// Piyasa sayfasının okumaları. Fiyat kaynağı Axi BTCUSD (axi_candles); heatmap seviyeleri bazla Axi fiyatına
// kaydırılır.

export const SYMBOL = process.env.AXI_SYMBOL || 'BTCUSD'
export const SPANS = ['12h', '24h', '48h'] as const
export type Span = (typeof SPANS)[number]
export const isSpan = (s: unknown): s is Span => typeof s === 'string' && (SPANS as readonly string[]).includes(s)

export type Zone = 'LONG' | 'SHORT' | 'NO_TRADE'
export type Quote = { price: number; at: Date; prevClose: number | null }
export type IndicatorRow = { tf: string; openTime: Date; zone: Zone | null; rsi: number | null; atr: number | null }
export type AngleRow = { metric: 'global' | 'top_position'; period: string; ts: Date; angle: number | null }
export type RatioRow = { metric: 'global' | 'top_position'; ts: Date; ratio: number }
export type BiasRow = {
  committedAt: Date
  runDate: string
  bias: 'LONG' | 'NEUTRAL' | 'SHORT'
  confidence: 'LOW' | 'MEDIUM' | 'HIGH'
  netDirection: string
  score: number
  conclusion: string | null
}
export type Market = {
  now: Date
  quote: Quote | null
  basis: number | null // en yeni 24h snapshot'ının bazı (CoinGlass − Axi)
  indicators: IndicatorRow[]
  angles: AngleRow[]
  ratios: RatioRow[]
  bias: BiasRow | null
}

export async function loadMarket(): Promise<Market> {
  const pool = db()
  const [now, last, prev, ind, ang, rat, bias, basis] = await Promise.all([
    pool.query<{ now: Date }>('SELECT now() AS now'),
    pool.query<{ close: number; t: Date }>(
      `SELECT close, open_time + interval '1 minute' AS t FROM axi_candles
       WHERE symbol = $1 AND timeframe = '1m' ORDER BY open_time DESC LIMIT 1`,
      [SYMBOL],
    ),
    pool.query<{ close: number }>(`SELECT close FROM axi_candles WHERE symbol = $1 AND timeframe = '1d' ORDER BY open_time DESC LIMIT 1`, [SYMBOL]),
    pool.query<{ timeframe: string; open_time: Date; zlema_zone: Zone | null; rsi14: number | null; atr14: number | null }>(
      `SELECT DISTINCT ON (timeframe) timeframe, open_time, zlema_zone, rsi14, atr14
       FROM axi_indicators WHERE symbol = $1 ORDER BY timeframe, open_time DESC`,
      [SYMBOL],
    ),
    pool.query<{ metric: 'global' | 'top_position'; period: string; ts: Date; angle: number }>(
      `SELECT DISTINCT ON (metric, period) metric, period, ts, angle
       FROM lsr_angles WHERE angle IS NOT NULL ORDER BY metric, period, ts DESC`,
    ),
    pool.query<{ metric: 'global' | 'top_position'; ts: Date; long_short_ratio: number }>(
      `SELECT DISTINCT ON (metric) metric, ts, long_short_ratio FROM lsr_series ORDER BY metric, ts DESC`,
    ),
    pool.query<{
      committed_at: Date
      run_date: string
      bias: BiasRow['bias']
      confidence: BiasRow['confidence']
      net_direction: string
      sentiment_score: number
      conclusion: string | null
    }>(
      `SELECT committed_at, run_date, bias, confidence, net_direction, sentiment_score, conclusion
       FROM daily_bias ORDER BY committed_at DESC LIMIT 1`,
    ),
    pool.query<{ basis: number | null }>(`SELECT basis FROM heatmap_levels WHERE span = '24h' ORDER BY received_at DESC LIMIT 1`),
  ])
  const l = last.rows[0]
  const b = bias.rows[0]
  return {
    now: now.rows[0]!.now,
    quote: l ? { price: l.close, at: l.t, prevClose: prev.rows[0]?.close ?? null } : null,
    basis: basis.rows[0]?.basis ?? null,
    indicators: ind.rows.map((r) => ({ tf: r.timeframe, openTime: r.open_time, zone: r.zlema_zone, rsi: r.rsi14, atr: r.atr14 })),
    angles: ang.rows.map((r) => ({ metric: r.metric, period: r.period, ts: r.ts, angle: r.angle })),
    ratios: rat.rows.map((r) => ({ metric: r.metric, ts: r.ts, ratio: r.long_short_ratio })),
    bias: b
      ? {
          committedAt: b.committed_at,
          runDate: b.run_date,
          bias: b.bias,
          confidence: b.confidence,
          netDirection: b.net_direction,
          score: b.sentiment_score,
          conclusion: b.conclusion,
        }
      : null,
  }
}

// rank: core'daki sıra (1 en büyük cluster, eski sistemin cluster'ı); liste fiyata göre yakından uzağa.
export type Cluster = { rank: number; price: number; usd: number }
export type HeatView = {
  span: Span
  snapshot: { id: number; at: string } // at: heatmap'in alındığı an (received_at)
  prevId: number | null
  nextId: number | null
  basis: number | null
  ref: number | null // CoinGlass referans fiyatı (kaydırılmamış)
  up: Cluster[] // Axi fiyatına kaydırılmış, fiyata göre yakından uzağa; numara core'daki sıra (up1 en büyük)
  dn: Cluster[]
  upLiq: number[] // referansın %1/2/3 yukarısına kadar (USD)
  dnLiq: number[]
  grid: HeatGrid | null
}

type LevelsRow = {
  basis: number | null
  ref_price: number | null
  up1_price: number | null
  up1_usd: number | null
  up2_price: number | null
  up2_usd: number | null
  up3_price: number | null
  up3_usd: number | null
  dn1_price: number | null
  dn1_usd: number | null
  dn2_price: number | null
  dn2_usd: number | null
  dn3_price: number | null
  dn3_usd: number | null
  up_liq_1pct: number | null
  up_liq_2pct: number | null
  up_liq_3pct: number | null
  dn_liq_1pct: number | null
  dn_liq_2pct: number | null
  dn_liq_3pct: number | null
}

const clusters = (l: LevelsRow, side: 'up' | 'dn', shift: number): Cluster[] => {
  const out: Cluster[] = []
  for (const i of [1, 2, 3] as const) {
    const price = l[`${side}${i}_price` as keyof LevelsRow]
    const usd = l[`${side}${i}_usd` as keyof LevelsRow]
    if (price !== null && usd !== null) out.push({ rank: i, price: price - shift, usd })
  }
  return out.sort((a, b) => (side === 'up' ? a.price - b.price : b.price - a.price))
}

// Bir pencerenin snapshot'ı (id verilmezse en yenisi), seviyeleri ve ısı ızgarası.
export async function loadHeatView(span: Span, id: number | null): Promise<HeatView | null> {
  const pool = db()
  const { rows: snaps } = await pool.query<{ id: string; received_at: Date; payload_gz: Buffer }>(
    id === null
      ? `SELECT id, received_at, payload_gz FROM heatmap_snapshots WHERE span = $1 ORDER BY received_at DESC LIMIT 1`
      : `SELECT id, received_at, payload_gz FROM heatmap_snapshots WHERE span = $1 AND id = $2`,
    id === null ? [span] : [span, id],
  )
  const s = snaps[0]
  if (!s) return null
  const sid = Number(s.id)
  const [lv, nb] = await Promise.all([
    pool.query<LevelsRow>(`SELECT * FROM heatmap_levels WHERE snapshot_id = $1`, [sid]),
    pool.query<{ prev: string | null; next: string | null }>(
      `SELECT (SELECT id FROM heatmap_snapshots WHERE span = $1 AND received_at < $2 ORDER BY received_at DESC LIMIT 1) AS prev,
              (SELECT id FROM heatmap_snapshots WHERE span = $1 AND received_at > $2 ORDER BY received_at LIMIT 1) AS next`,
      [span, s.received_at],
    ),
  ])
  const l = lv.rows[0] ?? null
  const basis = l?.basis ?? null
  let grid: HeatGrid | null = null
  try {
    grid = decodeHeatmap(JSON.parse(gunzipSync(s.payload_gz).toString()), basis)
  } catch {
    grid = null
  }
  const shift = basis ?? 0
  return {
    span,
    snapshot: { id: sid, at: s.received_at.toISOString() },
    prevId: nb.rows[0]?.prev ? Number(nb.rows[0].prev) : null,
    nextId: nb.rows[0]?.next ? Number(nb.rows[0].next) : null,
    basis,
    ref: l?.ref_price ?? null,
    up: l ? clusters(l, 'up', shift) : [],
    dn: l ? clusters(l, 'dn', shift) : [],
    upLiq: l ? [l.up_liq_1pct ?? 0, l.up_liq_2pct ?? 0, l.up_liq_3pct ?? 0] : [],
    dnLiq: l ? [l.dn_liq_1pct ?? 0, l.dn_liq_2pct ?? 0, l.dn_liq_3pct ?? 0] : [],
    grid,
  }
}
