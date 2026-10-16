import { MAX_CANDLES, TF_MS, type CandleRow, type ChartTf, type ChartTokens, type PrevLevels, type Zones } from './chart-shared'
import { db } from './db'
import { SYMBOL } from './market-data'

export * from './chart-shared'

// Piyasa grafiğinin okumaları: Axi mumları (dilim ve aralıkla), core'un destek/direnç bölgeleri ve önceki
// gün/hafta seviyeleri. Grafik bunları sayfadan değil API'den okur; sayfa yalnız "değişti mi" işaretlerini taşır
// (dakikalık yenileme büyük veriyi her seferinde yeniden göndermesin diye).

// before: o andan önce açılmış son n mum; after: o andan sonra açılmış ilk n mum; ikisi de yoksa en yeni n mum.
// Her durumda eskiden yeniye.
export async function loadCandles(tf: ChartTf, opt: { before?: number; after?: number; n: number }): Promise<CandleRow[]> {
  const n = Math.max(1, Math.min(MAX_CANDLES, opt.n))
  const cols = `(extract(epoch FROM open_time) * 1000)::bigint::text AS t, open AS o, high AS h, low AS l, close AS c`
  const q =
    opt.after !== undefined
      ? {
          sql: `SELECT ${cols} FROM axi_candles WHERE symbol = $1 AND timeframe = $2 AND open_time > $3 ORDER BY open_time LIMIT $4`,
          args: [SYMBOL, tf, new Date(opt.after), n],
          reverse: false,
        }
      : {
          sql: `SELECT ${cols} FROM axi_candles WHERE symbol = $1 AND timeframe = $2 ${opt.before !== undefined ? 'AND open_time < $4' : ''}
                ORDER BY open_time DESC LIMIT $3`,
          args: opt.before !== undefined ? [SYMBOL, tf, n, new Date(opt.before)] : [SYMBOL, tf, n],
          reverse: true,
        }
  const { rows } = await db().query<{ t: string; o: number; h: number; l: number; c: number }>(q.sql, q.args)
  const out = rows.map((r): CandleRow => [Number(r.t), r.o, r.h, r.l, r.c])
  return q.reverse ? out.reverse() : out
}

// Dilimin oluşan mumları: kayıtlı son mumdan sonraki aralıklar, kapanmış 1m mumlarından (en çok önceki ve şimdiki
// aralık; collector bir dilimin mumunu kapanıştan birkaç saniye sonra yazar). Axi 4h ve 1d mumları İstanbul'a hizalı:
// aralık başı floor((t + 3 sa) / dilim) · dilim − 3 sa (5m–1h'te UTC ile aynı). Canlı quote'lar tarayıcıda bunun
// üstüne işlenir.
export async function loadForming(tf: ChartTf): Promise<CandleRow[]> {
  const { rows } = await db().query<{ t: string; o: number; h: number; l: number; c: number }>(
    `WITH b AS (
       SELECT greatest(
         coalesce((SELECT max(open_time) FROM axi_candles WHERE symbol = $1 AND timeframe = $2) + make_interval(secs => $3), '-infinity'),
         to_timestamp(floor((extract(epoch FROM now()) + 10800) / $3) * $3 - 10800 - $3)
       ) AS start
     )
     SELECT ((floor((extract(epoch FROM open_time) + 10800) / $3) * $3 - 10800) * 1000)::bigint::text AS t,
            (array_agg(open ORDER BY open_time))[1] AS o, max(high) AS h, min(low) AS l, (array_agg(close ORDER BY open_time DESC))[1] AS c
     FROM axi_candles, b
     WHERE symbol = $1 AND timeframe = '1m' AND open_time >= b.start
     GROUP BY 1 ORDER BY 1`,
    [SYMBOL, tf, TF_MS[tf] / 1000],
  )
  return rows.map((r): CandleRow => [Number(r.t), r.o, r.h, r.l, r.c])
}

