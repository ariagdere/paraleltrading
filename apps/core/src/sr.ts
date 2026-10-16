import { logRun, markFail, markOk, type Pool } from '@pt/db'
import { SYMBOL } from './sync.js'
import { DEFAULTS, SR_VERSION, run, weekly, type Candle, type Params, type Zone } from './zones.js'

// Destek/direnç bölgeleri: Axi 4h ya da 1d serisi değiştiğinde (yeni kapanış, düzeltilen ya da araya eklenen mum)
// bütün geçmiş baştan oynatılır ve yalnız değişen satırlar yazılır. Hesap as-of olduğu ve izler serinin başından
// biriktiği için her seferinde baştan yapılır (altı aylık 4h serisinde bir saniyenin altında). Yazım tek
// işlemde: okuyan hiçbir zaman yarım bir geçmiş görmez.

// Axi günleri İstanbul 00:00'da (21:00 UTC) açılır; haftalık mum pazartesi 00:00 İstanbul'dan.
const WEEK_OFFSET_MS = 3 * 3_600_000

// Süreç içinde son işlenen serilerin izi (dilim başına mum sayısı, son mum, son düzeltme); değişmediyse tur tek sorgu.
let seen: string | null = null

type CandleRow = { t: string; o: number; h: number; l: number; c: number }

const sameParams = (a: Record<string, unknown>, b: Params) => Object.keys(a).length === Object.keys(b).length && Object.entries(b).every(([k, v]) => a[k] === v)

