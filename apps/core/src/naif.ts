import { logRun, markFail, markOk, type Pool } from '@pt/db'
import { NAIVE, NAIVE_VERSION, decide, type Bar1, type Bar4, type Decision, type SnapshotInput } from './naive.js'
import { SYMBOL } from './sync.js'

// Naif kuralın yeniden oynatılması ve ileri izlemesi (doğrulama): NAIVE_FROM'dan bu yana her 12h heatmap
// snapshot'ının kararı ve benzetilen işlemi (naive_decisions). Girdilerden biri değişince (yeni ya da düzeltilen mum,
// yeni snapshot ya da seviye) hepsi baştan hesaplanır (birkaç yüz karar; açık işlemler yeni 1m mumlarıyla ilerler,
// düzeltilen bir mum geçmişi de düzeltir); yalnız değişen satırlar yazılır, artık üretilmeyenler silinir. Kayıttaki
// satır sayısı da ize girer: elle silinen satırlar bir sonraki turda yeniden yazılır. collector'ın ilk snapshot'ına
// kadarki 12h'ler eski döngülerin kendisi (eski sistemden kopyalananlar); sonrası collector'ın saatlik 12h'leri.
//
// 1m mumları süreçte tutulur: ilk turda ve sonra saatte bir hepsi, arada her turda son 7 saat yeniden okunur
// (collector son mumları ve son 6 saatteki boşlukları yeniden ister); sayı tutmazsa (eski bir boşluk sonradan
// doldu) hepsi yeniden okunur.

const FROM = new Date(process.env.NAIVE_FROM || '2026-09-18T00:00:00Z')
const H4 = 4 * 3_600_000
const TAIL = '7 hours'
const FULL_EVERY_MS = 3_600_000
const DEFAULT_POINT = 0.01

type M1Row = { t: string; o: number; h: number; l: number; c: number; sp: number | null }
const m1: { rows: Bar1[]; point: number | null; loadedAt: number } = { rows: [], point: null, loadedAt: 0 }
let seen: string | null = null

const toBar1 = (r: M1Row, point: number): Bar1 => ({ t: Number(r.t), o: r.o, h: r.h, l: r.l, c: r.c, s: r.sp === null ? null : r.sp * point })

async function loadM1(pool: Pool, point: number): Promise<string> {
  const from = new Date(FROM.getTime() - H4)
  const cols = `(extract(epoch FROM open_time) * 1000)::bigint::text AS t, open AS o, high AS h, low AS l, close AS c, spread_points AS sp`
  const {
    rows: [fp],
  } = await pool.query<{ n: string; last: Date | null; su: string | null }>(
    `SELECT count(*) AS n, max(open_time) AS last, max(updated_at)::text AS su FROM axi_candles WHERE symbol = $1 AND timeframe = '1m' AND open_time >= $2`,
    [SYMBOL, from],
  )
  const full = async () => {
    const { rows } = await pool.query<M1Row>(`SELECT ${cols} FROM axi_candles WHERE symbol = $1 AND timeframe = '1m' AND open_time >= $2 ORDER BY open_time`, [
      SYMBOL,
      from,
    ])
    m1.rows = rows.map((r) => toBar1(r, point))
    m1.point = point
    m1.loadedAt = Date.now()
  }
  if (m1.point !== point || m1.rows.length === 0 || Date.now() - m1.loadedAt >= FULL_EVERY_MS) await full()
  else {
    const { rows } = await pool.query<M1Row>(
      `SELECT ${cols} FROM axi_candles WHERE symbol = $1 AND timeframe = '1m' AND open_time >= greatest($2, now() - $3::interval) ORDER BY open_time`,
      [SYMBOL, from, TAIL],
    )
    if (rows.length > 0) {
      const tail = rows.map((r) => toBar1(r, point))
      const t0 = tail[0]!.t
      let k = m1.rows.length
      while (k > 0 && m1.rows[k - 1]!.t >= t0) k--
      m1.rows = [...m1.rows.slice(0, k), ...tail]
    }
    if (m1.rows.length !== Number(fp?.n ?? 0)) await full()
  }
  return `${fp?.n}:${fp?.last?.getTime()}:${fp?.su}:${m1.loadedAt}`
}

