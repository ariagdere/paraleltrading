import type { Pool } from '@pt/db'

const clip = (s: string) => (s.length > 2000 ? `${s.slice(0, 2000)}…` : s)

// collector_status: kaynak başına son durum. expectedEvery Postgres interval metni ('5 minutes', '1 hour').
export async function markOk(pool: Pool, source: string, expectedEvery: string, lastSourceTime: Date | null = null) {
  await pool.query(
    `INSERT INTO collector_status (source, expected_every, last_run_at, last_success_at, last_source_time, consecutive_failures, updated_at)
     VALUES ($1, $2::interval, now(), now(), $3, 0, now())
     ON CONFLICT (source) DO UPDATE SET
       expected_every = EXCLUDED.expected_every, last_run_at = now(), last_success_at = now(),
       last_source_time = COALESCE(EXCLUDED.last_source_time, collector_status.last_source_time),
       consecutive_failures = 0, updated_at = now()`,
    [source, expectedEvery, lastSourceTime],
  )
}

export async function markFail(pool: Pool, source: string, expectedEvery: string, error: string) {
  await pool.query(
    `INSERT INTO collector_status (source, expected_every, last_run_at, consecutive_failures, last_error, last_error_at, updated_at)
     VALUES ($1, $2::interval, now(), 1, $3, now(), now())
     ON CONFLICT (source) DO UPDATE SET
       expected_every = EXCLUDED.expected_every, last_run_at = now(),
       consecutive_failures = collector_status.consecutive_failures + 1,
       last_error = EXCLUDED.last_error, last_error_at = now(), updated_at = now()`,
    [source, expectedEvery, clip(error)],
  )
}

export type RunRecord = {
  source: string
  startedAt: Date
  ok: boolean
  rowsWritten?: number
  costUsd?: number
  detail?: Record<string, unknown>
  error?: string
}

// collector_runs: her heatmap çalıştırması (maliyetiyle) ve her hata.
export async function logRun(pool: Pool, r: RunRecord) {
  await pool.query(
    `INSERT INTO collector_runs (source, started_at, finished_at, ok, rows_written, cost_usd, detail, error)
     VALUES ($1, $2, now(), $3, $4, $5, $6, $7)`,
    [
      r.source,
      r.startedAt,
      r.ok,
      r.rowsWritten ?? null,
      r.costUsd ?? null,
      r.detail ? JSON.stringify(r.detail) : null,
      r.error ? clip(r.error) : null,
    ],
  )
}
