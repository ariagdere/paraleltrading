import { db } from './db'
import { SYMBOL } from './market-data'
import type { Candle, ChartExit, ChartPayload, ChartSetup, ChartZone } from './sdl-chart-shared'

// SDL kurulum grafiğinin verisi (/api/sdl/grafik): araştırma sayfasındaki iki grafik gibi 3m "giriş ve çıkış"
// (FVG'den ve iğneden 30 dk önce → çıkıştan 15 dk sonra) ve 15m "geniş görünüm" (4 saat önce → 2 saat sonra).
// Mumlar resmi 1m'lerden (axi_candles; resmide henüz olmayan son dakikalar fiyat akışından, sdl_bars), bid.
// Çıkış: gerçek işlem (eski sistemin kaydı, legacy_orders) > benzetim (sim_*) > açık (son fiyat). Bekleyen kurulum
// listenin hesaplandığı kapanışa kadar; planlanan pozisyon için sağda boş mum yeri bırakılır.

const MIN = 60_000
const M3 = 3 * MIN
const M15 = 15 * MIN
const H = 60 * MIN
const fl = (t: number, step: number) => Math.floor(t / step) * step
const num = (x: unknown) => (x === null || x === undefined || x === '' ? null : Number(x))
const ms = (d: Date | string) => new Date(d).getTime()

async function minutes(from: number, to: number): Promise<Candle[]> {
  const { rows } = await db().query<{ t: string; o: number; h: number; l: number; c: number; k: number }>(
    `SELECT (extract(epoch FROM open_time) * 1000)::bigint::text AS t, open AS o, high AS h, low AS l, close AS c, 0 AS k
       FROM axi_candles WHERE symbol = $1 AND timeframe = '1m' AND open_time >= $2 AND open_time < $3
     UNION ALL
     SELECT (extract(epoch FROM open_time) * 1000)::bigint::text, open, high, low, close, 1
       FROM sdl_bars WHERE open_time >= $2 AND open_time < $3
     ORDER BY 1, 6`,
    [SYMBOL, new Date(from), new Date(to)],
  )
  const out: Candle[] = []
  for (const r of rows) {
    const t = Number(r.t)
    if (out.length && out[out.length - 1]!.t === t) continue // resmi mum varsa akışınki atlanır
    out.push({ t, o: r.o, h: r.h, l: r.l, c: r.c })
  }
  return out
}

function group(m1: Candle[], step: number): Candle[] {
  const out: Candle[] = []
  for (const c of m1) {
    const t = fl(c.t, step)
    const cur = out[out.length - 1]
    if (cur && cur.t === t) {
      cur.h = Math.max(cur.h, c.h)
      cur.l = Math.min(cur.l, c.l)
      cur.c = c.c
    } else out.push({ t, o: c.o, h: c.h, l: c.l, c: c.c })
  }
  return out
}

async function zonesAt(t: number, entry: number, target: number): Promise<ChartZone[]> {
  const { rows } = await db().query<{ id: number; lo: number; hi: number }>(
    `SELECT id, lo, hi FROM elle_zones WHERE created_at <= $1 AND (ended_at IS NULL OR ended_at > $1) ORDER BY lo DESC`,
    [new Date(t)],
  )
  return rows.map((z) => ({ id: z.id, lo: z.lo, hi: z.hi, role: z.id === entry ? 'entry' : z.id === target ? 'target' : 'other' }))
}

// İki pencerenin mumları; end: çıkış ya da verinin sonu; until: bu andan sonrası alınmaz (bekleyende listenin anı).
async function windows(s0: number, end: number, until: number | null) {
  const a0 = fl(s0 - 30 * MIN, M3)
  const a1 = fl(end + 15 * MIN, M3) + M3
  const b0 = fl(s0 - 4 * H, M15)
  const b1 = fl(end + 2 * H, M15) + M15
  const to = until === null ? Math.max(a1, b1) : Math.min(Math.max(a1, b1), until)
  const m1 = await minutes(Math.min(a0, b0), to)
  const last = m1.length ? m1[m1.length - 1]!.t + MIN : s0
  return {
    c3: group(m1.filter((c) => c.t >= a0 && c.t < a1), M3),
    c15: group(m1.filter((c) => c.t >= b0 && c.t < b1), M15),
    asOf: last,
  }
}

const rOf = (side: string, entry: number, sl: number, price: number) =>
  (side === 'SHORT' ? entry - price : price - entry) / Math.abs(entry - sl)

