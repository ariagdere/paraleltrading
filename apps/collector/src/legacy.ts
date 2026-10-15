import { gzipSync } from 'node:zlib'
import { createPool, type Pool } from '@pt/db'
import { config } from './config.js'
import { summarize } from './heatmap.js'
import { logRun, markFail, markOk } from './status.js'

// Eski sistemin veritabanından tek yönlü kopya; OLD_DATABASE_URL tanımlıysa açılışta ve saatte bir.
//   orders, order_events → legacy_orders, legacy_order_events: eski sistem çalıştıkça yenileri de gelir
//     (doğrulama ve ileri izleme için). order_events yalnız eklenir, yeni id'ler kopyalanır.
//   red_folder_events → calendar_events.
//   12h heatmap (ham biçimdekiler) ve L/S 5m: yalnız yeni toplayıcının ilk kaydından önceki dönem; bir kez
//     tamamlanınca (collector_runs'ta legacy:heatmap / legacy:lsr, complete) bir daha taranmaz. LEGACY_FROM
//     verilmezse eski DB'de ne varsa; bunlar başka hiçbir yerde yok.
// Eski DB'ye salt okunur oturumla bağlanılır ve bu her turda doğrulanır.

let oldPool: Pool | null = null
let heatmapDone = false
let lsrDone = false

function old(): Pool {
  oldPool ??= createPool(config.legacy.url, 2, { ssl: config.legacy.ssl, readOnly: true })
  return oldPool
}

export async function closeLegacy() {
  await oldPool?.end().catch(() => undefined)
}

async function copyOrders(pool: Pool): Promise<number> {
  const { rows } = await old().query<{ data: unknown }>('SELECT to_jsonb(o) AS data FROM orders o ORDER BY id')
  if (rows.length === 0) return 0
  const res = await pool.query(
    `INSERT INTO legacy_orders (id, magic, status, direction, created_at, opened_at, closed_at, updated_at, data)
     SELECT (d->>'id')::bigint, (d->>'magic')::int, d->>'status', d->>'direction', (d->>'created_at')::timestamptz,
            (d->>'opened_at')::timestamptz, (d->>'closed_at')::timestamptz, (d->>'updated_at')::timestamptz, d
     FROM jsonb_array_elements($1::jsonb) AS d
     ON CONFLICT (id) DO UPDATE SET
       magic = EXCLUDED.magic, status = EXCLUDED.status, direction = EXCLUDED.direction,
       created_at = EXCLUDED.created_at, opened_at = EXCLUDED.opened_at, closed_at = EXCLUDED.closed_at,
       updated_at = EXCLUDED.updated_at, data = EXCLUDED.data, copied_at = now()
     WHERE legacy_orders.data IS DISTINCT FROM EXCLUDED.data`,
    [JSON.stringify(rows.map((r) => r.data))],
  )
  return res.rowCount ?? 0
}

