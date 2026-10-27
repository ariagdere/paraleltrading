import type { Pool } from '@pt/db'
import { SYMBOL } from '../sync.js'
import { LS_METRICS, LS_PERIODS, SIM, ZTF, Z_TFS, type AngleSeries, type Bar, type Bar1, type Inputs, type Snap } from './engine.js'

// Motorun girdileri veritabanından: Axi mumları (1m ve 5m SIM_FROM'dan; 15m, 1h, 4h, 1d ZLEMA ısınması için 151 mum
// öncesinden), 12h heatmap seviyeleri (bazı ve 1. cluster'ları olanlar), L/S açıları. Spread mumun spread_points'i ×
// sembolün point değeri (yoksa 0,01).

export const SIM_FROM = new Date(process.env.SIM_FROM || '2026-09-17T00:00:00Z')
const DEFAULT_POINT = 0.01
const ms = (col: string) => `(extract(epoch FROM ${col}) * 1000)::bigint::text`

type CandleRow = { t: string; o: number; h: number; l: number; c: number; sp: number | null }

async function candles(pool: Pool, tf: string, from: Date, to: Date): Promise<CandleRow[]> {
  const { rows } = await pool.query<CandleRow>(
    `SELECT ${ms('open_time')} AS t, open AS o, high AS h, low AS l, close AS c, spread_points AS sp
     FROM axi_candles WHERE symbol = $1 AND timeframe = $2 AND open_time >= $3 AND open_time < $4 ORDER BY open_time`,
    [SYMBOL, tf, from, to],
  )
  return rows
}

const bar = (r: CandleRow): Bar => ({ t: Number(r.t), o: r.o, h: r.h, l: r.l, c: r.c })

// to: verinin kesildiği an (bu andan sonra açılan mum, gelen heatmap ve L/S noktası okunmaz).
export async function loadInputs(pool: Pool, to: Date): Promise<Inputs> {
  const {
    rows: [spec],
  } = await pool.query<{ point: number | null }>(`SELECT (spec->>'point')::float8 AS point FROM axi_symbol_spec WHERE symbol = $1 ORDER BY captured_at DESC LIMIT 1`, [
    SYMBOL,
  ])
  const point = spec?.point && spec.point > 0 ? spec.point : DEFAULT_POINT
  const from = SIM_FROM
  const [m1, m5, ...tfRows] = await Promise.all([
    candles(pool, '1m', from, to),
    candles(pool, '5m', from, to),
    ...Z_TFS.map((tf) => candles(pool, tf, new Date(from.getTime() - (SIM.zlemaBars + 1) * ZTF[tf]), to)),
  ])
  const tf = Object.fromEntries(Z_TFS.map((k, i) => [k, tfRows[i]!.map(bar)])) as Inputs['tf']

  const { rows: snapRows } = await pool.query<{ id: string; avail: string; t1: string; up: number; dn: number }>(
    `SELECT s.id, ${ms('s.received_at')} AS avail, ${ms('coalesce(s.last_col_time, s.update_time, s.received_at)')} AS t1,
            l.up1_price - l.basis AS up, l.dn1_price - l.basis AS dn
     FROM heatmap_snapshots s JOIN heatmap_levels l ON l.snapshot_id = s.id
     WHERE s.span = $1 AND l.basis IS NOT NULL AND l.up1_price IS NOT NULL AND l.dn1_price IS NOT NULL
       AND s.received_at >= $2 AND s.received_at <= $3
     ORDER BY s.received_at, s.id`,
    [SIM.span, new Date(from.getTime() - 86_400_000), to],
  )
  const snaps: Snap[] = snapRows.map((r) => ({ id: Number(r.id), avail: Number(r.avail), t1: Number(r.t1), up: r.up, dn: r.dn }))

  const angles: Record<string, AngleSeries> = {}
  for (const [metric] of LS_METRICS) {
    for (const [period, step] of Object.entries(LS_PERIODS)) {
      const { rows } = await pool.query<{ t: string; a: number | null }>(
        `SELECT ${ms('ts')} AS t, angle AS a FROM lsr_angles WHERE metric = $1 AND period = $2 AND ts >= $3 AND ts <= $4 ORDER BY ts`,
        [metric, period, new Date(from.getTime() - 4 * step), to],
      )
      angles[`${metric}_${period}`] = { ts: rows.map((r) => Number(r.t)), a: rows.map((r) => r.a) }
    }
  }

  return {
    m1: m1.map((r): Bar1 => ({ ...bar(r), s: r.sp === null ? null : r.sp * point })),
    m5: m5.map(bar),
    tf,
    snaps,
    angles,
  }
}
