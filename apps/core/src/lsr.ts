import { logRun, markFail, markOk, type Pool } from '@pt/db'
import { angleSeries } from './angles.js'

// L/S açıları: her metrik için 5m serisi değiştiğinde (yeni nokta ya da geçmişe eklenen nokta) dört dilimin
// bütün açıları yeniden hesaplanır ve yalnız değişen satırlar yazılır. Referans serinin başından bütün
// pencerelere bağlı olduğu için hesap her seferinde baştan yapılır; %90'lık değer yığınla tutulduğundan seri
// büyüse de hızlı (bir yılda metrik başına ~120 bin nokta).

export const METRICS = ['global', 'top_position'] as const
export const PERIODS: Record<string, number> = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 }
const BATCH = 1000

// Süreç içinde metrik başına son işlenen serinin izi (nokta sayısı ve son ts); değişmediyse tur tek sorgu.
const seen = new Map<string, string>()

export async function syncLsrAngles(pool: Pool) {
  const source = 'core:lsr'
  const startedAt = new Date()
  let last: Date | null = null
  try {
    let changed = false
    for (const metric of METRICS) {
      const { rows: [fp] } = await pool.query<{ n: string; last: Date | null }>(
        `SELECT count(*) AS n, max(ts) AS last FROM lsr_series WHERE metric = $1`,
        [metric],
      )
      if (!fp?.last) continue
      if (!last || fp.last > last) last = fp.last
      const key = `${fp.n}:${fp.last.getTime()}`
      if (seen.get(metric) === key) continue

      const { rows } = await pool.query<{ t: string; v: number }>(
        `SELECT (extract(epoch FROM ts) * 1000)::bigint::text AS t, long_short_ratio AS v
         FROM lsr_series WHERE metric = $1 ORDER BY ts`,
        [metric],
      )
      let written = 0
      for (const [period, step] of Object.entries(PERIODS)) {
        const pts = step === PERIODS['5m'] ? rows : rows.filter((r) => Number(r.t) % step === 0)
        const out = angleSeries(pts.map((r) => Number(r.t)), pts.map((r) => r.v), step)
        for (let i = 0; i < out.length; i += BATCH) {
          const part = out.slice(i, i + BATCH)
          const src = pts.slice(i, i + part.length)
          const res = await pool.query(
            `INSERT INTO lsr_angles (metric, period, ts, slope, r2, ref, n_ref, angle)
             SELECT $1, $2, to_timestamp(u.t / 1000.0), u.slope, u.r2, u.ref, u.n_ref, u.angle
             FROM unnest($3::bigint[], $4::float8[], $5::float8[], $6::float8[], $7::int[], $8::float8[])
               AS u(t, slope, r2, ref, n_ref, angle)
             ON CONFLICT (metric, period, ts) DO UPDATE SET
               slope = EXCLUDED.slope, r2 = EXCLUDED.r2, ref = EXCLUDED.ref, n_ref = EXCLUDED.n_ref,
               angle = EXCLUDED.angle, computed_at = now()
             WHERE (lsr_angles.slope, lsr_angles.r2, lsr_angles.ref, lsr_angles.n_ref, lsr_angles.angle)
               IS DISTINCT FROM (EXCLUDED.slope, EXCLUDED.r2, EXCLUDED.ref, EXCLUDED.n_ref, EXCLUDED.angle)`,
            [
              metric,
              period,
              src.map((r) => r.t),
              part.map((p) => p.slope),
              part.map((p) => p.r2),
              part.map((p) => p.ref),
              part.map((p) => p.nRef),
              part.map((p) => p.angle),
            ],
          )
          written += res.rowCount ?? 0
        }
      }
      if (written > 4) console.log(`[core] L/S açıları (${metric}): ${written} satır yazıldı`)
      seen.set(metric, key)
      changed = true
    }
    if (changed) await markOk(pool, source, '5 minutes', last)
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[core] L/S açıları: ${msg}`)
    await logRun(pool, { source, startedAt, ok: false, error: msg })
    await markFail(pool, source, '5 minutes', msg)
  }
}