async function copyEvents(pool: Pool): Promise<number> {
  let written = 0
  for (;;) {
    const { rows: last } = await pool.query<{ id: string }>('SELECT coalesce(max(id), 0) AS id FROM legacy_order_events')
    const { rows } = await old().query<{ data: unknown }>(
      'SELECT to_jsonb(e) AS data FROM order_events e WHERE id > $1 ORDER BY id LIMIT 2000',
      [last[0]?.id ?? 0],
    )
    if (rows.length === 0) break
    const res = await pool.query(
      `INSERT INTO legacy_order_events (id, order_id, event_type, event_time, data)
       SELECT (d->>'id')::bigint, (d->>'order_id')::bigint, d->>'event_type', (d->>'event_time')::timestamptz, d
       FROM jsonb_array_elements($1::jsonb) AS d
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(rows.map((r) => r.data))],
    )
    written += res.rowCount ?? 0
    if (rows.length < 2000) break
  }
  return written
}

async function copyCalendar(pool: Pool): Promise<number> {
  const { rows } = await old().query('SELECT event_at, currency, event_name FROM red_folder_events')
  if (rows.length === 0) return 0
  const res = await pool.query(
    `INSERT INTO calendar_events (event_at, currency, event_name, source)
     SELECT (d->>'event_at')::timestamptz, d->>'currency', d->>'event_name', 'old_db'
     FROM jsonb_array_elements($1::jsonb) AS d
     ON CONFLICT (event_at, currency, event_name) DO NOTHING`,
    [JSON.stringify(rows)],
  )
  return res.rowCount ?? 0
}

// Bir kez tamamlanan geçmiş kopyaları (heatmap, L/S) sonraki açılışlarda yeniden taranmaz.
async function completed(pool: Pool, source: string): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT 1 FROM collector_runs WHERE source = $1 AND ok AND detail->>'complete' = 'true' LIMIT 1",
    [source],
  )
  return rows.length > 0
}

// Eski 12h snapshot'ları (ham biçimdekiler; eski özet biçimi atlanır), yeni toplayıcının ilk snapshot'ından öncesi.
// received_at = eski satırın created_at'i (verinin eski sisteme ulaştığı an). Zaten kopyalanmış çalıştırmalar
// yeniden indirilmez (yarıda kalan bir kopya kaldığı yerden sürer).
async function copyHeatmap(pool: Pool): Promise<number> {
  if (heatmapDone) return 0
  if (await completed(pool, 'legacy:heatmap')) {
    heatmapDone = true
    return 0
  }
  const startedAt = new Date()
  const { rows: c } = await pool.query<{ cutoff: Date | null }>(
    "SELECT min(received_at) AS cutoff FROM heatmap_snapshots WHERE source = 'collector'",
  )
  const cutoff = c[0]?.cutoff ?? new Date()
  const { rows: have } = await pool.query<{ run: string }>(
    "SELECT apify_run_id AS run FROM heatmap_snapshots WHERE source = 'old_db' AND apify_run_id IS NOT NULL",
  )
  const skip = have.map((r) => r.run)
  let lastId = '0'
  let written = 0
  for (;;) {
    const { rows } = await old().query<{ id: string; apify_run_id: string; run_started_at: Date; created_at: Date; heatmap_json: unknown }>(
      `SELECT id, apify_run_id, run_started_at, created_at, heatmap_json FROM apify_heatmap_snapshots
       WHERE id > $1 AND created_at < $2 AND ($3::timestamptz IS NULL OR created_at >= $3)
         AND heatmap_json ? 'liquidation_leverage_data' AND NOT (apify_run_id = ANY($4::text[]))
       ORDER BY id LIMIT 25`,
      [lastId, cutoff, config.legacy.from, skip],
    )
    if (rows.length === 0) break
    for (const r of rows) {
      lastId = r.id
      let s: ReturnType<typeof summarize>
      try {
        s = summarize(r.heatmap_json)
      } catch {
        continue // boş ya da bozuk snapshot
      }
      const res = await pool.query(
        `INSERT INTO heatmap_snapshots (span, apify_run_id, run_started_at, received_at, update_time, first_col_time,
           last_col_time, n_cols, n_levels, n_cells, payload_gz, source)
         VALUES ('12h', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'old_db')
         ON CONFLICT DO NOTHING`,
        [r.apify_run_id, r.run_started_at, r.created_at, s.updateTime, s.firstColTime, s.lastColTime, s.nCols,
          s.nLevels, s.nCells, gzipSync(JSON.stringify(r.heatmap_json))],
      )
      written += res.rowCount ?? 0
    }
  }
  await logRun(pool, { source: 'legacy:heatmap', startedAt, ok: true, rowsWritten: written, detail: { complete: true, cutoff } })
  heatmapDone = true
  return written
}

// Eski L/S 5m noktaları, yeni serinin (Binance'ten) ilk noktasından öncesi. received_at = eski updated_at.
async function copyLsr(pool: Pool): Promise<number> {
  if (lsrDone) return 0
  if (await completed(pool, 'legacy:lsr')) {
    lsrDone = true
    return 0
  }
  const startedAt = new Date()
  const { rows: c } = await pool.query<{ cutoff: Date | null }>(
    "SELECT min(ts) AS cutoff FROM lsr_series WHERE source = 'binance'",
  )
  const cutoff = c[0]?.cutoff
  if (!cutoff) return 0 // yeni seri henüz başlamadı; sonraki turda
  const { rows } = await old().query<{ metric: string; open_time: string; long_account: string | null; short_account: string | null; long_short_ratio: string; updated_at: Date }>(
    `SELECT metric, open_time, long_account, short_account, long_short_ratio, updated_at FROM lsr_series
     WHERE period = '5m' AND metric IN ('global', 'top_position') AND open_time < $1 AND open_time >= $2`,
    [cutoff.getTime(), config.legacy.from?.getTime() ?? 0],
  )
  const num = (v: string | null) => (v === null ? null : Number(v))
  const res = await pool.query(
    `INSERT INTO lsr_series (metric, ts, long_account, short_account, long_short_ratio, source, received_at)
     SELECT m, to_timestamp(t / 1000.0), la, sa, r, 'old_db', u
     FROM unnest($1::text[], $2::bigint[], $3::float8[], $4::float8[], $5::float8[], $6::timestamptz[]) AS x(m, t, la, sa, r, u)
     ON CONFLICT (metric, ts) DO NOTHING`,
    [
      rows.map((r) => r.metric),
      rows.map((r) => r.open_time),
      rows.map((r) => num(r.long_account)),
      rows.map((r) => num(r.short_account)),
      rows.map((r) => Number(r.long_short_ratio)),
      rows.map((r) => r.updated_at),
    ],
  )
  const written = res.rowCount ?? 0
  await logRun(pool, { source: 'legacy:lsr', startedAt, ok: true, rowsWritten: written, detail: { complete: true, cutoff } })
  lsrDone = true
  return written
}

export async function syncLegacy(pool: Pool) {
  const source = 'legacy'
  const startedAt = new Date()
  try {
    const { rows } = await old().query<{ transaction_read_only: string }>('SHOW transaction_read_only')
    if (rows[0]?.transaction_read_only !== 'on') throw new Error('eski DB oturumu salt okunur değil; kopya yapılmadı')
    const counts = {
      orders: await copyOrders(pool),
      orderEvents: await copyEvents(pool),
      calendar: await copyCalendar(pool),
      heatmap12h: await copyHeatmap(pool),
      lsr5m: await copyLsr(pool),
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    if (total > 0) {
      console.log(`[eski] kopyalandı: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`)
      await logRun(pool, { source, startedAt, ok: true, rowsWritten: total, detail: counts })
    }
    const { rows: last } = await pool.query<{ at: Date | null }>('SELECT max(updated_at) AS at FROM legacy_orders')
    await markOk(pool, source, '1 hour', last[0]?.at ?? null)
  } catch (err) {
    let msg = (err as Error).message
    if (/does not support SSL/i.test(msg)) msg += ' (eski DB SSL kabul etmiyor: OLD_PGSSL=false verilebilir)'
    console.error(`[eski] ${msg}`)
    await logRun(pool, { source, startedAt, ok: false, error: msg })
    await markFail(pool, source, '1 hour', msg)
  }
}
