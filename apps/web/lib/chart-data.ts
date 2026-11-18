import { axiOpen, axiToUtc } from '@pt/db/axitime'
import { MAX_CANDLES, TF_MS, type CandleRow, type ChartTf, type ChartTokens, type ManualZone, type PrevLevels } from './chart-shared'
import { db } from './db'
import { SYMBOL } from './market-data'

export * from './chart-shared'

// Piyasa grafiğinin okumaları: Axi mumları (dilim ve aralıkla), elle zonlar ve önceki gün/hafta seviyeleri. Grafik bunları sayfadan değil API'den okur; sayfa yalnız "değişti mi" işaretlerini taşır
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
// aralık; collector bir dilimin mumunu kapanıştan birkaç saniye sonra yazar). 4h ve 1d aralıkları Axi sunucu saatine
// hizalı (@pt/db/axitime): 1m mumları sunucu saatindeki aralığa göre toplanır, aralık başı gerçek UTC'ye çevrilir.
// Kayıtlı son mumdan bir dilim sonrasının bir saat öncesinden okunur: geçiş günlerindeki 23 saatlik gün ve 3 saatlik
// 4h mumundan sonraki aralık da tam gelsin. Canlı quote'lar tarayıcıda bunun üstüne işlenir.
const H = 3_600_000
const AXI_OFF = `(extract(epoch FROM (c.open_time AT TIME ZONE 'America/New_York')) - extract(epoch FROM c.open_time) + 25200)`

export async function loadForming(tf: ChartTf): Promise<CandleRow[]> {
  const step = TF_MS[tf]
  const prev = axiOpen(axiOpen(Date.now(), step) - 1, step)
  const { rows } = await db().query<{ lb: string; o: number; h: number; l: number; c: number; last: string | null }>(
    `WITH m AS (SELECT max(open_time) AS last FROM axi_candles WHERE symbol = $1 AND timeframe = $2)
     SELECT (floor((extract(epoch FROM c.open_time) + ${step > H ? AXI_OFF : '0'}) / $3) * $3 * 1000)::bigint::text AS lb,
            (array_agg(c.open ORDER BY c.open_time))[1] AS o, max(c.high) AS h, min(c.low) AS l,
            (array_agg(c.close ORDER BY c.open_time DESC))[1] AS c, (extract(epoch FROM min(m.last)) * 1000)::bigint::text AS last
     FROM axi_candles c, m
     WHERE c.symbol = $1 AND c.timeframe = '1m' AND c.open_time >= $4
       AND c.open_time >= coalesce(m.last + make_interval(secs => $3) - interval '1 hour', '-infinity')
     GROUP BY 1 ORDER BY 1`,
    [SYMBOL, tf, step / 1000, new Date(prev)],
  )
  const out: CandleRow[] = []
  for (const r of rows) {
    const t = step > H ? axiToUtc(Number(r.lb)) : Number(r.lb)
    if (r.last === null || t > Number(r.last)) out.push([t, r.o, r.h, r.l, r.c])
  }
  return out
}

// Elle zonlar: şu an geçerli olanların hepsi (Ari'nin çizdiği; zon eklemek ya da kapatmak şimdilik veritabanından).
const ACTIVE_MANUAL = `created_at <= now() AND (ended_at IS NULL OR ended_at > now())`
export async function loadManualZones(): Promise<ManualZone[]> {
  try {
    const { rows } = await db().query<{ id: number; lo: number; hi: number; created_at: Date }>(
      `SELECT id, lo, hi, created_at FROM elle_zones WHERE ${ACTIVE_MANUAL} ORDER BY lo DESC`,
    )
    return rows.map((r) => ({ id: r.id, lo: r.lo, hi: r.hi, createdAt: r.created_at.getTime() }))
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') return [] // tablo yok (010 uygulanmamış)
    throw err
  }
}

const DAY = 86_400_000
const IST = 3 * 3_600_000

// Önceki gün ve önceki haftanın seviyeleri Axi günlük mumlarından. Günlük mumlar Axi sunucu saatinin 00:00'ında açılır
// (yazın İstanbul 00:00, kışın 01:00); ikisi de aynı İstanbul gününde, hafta pazartesi 00:00 İstanbul'dan sayılır.
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
  const [c, h, m] = await Promise.all([
    pool.query<{ t: string | null }>(
      `SELECT (extract(epoch FROM max(open_time)) * 1000)::bigint::text AS t FROM axi_candles WHERE symbol = $1 AND timeframe = '1m'`,
      [SYMBOL],
    ),
    pool.query<{ span: '12h' | '24h' | '48h'; id: string | null }>(
      `SELECT s.span, (SELECT id FROM heatmap_snapshots WHERE span = s.span ORDER BY received_at DESC LIMIT 1) AS id
       FROM unnest(ARRAY['12h', '24h', '48h']) AS s(span)`,
    ),
    pool
      .query<{ k: string | null }>(
        `SELECT count(*) FILTER (WHERE ${ACTIVE_MANUAL}) || ':' || coalesce(max(inserted_at)::text, '') || ':' || coalesce(max(ended_at)::text, '') AS k FROM elle_zones`,
      )
      .catch((err) => {
        if ((err as { code?: string }).code === '42P01') return { rows: [{ k: null }] }
        throw err
      }),
  ])
  const heat: ChartTokens['heat'] = { '12h': null, '24h': null, '48h': null }
  for (const r of h.rows) heat[r.span] = r.id === null ? null : Number(r.id)
  return { candle: c.rows[0]?.t ? Number(c.rows[0].t) : null, manual: m.rows[0]?.k ?? null, heat }
}
