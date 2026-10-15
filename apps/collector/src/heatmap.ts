import { gzipSync } from 'node:zlib'
import type { Pool } from '@pt/db'
import { config } from './config.js'
import { logRun, markFail, markOk } from './status.js'

// CoinGlass model1 likidasyon heatmap'i (Apify aktörü), 12h, 24h ve 48h pencerelerde saatte bir.
// Başlat → bitmesini bekle → dataset'i oku. Bekleme süresi dolarsa yeniden başlatılmaz: çalıştırma Apify'da
// sürer ve ücretlenir, ikinci çalıştırma yalnız maliyeti ikiye katlar.

export type Span = '12h' | '24h' | '48h'
export const SPANS: Span[] = ['12h', '24h', '48h']
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'])
const STAGGER_MS = 15_000

export type Mode = { name: string; twoHourly: Span[] }
// Bütçe bekçisi: ay sonu tahmini bütçeyi aşarsa önce 48h, sonra 24h iki saatte bire iner.
export const MODES: Mode[] = [
  { name: 'normal', twoHourly: [] },
  { name: '48h iki saatte bir', twoHourly: ['48h'] },
  { name: '24h ve 48h iki saatte bir', twoHourly: ['24h', '48h'] },
]

export type Usage = { usedUsd: number; ownSpendUsd: number; cycleStart: Date; cycleEnd: Date }

// Tahmin = şimdiye kadarki harcama + kalan saat × (bizim saatlik maliyetimiz + hesaptaki başka işlerin saatlik
// ortalaması). Başka işler: aynı Apify hesabını kullanan eski sistem gibi; bu döngüdeki harcamalarından hesaplanır.
export function choosePlan(
  u: Usage,
  now: Date,
  budgetUsd = config.apify.budgetUsd,
  runCostUsd = config.apify.runCostUsd,
): { mode: Mode; projectedUsd: number } {
  const hoursLeft = Math.max(0, (u.cycleEnd.getTime() - now.getTime()) / 3_600_000)
  const hoursGone = Math.max(1, (now.getTime() - u.cycleStart.getTime()) / 3_600_000)
  const otherPerHour = Math.max(0, u.usedUsd - u.ownSpendUsd) / hoursGone
  const project = (m: Mode) =>
    u.usedUsd + hoursLeft * ((SPANS.length - m.twoHourly.length / 2) * runCostUsd + otherPerHour)
  const mode = MODES.find((m) => project(m) <= budgetUsd) ?? MODES[MODES.length - 1]!
  return { mode, projectedUsd: project(mode) }
}

// İki saatte bire inen pencereler çift UTC saatlerinde çalışır.
export function spansForHour(mode: Mode, slot: Date): Span[] {
  const even = slot.getUTCHours() % 2 === 0
  return SPANS.filter((s) => even || !mode.twoHourly.includes(s))
}

type ApifyRun = {
  id: string
  status: string
  defaultDatasetId: string
  startedAt?: string
  stats?: { runTimeSecs?: number }
}

async function apify<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${config.apify.baseUrl}/v2${path}`, {
    ...init,
    signal,
    headers: { Authorization: `Bearer ${config.apify.token}`, 'Content-Type': 'application/json' },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Apify ${init.method ?? 'GET'} ${path.split('?')[0]}: HTTP ${res.status} ${text.slice(0, 300)}`)
  return JSON.parse(text) as T
}

async function usage(pool: Pool): Promise<Usage> {
  const { data } = await apify<{
    data: { monthlyUsageCycle: { startAt: string; endAt: string }; current: { monthlyUsageUsd: number } }
  }>('/users/me/limits')
  const usedUsd = Number(data?.current?.monthlyUsageUsd)
  const cycleStart = new Date(data?.monthlyUsageCycle?.startAt)
  const cycleEnd = new Date(data?.monthlyUsageCycle?.endAt)
  // Beklenmeyen bir yanıt sessizce en kısık moda düşürmesin.
  if (!Number.isFinite(usedUsd) || Number.isNaN(cycleStart.getTime()) || Number.isNaN(cycleEnd.getTime())) {
    throw new Error('Apify kullanım yanıtı beklenen biçimde değil')
  }
  const { rows } = await pool.query<{ spent: number }>(
    `SELECT coalesce(sum(cost_usd), 0)::float8 AS spent FROM collector_runs
     WHERE source LIKE 'heatmap:%' AND started_at >= $1`,
    [cycleStart],
  )
  return { usedUsd, ownSpendUsd: rows[0]?.spent ?? 0, cycleStart, cycleEnd }
}

async function waitForRun(id: string, deadline: number, signal: AbortSignal): Promise<ApifyRun> {
  for (;;) {
    const { data } = await apify<{ data: ApifyRun }>(`/actor-runs/${id}?waitForFinish=60`, {}, signal)
    if (TERMINAL.has(data.status) || Date.now() >= deadline) return data
  }
}

type Payload = {
  success?: boolean
  message?: string
  updateTime?: number
  y_axis?: unknown[]
  liquidation_leverage_data?: unknown[]
  price_candlesticks?: unknown[][]
}

// Mum zamanları saniye, updateTime milisaniye.
const toDate = (v: unknown): Date | null => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n < 1e12 ? n * 1000 : n)
}