type SnapRow = { id: string; cycle_at: Date; ref: number | null; up: number | null; dn: number | null; basis: number | null; lv: string }
type C4Row = { t: string; o: number; h: number; l: number; c: number }

export async function syncNaive(pool: Pool) {
  const source = 'core:naif'
  const startedAt = new Date()
  try {
    const {
      rows: [spec],
    } = await pool.query<{ point: number | null }>(
      `SELECT (spec->>'point')::float8 AS point FROM axi_symbol_spec WHERE symbol = $1 ORDER BY captured_at DESC LIMIT 1`,
      [SYMBOL],
    )
    const point = spec?.point && spec.point > 0 ? spec.point : DEFAULT_POINT
    const [m1Key, snaps, c4, kept] = await Promise.all([
      loadM1(pool, point),
      // seviyesi hesaplanmamış snapshot henüz karara girmez (core'un heatmap işi aynı turda önce çalışır)
      pool.query<SnapRow>(
        `SELECT s.id, coalesce(s.last_col_time, s.update_time, s.received_at) AS cycle_at, l.ref_price AS ref, l.up1_price AS up,
                l.dn1_price AS dn, l.basis, l.computed_at::text AS lv
         FROM heatmap_snapshots s JOIN heatmap_levels l ON l.snapshot_id = s.id
         WHERE s.span = $1 AND coalesce(s.last_col_time, s.update_time, s.received_at) >= $2
         ORDER BY 2, s.id`,
        [NAIVE.span, FROM],
      ),
      pool.query<C4Row & { su: string }>(
        `SELECT (extract(epoch FROM open_time) * 1000)::bigint::text AS t, open AS o, high AS h, low AS l, close AS c, updated_at::text AS su
         FROM axi_candles WHERE symbol = $1 AND timeframe = '4h' AND open_time >= $2 ORDER BY open_time`,
        [SYMBOL, new Date(FROM.getTime() - (NAIVE.zlemaBars + 6) * H4)],
      ),
      pool.query<{ n: string }>(`SELECT count(*) AS n FROM naive_decisions WHERE version = $1`, [NAIVE_VERSION]),
    ])
    const inputs = [
      m1Key,
      point,
      snaps.rows.length,
      snaps.rows.at(-1)?.id,
      snaps.rows.reduce((m, r) => (r.lv > m ? r.lv : m), ''),
      c4.rows.length,
      c4.rows.at(-1)?.t,
      c4.rows.reduce((m, r) => (r.su > m ? r.su : m), ''),
    ].join('|')
    if (`${inputs}|${kept.rows[0]?.n}` === seen) return
    const bars4: Bar4[] = c4.rows.map((r) => ({ t: Number(r.t), o: r.o, h: r.h, l: r.l, c: r.c }))
    const decisions = snaps.rows.map((r) =>
      decide({ id: Number(r.id), cycleAt: r.cycle_at.getTime(), ref: r.ref, up: r.up, dn: r.dn, basis: r.basis } satisfies SnapshotInput, bars4, m1.rows),
    )
    const n = await writeDecisions(pool, decisions)
    if (n.written + n.deleted > 0) {
      const signals = decisions.filter((d) => d.signal).length
      const open = decisions.filter((d) => d.trade && d.trade.exitReason === null).length
      console.log(`[core] naif: ${decisions.length} karar (${signals} sinyal, ${open} açık işlem); ${n.written} satır yazıldı, ${n.deleted} silindi`)
    }
    seen = `${inputs}|${decisions.length}` // yazımdan sonra kayıtta tam bu kadar satır var
    const last = decisions.at(-1)
    if (last) await markOk(pool, source, '1 hour', new Date(last.cycleAt))
  } catch (err) {
    seen = null // hatadan sonraki tur baştan hesaplar (sağlık satırı da düzelir)
    const msg = (err as Error).message
    console.error(`[core] naif: ${msg}`)
    await logRun(pool, { source, startedAt, ok: false, error: msg })
    await markFail(pool, source, '1 hour', msg)
  }
}

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString())

