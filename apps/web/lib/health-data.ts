import { db } from './db'
import type { StatusRow } from './health'

export type RunError = { source: string; at: Date; error: string }

export type HealthData = {
  now: Date
  rows: StatusRow[]
  fails24h: Record<string, number>
  recent: RunError[]
}

// Sağlık sayfasının bütün okuması: dört küçük sorgu, aynı anda. "Şimdi" veritabanının saati: last_run_at ve
// last_success_at de onun now()'ıyla yazılıyor.
export async function loadHealth(): Promise<HealthData> {
  const pool = db()
  const [clock, status, fails, recent] = await Promise.all([
    pool.query<{ now: Date }>('SELECT now() AS now'),
    pool.query<{
      source: string
      every_ms: number
      last_run_at: Date | null
      last_success_at: Date | null
      last_source_time: Date | null
      consecutive_failures: number
      last_error: string | null
      last_error_at: Date | null
    }>(
      `SELECT source, (extract(epoch FROM expected_every) * 1000)::float8 AS every_ms, last_run_at, last_success_at,
              last_source_time, consecutive_failures, last_error, last_error_at
       FROM collector_status`,
    ),
    pool.query<{ source: string; n: number }>(
      `SELECT source, count(*)::int AS n FROM collector_runs
       WHERE ok = false AND started_at > now() - interval '24 hours' GROUP BY source`,
    ),
    pool.query<{ source: string; at: Date; error: string | null }>(
      `SELECT source, started_at AS at, error FROM collector_runs
       WHERE ok = false AND started_at > now() - interval '7 days'
       ORDER BY started_at DESC LIMIT 12`,
    ),
  ])
  return {
    now: clock.rows[0]!.now,
    rows: status.rows.map((r) => ({
      source: r.source,
      everyMs: r.every_ms,
      lastRunAt: r.last_run_at,
      lastSuccessAt: r.last_success_at,
      lastSourceTime: r.last_source_time,
      failures: r.consecutive_failures,
      lastError: r.last_error,
      lastErrorAt: r.last_error_at,
    })),
    fails24h: Object.fromEntries(fails.rows.map((r) => [r.source, r.n])),
    recent: recent.rows.map((r) => ({ source: r.source, at: r.at, error: r.error ?? 'hata metni yok' })),
  }
}
