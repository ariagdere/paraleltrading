import { MAX_CANDLES, type CandleRow, type ChartTf, type ChartTokens, type ChartZone, type PrevLevels, type Zones } from './chart-shared'
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

// Son sürümün bütün bölgeleri ve olayları (yüz kadar bölge, bin kadar olay). Tablolar yoksa (core henüz bu
// sürümde değil) boş döner.
export async function loadZones(): Promise<Zones> {
  const pool = db()
  try {
    const { rows: vr } = await pool.query<{ version: string }>(`SELECT version FROM sr_versions ORDER BY created_at DESC LIMIT 1`)
    const version = vr[0]?.version ?? null
    if (!version) return { version: null, computedAt: null, zones: [] }
    const [zs, es] = await Promise.all([
      pool.query<{
        zone_id: number
        created_at: Date
        ended_at: Date | null
        end_reason: string | null
        lo: number
        hi: number
        score: number
        score_4h: number
        score_1d: number
        score_1w: number
        touches: number
        holds: number
        breaks: number
        computed_at: Date
      }>(
        `SELECT zone_id, created_at, ended_at, end_reason, lo, hi, score, score_4h, score_1d, score_1w, touches, holds, breaks, computed_at
         FROM sr_zones WHERE symbol = $1 AND version = $2 ORDER BY zone_id`,
        [SYMBOL, version],
      ),
      pool.query<{ zone_id: number; at: Date; kind: string; price: number; lo: number; hi: number }>(
        `SELECT zone_id, at, kind, price, lo, hi FROM sr_zone_events WHERE symbol = $1 AND version = $2 ORDER BY zone_id, seq`,
        [SYMBOL, version],
      ),
    ])
    const byZone = new Map<number, ChartZone>()
    let computedAt: Date | null = null
    for (const r of zs.rows) {
      if (!computedAt || r.computed_at > computedAt) computedAt = r.computed_at
      byZone.set(r.zone_id, {
        id: r.zone_id,
        createdAt: r.created_at.getTime(),
        endedAt: r.ended_at ? r.ended_at.getTime() : null,
        endReason: r.end_reason,
        lo: r.lo,
        hi: r.hi,
        score: r.score,
        mix: [r.score_4h, r.score_1d, r.score_1w],
        touches: r.touches,
        holds: r.holds,
        breaks: r.breaks,
        bands: [],
        marks: [],
      })
    }
    for (const e of es.rows) {
      const z = byZone.get(e.zone_id)
      if (!z) continue
      const t = e.at.getTime()
      if (e.kind === 'created' || e.kind === 'resized') z.bands.push([t, e.lo, e.hi])
      else if (e.kind === 'touch' || e.kind === 'hold' || e.kind === 'break') z.marks.push([t, e.kind, e.price])
    }
    return { version, computedAt: computedAt?.toISOString() ?? null, zones: [...byZone.values()] }
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') return { version: null, computedAt: null, zones: [] } // tablo yok
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
      .query<{ at: Date | null }>(
        `SELECT max(computed_at) AS at FROM sr_zones WHERE symbol = $1 AND version = (SELECT version FROM sr_versions ORDER BY created_at DESC LIMIT 1)`,
        [SYMBOL],
      )
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