export async function loadSetupChart(id: number): Promise<ChartPayload | null> {
  const { rows } = await db().query(
    `SELECT s.*, o.status AS o_status, o.fill_price AS o_fill, o.volume AS o_volume,
            l.status AS l_status, l.closed_at AS l_closed_at, l.data->>'exit_reason' AS l_reason, l.data->>'close_price' AS l_close,
            l.data->>'realized_pnl' AS l_pnl, l.data->>'fill_price' AS l_fill, l.data->>'sl' AS l_sl, l.data->>'volume' AS l_volume
       FROM sdl_setups s
       LEFT JOIN sdl_orders o ON o.setup_id = s.id
       LEFT JOIN LATERAL (
         SELECT lo.status, lo.closed_at, lo.data FROM legacy_orders lo
         WHERE o.mt5_position_id IS NOT NULL AND lo.data->>'mt5_position_id' = o.mt5_position_id ORDER BY lo.id DESC LIMIT 1
       ) l ON true
      WHERE s.id = $1`,
    [id],
  )
  const r = rows[0]
  if (!r) return null
  const side = r.side as 'LONG' | 'SHORT'
  const filled = r.o_status === 'FILLED'
  const fill = filled ? (num(r.l_fill) ?? num(r.o_fill)) : null
  const entry = fill ?? r.entry_ref
  const sl = (filled ? num(r.l_sl) : null) ?? r.sl
  const entryT = ms(r.entry_t)

  let exit: ChartExit | null = null
  if (filled && r.l_status === 'CLOSED' && r.l_closed_at) {
    const reason = r.l_reason as string | null
    const price = num(r.l_close) ?? (reason === 'TP' ? r.tp : reason === 'SL' ? sl : null)
    const vol = num(r.l_volume) ?? num(r.o_volume)
    const pnl = num(r.l_pnl)
    if (price !== null) {
      const R = pnl !== null && vol ? pnl / (Math.abs(entry - sl) * vol) : rOf(side, entry, sl, price)
      exit = { t: ms(r.l_closed_at), kind: reason === 'TP' ? 'TP' : reason === 'SL' ? 'SL' : 'MANUEL', price, r: R, source: 'gercek' }
    }
  } else if (r.sim_exit_at && !(filled && r.l_status === 'OPEN')) {
    // Emir gitmediyse ya da eski sistemin kaydı henüz kopyalanmadıysa (saatte bir) benzetim
    const price = r.sim_exit_kind === 'TP' ? r.tp : r.sl
    exit = { t: ms(r.sim_exit_at), kind: r.sim_exit_kind, price, r: filled ? rOf(side, entry, sl, price) : (r.sim_r ?? rOf(side, entry, sl, price)), source: 'benzetim' }
  }

  const s0 = Math.min(ms(r.fvg_a), ms(r.ext_t))
  const { rows: lastRow } = await db().query<{ t: string | null }>(
    `SELECT (extract(epoch FROM greatest(
        (SELECT max(open_time) FROM axi_candles WHERE symbol = $1 AND timeframe = '1m'),
        (SELECT max(open_time) FROM sdl_bars))) * 1000)::bigint::text AS t`,
    [SYMBOL],
  )
  const dataEnd = lastRow[0]?.t ? Number(lastRow[0].t) + MIN : entryT
  const w = await windows(s0, exit ? exit.t : Math.max(entryT, dataEnd), null)
  if (!exit) {
    const lastC = w.c3[w.c3.length - 1]
    const price = lastC ? lastC.c : entry
    exit = { t: Math.max(w.asOf, entryT), kind: 'OPEN', price, r: rOf(side, entry, sl, price), source: 'acik' }
  }
  const setup: ChartSetup = {
    kind: 'kurulum',
    side,
    fvgA: ms(r.fvg_a),
    fvgI: ms(r.fvg_i),
    fvgLo: r.fvg_lo,
    fvgHi: r.fvg_hi,
    ext: r.ext,
    extT: ms(r.ext_t),
    entryCandle: ms(r.entry_candle),
    entryT,
    entry,
    sl,
    tp: r.tp,
    trigger: null,
    status: null,
    expiresAt: null,
    zone: r.zone_id,
    tpZone: r.tp_zone_id,
    zones: await zonesAt(entryT, r.zone_id, r.tp_zone_id),
    exit,
    real: fill !== null,
  }
  return { setup, c3: w.c3, c15: w.c15, future3: 0, future15: 0, asOf: w.asOf }
}

export async function loadPendingChart(side: 'LONG' | 'SHORT', fvgA: number): Promise<ChartPayload | null> {
  const { rows } = await db().query(`SELECT * FROM sdl_pending WHERE side = $1 AND fvg_a = $2`, [side, new Date(fvgA)])
  const p = rows[0]
  if (!p) return null
  const asOf = ms(p.as_of)
  const s0 = Math.min(ms(p.fvg_a), ms(p.ext_t))
  const w = await windows(s0, asOf, asOf)
  const setup: ChartSetup = {
    kind: 'bekleyen',
    side,
    fvgA: ms(p.fvg_a),
    fvgI: ms(p.fvg_i),
    fvgLo: p.fvg_lo,
    fvgHi: p.fvg_hi,
    ext: p.ext,
    extT: ms(p.ext_t),
    entryCandle: null,
    entryT: asOf,
    entry: p.entry,
    sl: p.sl,
    tp: p.tp,
    trigger: p.trigger,
    status: p.status,
    expiresAt: ms(p.expires_at),
    zone: p.zone_id,
    tpZone: p.tp_zone_id,
    zones: await zonesAt(asOf, p.zone_id, p.tp_zone_id),
    exit: null,
    real: false,
  }
  return {
    setup,
    c3: w.c3,
    c15: w.c15,
    future3: Math.max(12, Math.round(w.c3.length * 0.3)),
    future15: Math.max(8, Math.round(w.c15.length * 0.3)),
    asOf,
  }
}
