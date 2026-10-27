import { db } from './db'

// Simülasyon sayfasının okuması: koşular (son 24) ve seçilen koşunun sonucu ile Claude yorumu. Sonucun biçimi core'un
// apps/core/src/sim/engine.ts'indeki SimResults; burada yalnız sayfanın kullandığı alanlar.

export type Side = 'LONG' | 'SHORT'
export type Cond = [string, string]
export type Stats = { n: number; sumR: number; avgR: number; win: number; maxDD: number }
export type Top = Stats & { conds: Cond[]; level: number; label: string }
export type SideResult = {
  candidates: number
  base: Stats
  tested: number
  enough: number
  top: Top[]
  null: { runs: number; p50: number; p95: number; rank: number | null }
}
export type Merged = Stats & { overlapHours: number; curve: Array<[number, number]> }
export type Verdict = 'tutuyor' | 'tutmuyor' | 'veri_az' | 'gecersiz'
export type RuleCheck = {
  side: Side
  conds: Cond[]
  label: string
  rank: number
  previous: { n: number; sumR: number; avgR: number }
  forward: Stats | null
  baseForward: Stats
  verdict: Verdict
}
export type MonthRow = { month: string; days: number; heatmapHours: number; decisions: number; baseTrades: number; baseSumR: number }
export type SimResults = {
  engine: string
  data: { from: number | null; to: number; candidates: Record<Side, number>; months: MonthRow[] }
  sides: Record<Side, SideResult>
  combined: (Merged & { nullSumP50: number; nullSumP95: number }) | null
  base2: Merged
  validation: {
    previousRunId: number
    from: number
    to: number
    rules: RuleCheck[]
    combined: (Merged & { verdict: Verdict; baseForward: Merged }) | null
  } | null
}
export type Comment = {
  generated_at: string
  ozet: string
  gecerlilik: string
  bulgular: string[]
  oneriler: string[]
  guven: string
  model: string | null
}

export type RunStatus = 'istendi' | 'calisiyor' | 'bitti' | 'hata'
export type RunRow = {
  id: number
  kind: 'aylik' | 'elle'
  status: RunStatus
  requestedAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  dataTo: Date | null
  error: string | null
  combinedR: number | null
  hasComment: boolean
  gitCommit: string | null
  gitError: string | null
}
export type RunDetail = RunRow & { dataFrom: Date | null; previousId: number | null; results: SimResults | null; comment: Comment | null; commentAt: Date | null }

type Row = {
  id: string
  kind: 'aylik' | 'elle'
  status: RunStatus
  requested_at: Date
  started_at: Date | null
  finished_at: Date | null
  data_to: Date | null
  error: string | null
  combined_r: number | null
  has_comment: boolean
  git_commit: string | null
  git_error: string | null
}

const toRow = (r: Row): RunRow => ({
  id: Number(r.id),
  kind: r.kind,
  status: r.status,
  requestedAt: r.requested_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  dataTo: r.data_to,
  error: r.error,
  combinedR: r.combined_r,
  hasComment: r.has_comment,
  gitCommit: r.git_commit,
  gitError: r.git_error,
})

const COLS = `id, kind, status, requested_at, started_at, finished_at, data_to, error, (results->'combined'->>'sumR')::float8 AS combined_r,
              comment IS NOT NULL AS has_comment, git_commit, git_error`

// selected: istenen koşu (yoksa son biten)
export async function loadSim(selected: number | null): Promise<{ now: Date; runs: RunRow[]; run: RunDetail | null }> {
  const pool = db()
  const { rows } = await pool.query<Row>(`SELECT ${COLS} FROM sim_runs ORDER BY id DESC LIMIT 24`)
  const runs = rows.map(toRow)
  const pick = selected ?? runs.find((r) => r.status === 'bitti')?.id ?? null
  let run: RunDetail | null = null
  if (pick !== null) {
    const {
      rows: [d],
    } = await pool.query<Row & { data_from: Date | null; previous_id: string | null; results: SimResults | null; comment: Comment | null; comment_at: Date | null }>(
      `SELECT ${COLS}, data_from, previous_id, results, comment, comment_at FROM sim_runs WHERE id = $1`,
      [pick],
    )
    if (d)
      run = {
        ...toRow(d),
        dataFrom: d.data_from,
        previousId: d.previous_id === null ? null : Number(d.previous_id),
        results: d.results,
        comment: d.comment,
        commentAt: d.comment_at,
      }
  }
  return { now: new Date(), runs, run }
}