const COLS = [
  'cycle_at',
  'decided_at',
  'in_window',
  'ref_price',
  'up_price',
  'dn_price',
  'basis',
  'direction',
  'entry_ref',
  'tp',
  'sl',
  'rr',
  'zone_4h',
  'aligned',
  'signal',
  'reason',
  'entry_bid',
  'entry_price',
  'spread',
  'exit_at',
  'exit_reason',
  'exit_price',
  'r_multiple',
  'mfe',
  'mae',
  'ambiguous',
] as const
const TYPES: Record<(typeof COLS)[number], string> = {
  cycle_at: 'timestamptz',
  decided_at: 'timestamptz',
  in_window: 'boolean',
  ref_price: 'float8',
  up_price: 'float8',
  dn_price: 'float8',
  basis: 'float8',
  direction: 'text',
  entry_ref: 'float8',
  tp: 'float8',
  sl: 'float8',
  rr: 'float8',
  zone_4h: 'text',
  aligned: 'boolean',
  signal: 'boolean',
  reason: 'text',
  entry_bid: 'float8',
  entry_price: 'float8',
  spread: 'float8',
  exit_at: 'timestamptz',
  exit_reason: 'text',
  exit_price: 'float8',
  r_multiple: 'float8',
  mfe: 'float8',
  mae: 'float8',
  ambiguous: 'boolean',
}

export function decisionRow(d: Decision) {
  const t = d.trade
  return {
    snapshot_id: d.snapshotId,
    cycle_at: iso(d.cycleAt),
    decided_at: iso(d.decidedAt),
    in_window: d.inWindow,
    ref_price: d.ref,
    up_price: d.up,
    dn_price: d.dn,
    basis: d.basis,
    direction: d.setup?.direction ?? null,
    entry_ref: d.setup?.entry ?? null,
    tp: d.setup?.tp ?? null,
    sl: d.setup?.sl ?? null,
    rr: d.setup?.rr ?? null,
    zone_4h: d.zone,
    aligned: d.aligned,
    signal: d.signal,
    reason: d.reason,
    entry_bid: t?.entryBid ?? null,
    entry_price: t?.entryPrice ?? null,
    spread: t?.spread ?? null,
    exit_at: iso(t?.exitAt ?? null),
    exit_reason: t?.exitReason ?? null,
    exit_price: t?.exitPrice ?? null,
    r_multiple: t?.r ?? null,
    mfe: t ? t.mfe : null,
    mae: t ? t.mae : null,
    ambiguous: t ? t.ambiguous : null,
  }
}

// Kararları kayda geçirir: değişen satırları yazar, artık üretilmeyenleri (snapshot silindi ya da aralık dışı) siler.
export async function writeDecisions(pool: Pool, decisions: Decision[]): Promise<{ written: number; deleted: number }> {
  const rows = decisions.map(decisionRow)
  const set = COLS.map((c) => `${c} = EXCLUDED.${c}`).join(', ')
  const cur = COLS.map((c) => `naive_decisions.${c}`).join(', ')
  const exc = COLS.map((c) => `EXCLUDED.${c}`).join(', ')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const w = await client.query(
      `INSERT INTO naive_decisions (version, snapshot_id, ${COLS.join(', ')})
       SELECT $1, u.snapshot_id, ${COLS.map((c) => `u.${c}`).join(', ')}
       FROM jsonb_to_recordset($2::jsonb) AS u(snapshot_id bigint, ${COLS.map((c) => `${c} ${TYPES[c]}`).join(', ')})
       ON CONFLICT (version, snapshot_id) DO UPDATE SET ${set}, computed_at = now()
       WHERE (${cur}) IS DISTINCT FROM (${exc})`,
      [NAIVE_VERSION, JSON.stringify(rows)],
    )
    const del = await client.query(`DELETE FROM naive_decisions WHERE version = $1 AND snapshot_id <> ALL ($2::bigint[])`, [
      NAIVE_VERSION,
      rows.map((r) => r.snapshot_id),
    ])
    await client.query('COMMIT')
    return { written: w.rowCount ?? 0, deleted: del.rowCount ?? 0 }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