// Hızlı bakış sütunları; biçim beklenmedikse ya da heatmap boşsa hata verir (snapshot yazılmaz).
export function summarize(item: unknown) {
  const p = item as Payload | undefined
  if (!p || typeof p !== 'object') throw new Error('dataset boş')
  if (p.success === false) throw new Error(`aktör başarısız döndü: ${p.message ?? ''}`)
  const { y_axis: levels, liquidation_leverage_data: cells, price_candlesticks: candles } = p
  if (!Array.isArray(levels) || !Array.isArray(cells) || !Array.isArray(candles)) throw new Error('beklenmeyen çıktı biçimi')
  if (cells.length === 0) throw new Error('heatmap boş (hücre yok)')
  return {
    updateTime: toDate(p.updateTime),
    firstColTime: toDate(candles[0]?.[0]),
    lastColTime: toDate(candles[candles.length - 1]?.[0]),
    nCols: candles.length,
    nLevels: levels.length,
    nCells: cells.length,
  }
}

async function runSpan(pool: Pool, span: Span, expectedEvery: string, plan: Record<string, unknown>, signal: AbortSignal) {
  const source = `heatmap:${span}`
  const startedAt = new Date()
  let runId: string | undefined
  try {
    const started = await apify<{ data: ApifyRun }>(
      `/acts/${config.apify.actorId}/runs`,
      { method: 'POST', body: JSON.stringify({ symbol: 'BTC', model: 'model1', interval: span }) },
      signal,
    )
    runId = started.data.id
    const run = await waitForRun(runId, startedAt.getTime() + config.apify.waitMinutes * 60_000, signal)
    if (!TERMINAL.has(run.status)) {
      throw new Error(`çalıştırma ${config.apify.waitMinutes} dakikada bitmedi (${run.status}); Apify'da sürüyor olabilir`)
    }
    if (run.status !== 'SUCCEEDED') throw new Error(`Apify çalıştırması ${run.status}`)
    const items = await apify<unknown[]>(`/datasets/${run.defaultDatasetId}/items?clean=true&format=json`, {}, signal)
    const item = Array.isArray(items) ? items[0] : undefined
    const s = summarize(item)
    const res = await pool.query(
      `INSERT INTO heatmap_snapshots
         (span, apify_run_id, run_started_at, update_time, first_col_time, last_col_time, n_cols, n_levels, n_cells, payload_gz)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT DO NOTHING`,
      [
        span,
        runId,
        run.startedAt ? new Date(run.startedAt) : startedAt,
        s.updateTime,
        s.firstColTime,
        s.lastColTime,
        s.nCols,
        s.nLevels,
        s.nCells,
        gzipSync(JSON.stringify(item)),
      ],
    )
    const written = res.rowCount ?? 0
    await logRun(pool, {
      source,
      startedAt,
      ok: true,
      rowsWritten: written,
      costUsd: config.apify.runCostUsd,
      // duplicate: CoinGlass veriyi yenilememiş (aynı updateTime), snapshot ikinci kez yazılmadı.
      detail: { runId, ...plan, runTimeSecs: run.stats?.runTimeSecs, nCells: s.nCells, updateTime: s.updateTime, duplicate: written === 0 },
    })
    await markOk(pool, source, expectedEvery, s.updateTime)
  } catch (err) {
    const msg = signal.aborted ? "servis kapandı; çalıştırma Apify'da sürüyor olabilir" : (err as Error).message
    console.error(`[heatmap] ${span}: ${msg}`)
    await logRun(pool, {
      source,
      startedAt,
      ok: false,
      costUsd: runId ? config.apify.runCostUsd : 0,
      detail: { runId, ...plan },
      error: msg,
    })
    await markFail(pool, source, expectedEvery, msg)
  }
}

// Saat başı turu: bütçeye göre bu saat hangi pencerelerin çalışacağına karar verir, sonra hepsini
// 15 saniye arayla başlatır (aynı ana yakın snapshot'lar).
export async function heatmapHour(pool: Pool, slot: Date, signal: AbortSignal) {
  let mode = MODES[0]!
  let plan: Record<string, unknown> = { mode: mode.name }
  try {
    const u = await usage(pool)
    const p = choosePlan(u, new Date())
    mode = p.mode
    plan = { mode: mode.name, projectedUsd: Number(p.projectedUsd.toFixed(2)), usedUsd: u.usedUsd }
    if (mode !== MODES[0]) console.warn(`[heatmap] bütçe: ay sonu tahmini $${p.projectedUsd.toFixed(2)}, ${mode.name}`)
    await markOk(pool, 'heatmap:budget', '1 hour')
  } catch (err) {
    // Bekçi çalışmazsa son emniyet Apify'daki aylık limit; durum sağlık tablosunda görünür.
    const msg = `Apify kullanımı okunamadı, normal planla devam: ${(err as Error).message}`
    console.error(`[heatmap] ${msg}`)
    await markFail(pool, 'heatmap:budget', '1 hour', msg)
  }
  await Promise.all(
    spansForHour(mode, slot).map(async (span, i) => {
      await new Promise((r) => setTimeout(r, i * STAGGER_MS))
      if (signal.aborted) return
      await runSpan(pool, span, mode.twoHourly.includes(span) ? '2 hours' : '1 hour', plan, signal)
    }),
  )
}