export async function syncZones(pool: Pool) {
  const source = 'core:sr'
  const startedAt = new Date()
  try {
    const { rows: fps } = await pool.query<{ timeframe: string; n: string; last: Date; su: string }>(
      `SELECT timeframe, count(*) AS n, max(open_time) AS last, max(updated_at)::text AS su
       FROM axi_candles WHERE symbol = $1 AND timeframe IN ('4h', '1d') GROUP BY timeframe ORDER BY timeframe`,
      [SYMBOL],
    )
    const last4h = fps.find((r) => r.timeframe === '4h')?.last
    if (!last4h) return // henüz 4h mumu yok
    const key = fps.map((r) => `${r.timeframe}:${r.n}:${r.last.getTime()}:${r.su}`).join(',')
    if (key === seen) return

    const load = async (tf: '4h' | '1d'): Promise<Candle[]> => {
      const { rows } = await pool.query<CandleRow>(
        `SELECT (extract(epoch FROM open_time) * 1000)::bigint::text AS t, open AS o, high AS h, low AS l, close AS c
         FROM axi_candles WHERE symbol = $1 AND timeframe = $2 ORDER BY open_time`,
        [SYMBOL, tf],
      )
      return rows.map((r) => ({ t: Number(r.t), o: r.o, h: r.h, l: r.l, c: r.c }))
    }
    const [c4, d1] = await Promise.all([load('4h'), load('1d')])
    const { zones } = run(c4, d1, weekly(d1, WEEK_OFFSET_MS), DEFAULTS)
    const n = await writeZones(pool, zones)
    if (n.zones + n.events + n.deleted > 0) {
      const active = zones.filter((z) => z.endedAt === null).length
      console.log(`[core] destek/direnç: ${zones.length} bölge (${active} geçerli); ${n.zones} bölge, ${n.events} olay yazıldı, ${n.deleted} silindi`)
    }
    seen = key
    await markOk(pool, source, '4 hours', last4h)
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[core] destek/direnç: ${msg}`)
    await logRun(pool, { source, startedAt, ok: false, error: msg })
    await markFail(pool, source, '4 hours', msg)
  }
}

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString())

// Hesabı kayda geçirir: değişen bölge ve olayları yazar, artık üretilmeyenleri (geçmiş düzeltilince) siler.
export async function writeZones(pool: Pool, zones: Zone[]): Promise<{ zones: number; events: number; deleted: number }> {
  const zoneRows = zones.map((z) => ({
    zone_id: z.id,
    created_at: iso(z.createdAt),
    ended_at: iso(z.endedAt),
    end_reason: z.endReason,
    lo: z.lo,
    hi: z.hi,
    score: z.score,
    score_4h: z.mix['4h'],
    score_1d: z.mix['1d'],
    score_1w: z.mix['1w'],
    touches: z.touches,
    holds: z.holds,
    breaks: z.breaks,
    shown: z.shown,
    score_at: z.scores.map(([t]) => iso(t)),
    score_value: z.scores.map(([, v]) => v),
  }))
  const eventRows = zones.flatMap((z) =>
    z.events.map((e, i) => ({
      zone_id: z.id,
      seq: i + 1,
      at: iso(e.t),
      kind: e.kind,
      price: e.price,
      lo: e.lo,
      hi: e.hi,
      score: e.score,
      note: e.note ?? null,
    })),
  )
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`INSERT INTO sr_versions (version, params) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING`, [SR_VERSION, JSON.stringify(DEFAULTS)])
    const {
      rows: [v],
    } = await client.query<{ params: Record<string, unknown> }>(`SELECT params FROM sr_versions WHERE version = $1`, [SR_VERSION])
    if (!v || !sameParams(v.params, DEFAULTS)) throw new Error(`${SR_VERSION} sürümü başka parametrelerle kayıtlı; parametre değişince SR_VERSION da değişmeli`)

    const z = await client.query(
      `INSERT INTO sr_zones (symbol, version, zone_id, created_at, ended_at, end_reason, lo, hi, score, score_4h, score_1d, score_1w,
                             touches, holds, breaks, shown, score_at, score_value)
       SELECT $1, $2, u.zone_id, u.created_at, u.ended_at, u.end_reason, u.lo, u.hi, u.score, u.score_4h, u.score_1d, u.score_1w,
              u.touches, u.holds, u.breaks, u.shown, u.score_at, u.score_value
       FROM jsonb_to_recordset($3::jsonb) AS u(zone_id int, created_at timestamptz, ended_at timestamptz, end_reason text, lo float8, hi float8,
            score float8, score_4h float8, score_1d float8, score_1w float8, touches int, holds int, breaks int, shown boolean,
            score_at timestamptz[], score_value float8[])
       ON CONFLICT (symbol, version, zone_id) DO UPDATE SET
         created_at = EXCLUDED.created_at, ended_at = EXCLUDED.ended_at, end_reason = EXCLUDED.end_reason, lo = EXCLUDED.lo, hi = EXCLUDED.hi,
         score = EXCLUDED.score, score_4h = EXCLUDED.score_4h, score_1d = EXCLUDED.score_1d, score_1w = EXCLUDED.score_1w,
         touches = EXCLUDED.touches, holds = EXCLUDED.holds, breaks = EXCLUDED.breaks, shown = EXCLUDED.shown, score_at = EXCLUDED.score_at,
         score_value = EXCLUDED.score_value, computed_at = now()
       WHERE (sr_zones.created_at, sr_zones.ended_at, sr_zones.end_reason, sr_zones.lo, sr_zones.hi, sr_zones.score, sr_zones.score_4h,
              sr_zones.score_1d, sr_zones.score_1w, sr_zones.touches, sr_zones.holds, sr_zones.breaks, sr_zones.shown, sr_zones.score_at,
              sr_zones.score_value)
         IS DISTINCT FROM (EXCLUDED.created_at, EXCLUDED.ended_at, EXCLUDED.end_reason, EXCLUDED.lo, EXCLUDED.hi, EXCLUDED.score,
              EXCLUDED.score_4h, EXCLUDED.score_1d, EXCLUDED.score_1w, EXCLUDED.touches, EXCLUDED.holds, EXCLUDED.breaks, EXCLUDED.shown,
              EXCLUDED.score_at, EXCLUDED.score_value)`,
      [SYMBOL, SR_VERSION, JSON.stringify(zoneRows)],
    )
    const e = await client.query(
      `INSERT INTO sr_zone_events (symbol, version, zone_id, seq, at, kind, price, lo, hi, score, note)
       SELECT $1, $2, u.zone_id, u.seq, u.at, u.kind, u.price, u.lo, u.hi, u.score, u.note
       FROM jsonb_to_recordset($3::jsonb) AS u(zone_id int, seq int, at timestamptz, kind text, price float8, lo float8, hi float8, score float8, note text)
       ON CONFLICT (symbol, version, zone_id, seq) DO UPDATE SET
         at = EXCLUDED.at, kind = EXCLUDED.kind, price = EXCLUDED.price, lo = EXCLUDED.lo, hi = EXCLUDED.hi, score = EXCLUDED.score, note = EXCLUDED.note
       WHERE (sr_zone_events.at, sr_zone_events.kind, sr_zone_events.price, sr_zone_events.lo, sr_zone_events.hi, sr_zone_events.score,
              sr_zone_events.note)
         IS DISTINCT FROM (EXCLUDED.at, EXCLUDED.kind, EXCLUDED.price, EXCLUDED.lo, EXCLUDED.hi, EXCLUDED.score, EXCLUDED.note)`,
      [SYMBOL, SR_VERSION, JSON.stringify(eventRows)],
    )
    // Geçmiş düzeltilince artık üretilmeyen olaylar ve bölgeler (bölgenin olayları onunla birlikte silinir).
    const de = await client.query(
      `DELETE FROM sr_zone_events s WHERE s.symbol = $1 AND s.version = $2
         AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS u(zone_id int, seq int) WHERE u.zone_id = s.zone_id AND u.seq = s.seq)`,
      [SYMBOL, SR_VERSION, JSON.stringify(eventRows.map((r) => ({ zone_id: r.zone_id, seq: r.seq })))],
    )
    const dz = await client.query(`DELETE FROM sr_zones WHERE symbol = $1 AND version = $2 AND zone_id <> ALL ($3::int[])`, [
      SYMBOL,
      SR_VERSION,
      zones.map((x) => x.id),
    ])
    await client.query('COMMIT')
    return { zones: z.rowCount ?? 0, events: e.rowCount ?? 0, deleted: (de.rowCount ?? 0) + (dz.rowCount ?? 0) }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
