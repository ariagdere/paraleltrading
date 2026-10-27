import { db } from './db'
import type { Direction, RealTrade, SimDecision } from './validation'

// Doğrulama sayfasının okumaları: core'un naif kararları ve eski sistemin gerçek naif işlemleri (magic 7575).

export const NAIVE_VERSION = 'v1'
const MAGIC = 7575

type DecisionRow = {
  snapshot_id: string
  apify_run_id: string | null
  source: 'old_db' | 'collector'
  cycle_at: Date
  decided_at: Date
  in_window: boolean
  direction: Direction | null
  tp: number | null
  sl: number | null
  rr: number | null
  zone_4h: string | null
  aligned: boolean
  signal: boolean
  reason: string | null
  entry_bid: number | null
  entry_price: number | null
  spread: number | null
  exit_at: Date | null
  exit_reason: 'TP' | 'SL' | null
  exit_price: number | null
  r_multiple: number | null
  ambiguous: boolean | null
}

type OrderRow = {
  id: string
  direction: string
  status: string
  opened_at: Date
  closed_at: Date | null
  fill: string | null
  sl: string | null
  tp: string | null
  close: string | null
  exit_reason: string | null
  volume: string | null
  pnl: string | null
  run: string | null
}

export type Validation = { now: Date; decisions: SimDecision[]; reals: RealTrade[]; computedAt: Date | null }

const num = (v: string | null) => (v === null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)

// Kararlar tablosu yoksa (core henüz kurmadı) null.
export async function loadValidation(): Promise<Validation | null> {
  const pool = db()
  try {
    const [now, dec, comp] = await Promise.all([
      pool.query<{ now: Date }>('SELECT now() AS now'),
      pool.query<DecisionRow>(
        `SELECT d.snapshot_id, s.apify_run_id, s.source, d.cycle_at, d.decided_at, d.in_window, d.direction, d.tp, d.sl, d.rr, d.zone_4h, d.aligned,
                d.signal, d.reason, d.entry_bid, d.entry_price, d.spread, d.exit_at, d.exit_reason, d.exit_price, d.r_multiple, d.ambiguous
         FROM naive_decisions d JOIN heatmap_snapshots s ON s.id = d.snapshot_id
         WHERE d.version = $1 ORDER BY d.cycle_at`,
        [NAIVE_VERSION],
      ),
      pool.query<{ at: Date | null }>(`SELECT max(computed_at) AS at FROM naive_decisions WHERE version = $1`, [NAIVE_VERSION]),
    ])
    const decisions = dec.rows.map(
      (r): SimDecision => ({
        snapshotId: Number(r.snapshot_id),
        runId: r.apify_run_id,
        source: r.source,
        cycleAt: r.cycle_at.getTime(),
        decidedAt: r.decided_at.getTime(),
        inWindow: r.in_window,
        direction: r.direction,
        tp: r.tp,
        sl: r.sl,
        rr: r.rr,
        zone: r.zone_4h,
        aligned: r.aligned,
        signal: r.signal,
        reason: r.reason,
        entryBid: r.entry_bid,
        entryPrice: r.entry_price,
        spread: r.spread,
        exitAt: r.exit_at?.getTime() ?? null,
        exitReason: r.exit_reason,
        exitPrice: r.exit_price,
        r: r.r_multiple,
        ambiguous: r.ambiguous,
      }),
    )
    const from = decisions[0] ? new Date(decisions[0].cycleAt - 30 * 60_000) : null
    const reals = from
      ? (
          await pool.query<OrderRow>(
            `SELECT id, direction, status, opened_at, closed_at, data->>'fill_price' AS fill, data->>'sl' AS sl, data->>'tp' AS tp,
                    data->>'close_price' AS close, data->>'exit_reason' AS exit_reason, data->>'volume' AS volume, data->>'realized_pnl' AS pnl,
                    data->>'apify_run_id' AS run
             FROM legacy_orders WHERE magic = $1 AND opened_at >= $2 ORDER BY opened_at`,
            [MAGIC, from],
          )
        ).rows.map(
          (r): RealTrade => ({
            id: Number(r.id),
            direction: r.direction === 'BUY' ? 'LONG' : 'SHORT',
            openedAt: r.opened_at.getTime(),
            closedAt: r.closed_at?.getTime() ?? null,
            fill: num(r.fill),
            sl: num(r.sl),
            tp: num(r.tp),
            close: num(r.close),
            exitReason: r.exit_reason,
            volume: num(r.volume),
            pnl: num(r.pnl),
            runId: r.run,
            status: r.status,
          }),
        )
      : []
    return { now: now.rows[0]!.now, decisions, reals, computedAt: comp.rows[0]?.at ?? null }
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') return null
    throw err
  }
}