// Son sürümün geçerli bölgeleri (on beş kadar), hangilerinin gösterileceğiyle. Tablo ya da sütun yoksa (core yeni
// sürümü henüz kurmadıysa) boş döner.
export async function loadZones(): Promise<Zones> {
  const pool = db()
  try {
    const { rows: vr } = await pool.query<{ version: string }>(`SELECT version FROM sr_versions ORDER BY created_at DESC LIMIT 1`)
    const version = vr[0]?.version ?? null
    if (!version) return { version: null, computedAt: null, zones: [] }
    const { rows } = await pool.query<{
      zone_id: number
      created_at: Date
      lo: number
      hi: number
      score: number
      score_4h: number
      score_1d: number
      score_1w: number
      touches: number
      holds: number
      breaks: number
      shown: boolean
      computed_at: Date
    }>(
      `SELECT zone_id, created_at, lo, hi, score, score_4h, score_1d, score_1w, touches, holds, breaks, shown,
              (SELECT max(computed_at) FROM sr_zones WHERE symbol = $1 AND version = $2) AS computed_at
       FROM sr_zones WHERE symbol = $1 AND version = $2 AND ended_at IS NULL ORDER BY lo`,
      [SYMBOL, version],
    )
    return {
      version,
      computedAt: rows[0]?.computed_at?.toISOString() ?? null,
      zones: rows.map((r) => ({
        id: r.zone_id,
        createdAt: r.created_at.getTime(),
        lo: r.lo,
        hi: r.hi,
        score: r.score,
        mix: [r.score_4h, r.score_1d, r.score_1w],
        touches: r.touches,
        holds: r.holds,
        breaks: r.breaks,
        shown: r.shown,
      })),
    }
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === '42P01' || code === '42703') return { version: null, computedAt: null, zones: [] } // tablo ya da sütun yok
    throw err
  }
}

const DAY = 86_400_000
const IST = 3 * 3_600_000

// Önceki gün ve önceki haftanın seviyeleri Axi günlük mumlarından. Günlük mumlar İstanbul 00:00'da açılır.
export async function loadPrevLevels(now: Date): Promise<PrevLevels> {
  const { rows } = await db().query<{ t: string; o: number; h: number; l: number; c: number }>(
    `SELECT (extract(epoch FROM open_time) * 1000)::bigint::text AS t, open AS o, high AS h, low AS l, close AS c
     FROM axi_candles WHERE symbol = $1 AND timeframe = '1d' AND open_time >= $2 ORDER BY open_time`,
    [SYMBOL, new Date(now.getTime() - 16 * DAY)],
  )
  const days = rows.map((r) => ({ t: Number(r.t), o: r.o, h: r.h, l: r.l, c: r.c })).filter((d) => d.t + DAY <= now.getTime())
  const last = days[days.length - 1]
  // bu haftanın başı: pazartesi 00:00 İstanbul (1 Ocak 1970 perşembe; pazartesiye 4 gün)
  const local = now.getTime() + IST
  const weekStart = Math.floor((local - 4 * DAY) / (7 * DAY)) * 7 * DAY + 4 * DAY - IST
  const prev = days.filter((d) => d.t >= weekStart - 7 * DAY && d.t < weekStart)
  return {
    day: last ? { at: last.t, h: last.h, l: last.l, c: last.c } : null,
    week: prev.length
      ? { at: weekStart - 7 * DAY, o: prev[0]!.o, h: Math.max(...prev.map((d) => d.h)), l: Math.min(...prev.map((d) => d.l)), c: prev[prev.length - 1]!.c }
      : null,
  }
}

export async function loadChartTokens(): Promise<ChartTokens> {
  const pool = db()
  const [c, z, h] = await Promise.all([
    pool.query<{ t: string | null }>(
      `SELECT (extract(epoch FROM max(open_time)) * 1000)::bigint::text AS t FROM axi_candles WHERE symbol = $1 AND timeframe = '1m'`,
      [SYMBOL],
    ),
    pool
      .query<{
        at: Date | null
      }>(`SELECT max(computed_at) AS at FROM sr_zones WHERE symbol = $1 AND version = (SELECT version FROM sr_versions ORDER BY created_at DESC LIMIT 1)`, [SYMBOL])
      .catch((err) => {
        if ((err as { code?: string }).code === '42P01') return { rows: [{ at: null }] }
        throw err
      }),
    pool.query<{ span: '12h' | '24h' | '48h'; id: string | null }>(
      `SELECT s.span, (SELECT id FROM heatmap_snapshots WHERE span = s.span ORDER BY received_at DESC LIMIT 1) AS id
       FROM unnest(ARRAY['12h', '24h', '48h']) AS s(span)`,
    ),
  ])
  const heat: ChartTokens['heat'] = { '12h': null, '24h': null, '48h': null }
  for (const r of h.rows) heat[r.span] = r.id === null ? null : Number(r.id)
  return { candle: c.rows[0]?.t ? Number(c.rows[0].t) : null, zones: z.rows[0]?.at?.toISOString() ?? null, heat }
}
