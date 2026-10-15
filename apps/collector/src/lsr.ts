import { logRun, markFail, markOk, type Pool } from '@pt/db'
import { config } from './config.js'

// Binance L/S oranları, 5m: global (hesap oranı) ve top_position (TT pozisyon oranı). Her tur son kayıttan
// bugüne boşluğu doldurur; servis bir süre kapalı kalsa da açılışta kendini tamamlar. İlk açılışta
// LSR_BACKFILL_FROM'dan başlar; Binance yalnız son 30 günü verdiği için o sınıra kırpılır.

const STEP_MS = 5 * 60_000
const HISTORY_MS = 30 * 24 * 3_600_000 - 10 * 60_000
const PAGE = 500
const ENDPOINT = {
  global: '/futures/data/globalLongShortAccountRatio',
  top_position: '/futures/data/topLongShortPositionRatio',
} as const
type Metric = keyof typeof ENDPOINT
type Point = { timestamp: number | string; longAccount: string; shortAccount: string; longShortRatio: string }

async function fetchRange(metric: Metric, fromMs: number, toMs: number): Promise<Point[]> {
  const out: Point[] = []
  for (let t = fromMs; t <= toMs; t += PAGE * STEP_MS) {
    const end = Math.min(t + PAGE * STEP_MS - 1, toMs)
    const url =
      `${config.binance.baseUrl}${ENDPOINT[metric]}?symbol=${config.binance.symbol}` +
      `&period=5m&limit=${PAGE}&startTime=${t}&endTime=${end}`
    const res = await fetch(url)
    const text = await res.text()
    if (!res.ok) throw new Error(`Binance ${metric}: HTTP ${res.status} ${text.slice(0, 200)}`)
    out.push(...(JSON.parse(text) as Point[]))
  }
  return out.filter((p) => Number.isFinite(Number(p.timestamp)) && Number.isFinite(Number(p.longShortRatio)))
}

export async function syncLsr(pool: Pool) {
  for (const metric of Object.keys(ENDPOINT) as Metric[]) {
    const source = `lsr:${metric}`
    const startedAt = new Date()
    try {
      const { rows } = await pool.query<{ last: Date | null }>(
        'SELECT max(ts) AS last FROM lsr_series WHERE metric = $1',
        [metric],
      )
      const last = rows[0]?.last ?? null
      const now = Date.now()
      const from = Math.max(last ? last.getTime() + STEP_MS : config.binance.backfillFrom, now - HISTORY_MS)
      const points = from <= now ? await fetchRange(metric, from, now) : []
      const ts = points.map((p) => Number(p.timestamp))
      const num = (v: string) => (Number.isFinite(Number(v)) ? Number(v) : null)
      const res = await pool.query(
        `INSERT INTO lsr_series (metric, ts, long_account, short_account, long_short_ratio)
         SELECT $1, to_timestamp(t / 1000.0), la, sa, r
         FROM unnest($2::bigint[], $3::float8[], $4::float8[], $5::float8[]) AS u(t, la, sa, r)
         ON CONFLICT (metric, ts) DO NOTHING`,
        [
          metric,
          ts,
          points.map((p) => num(p.longAccount)),
          points.map((p) => num(p.shortAccount)),
          points.map((p) => Number(p.longShortRatio)),
        ],
      )
      if ((res.rowCount ?? 0) > 1) console.log(`[lsr] ${metric}: ${res.rowCount} nokta yazıldı`)
      await markOk(pool, source, '5 minutes', ts.length ? new Date(Math.max(...ts)) : last)
    } catch (err) {
      const msg = (err as Error).message
      console.error(`[lsr] ${metric}: ${msg}`)
      await logRun(pool, { source, startedAt, ok: false, error: msg })
      await markFail(pool, source, '5 minutes', msg)
    }
  }
}
