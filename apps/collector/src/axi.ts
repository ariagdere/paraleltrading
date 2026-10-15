import { createHash } from 'node:crypto'
import type { Pool } from '@pt/db'
import { config } from './config.js'
import { logRun, markFail, markOk } from './status.js'

// Axi BTCUSD mumları (MetaApi geçmiş API'si): 1m, 5m, 15m, 1h, 4h, 1d, Axi'nin kendi sınırlarıyla.
// Her dakika, kapanışı gelen dilimler için son kayıttan bugüne doldurur; az önce kapanan mumu bir sonraki
// turda bir kez daha ister (geç gelen tikler düzeltilsin). İlk açılışta AXI_BACKFILL_FROM'dan 1000 mum
// öncesine kadar geriye doldurur (göstergelerin ısınması için); yarım kalırsa sonraki açılışta sürdürür.
// İstekler sırayla gider: MetaApi hesap başına aynı anda en çok 5 geçmiş isteği kabul ediyor ve eski
// dashboard da aynı hesabı kullanıyor.

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const
export type Timeframe = (typeof TIMEFRAMES)[number]
export const STEP_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
}
export const EXPECTED_EVERY: Record<Timeframe, string> = {
  '1m': '1 minute',
  '5m': '5 minutes',
  '15m': '15 minutes',
  '1h': '1 hour',
  '4h': '4 hours',
  '1d': '1 day',
}
const PAGE = 1000
const RECHECK_MS = 2 * 60_000 // kapanıştan sonraki bu süre içinde son mum bir kez daha istenir

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number | null; s: number | null }

// Geriye doldurması biten dilimler (süreç ömrü boyunca; açılışta bir kez kontrol edilir).
const backfillDone = new Set<Timeframe>()

async function metaapi(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'auth-token': config.metaapi.token, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`MetaApi HTTP ${res.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null)

function parse(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) throw new Error('MetaApi mum yanıtı beklenen biçimde değil')
  const out: Candle[] = []
  for (const r of raw as Array<Record<string, unknown> | null>) {
    const t = Date.parse(String(r?.time))
    const [o, h, l, c] = [num(r?.open), num(r?.high), num(r?.low), num(r?.close)]
    if (!Number.isFinite(t) || o === null || h === null || l === null || c === null) continue
    const s = num(r?.spread)
    out.push({ t, o, h, l, c, v: num(r?.tickVolume), s: s === null ? null : Math.round(s) })
  }
  return out
}

// beforeMs yoksa en yeni mumlar (oluşan dahil); varsa o andan önceki mumlar (MetaApi geriye doğru yükler).
async function fetchPage(tf: Timeframe, limit: number, beforeMs: number | null): Promise<Candle[]> {
  const { marketDataUrl, accountId, symbol } = config.metaapi
  const since = beforeMs === null ? '' : `&startTime=${encodeURIComponent(new Date(beforeMs).toISOString())}`
  const url =
    `${marketDataUrl}/users/current/accounts/${accountId}/historical-market-data/symbols/${symbol}` +
    `/timeframes/${tf}/candles?limit=${limit}${since}`
  return parse(await metaapi(url, limit > 50 ? 90_000 : 20_000))
}

// Yeni mumları ekler, değişenleri günceller (received_at ilk gelişte kalır). Dönüş: eklenen + değişen satır.
async function save(pool: Pool, tf: Timeframe, candles: Candle[]): Promise<number> {
  const rows = [...new Map(candles.map((c) => [c.t, c])).values()] // aynı mum iki kez gelirse sonuncusu
  if (rows.length === 0) return 0
  const res = await pool.query(
    `INSERT INTO axi_candles (symbol, timeframe, open_time, open, high, low, close, tick_volume, spread_points)
     SELECT $1, $2, to_timestamp(t / 1000.0), o, h, l, c, v, s
     FROM unnest($3::bigint[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::bigint[], $9::int[])
       AS u(t, o, h, l, c, v, s)
     ON CONFLICT (symbol, timeframe, open_time) DO UPDATE SET
       open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
       tick_volume = EXCLUDED.tick_volume, spread_points = EXCLUDED.spread_points, updated_at = now()
     WHERE (axi_candles.open, axi_candles.high, axi_candles.low, axi_candles.close,
            axi_candles.tick_volume, axi_candles.spread_points)
       IS DISTINCT FROM (EXCLUDED.open, EXCLUDED.high, EXCLUDED.low, EXCLUDED.close,
            EXCLUDED.tick_volume, EXCLUDED.spread_points)`,
    [
      config.metaapi.symbol,
      tf,
      rows.map((r) => r.t),
      rows.map((r) => r.o),
      rows.map((r) => r.h),
      rows.map((r) => r.l),
      rows.map((r) => r.c),
      rows.map((r) => r.v),
      rows.map((r) => r.s),
    ],
  )
  return res.rowCount ?? 0
}

// cursor'dan (null: şimdi) geriye sayfa sayfa iner; stopAt'e ulaşınca ya da MetaApi'nin geçmişi bitince durur.
// Yalnız kapanmış mumlar yazılır.
async function walkBack(pool: Pool, tf: Timeframe, cursor: number | null, stopAt: number, firstLimit: number) {
  const now = Date.now()
  let written = 0
  let oldest: number | null = null
  let exhausted = false
  let limit = firstLimit
  for (;;) {
    const page = await fetchPage(tf, limit, cursor)
    written += await save(pool, tf, page.filter((c) => c.t + STEP_MS[tf] <= now))
    if (page.length === 0) {
      exhausted = true
      break
    }
    const min = Math.min(...page.map((c) => c.t))
    if (cursor !== null && min >= cursor) {
      exhausted = true // ilerleme yok
      break
    }
    oldest = oldest === null ? min : Math.min(oldest, min)
    if (min <= stopAt) break
    cursor = min - 1
    limit = PAGE
    await new Promise((r) => setTimeout(r, config.metaapi.pagePauseMs))
  }
  return { written, oldest, exhausted }
}

async function bounds(pool: Pool, tf: Timeframe) {
  const { rows } = await pool.query<{ first: Date | null; last: Date | null }>(
    'SELECT min(open_time) AS first, max(open_time) AS last FROM axi_candles WHERE symbol = $1 AND timeframe = $2',
    [config.metaapi.symbol, tf],
  )
  return { first: rows[0]?.first?.getTime() ?? null, last: rows[0]?.last?.getTime() ?? null }
}

export async function syncAxi(pool: Pool) {
  for (const tf of TIMEFRAMES) {
    const step = STEP_MS[tf]
    const source = `axi:${tf}`
    const startedAt = new Date()
    try {
      const target = config.metaapi.backfillFrom - PAGE * step
      const now = Date.now()
      let { last } = await bounds(pool, tf)
      let written = 0

      // İleri: yeni kapanmış mum var mı, ya da son mum az önce mi kapandı (bir kez daha istenir).
      const due = last === null || last + 2 * step <= now || now - (last + step) < RECHECK_MS
      if (due) {
        const since = last ?? target
        const limit = Math.min(PAGE, Math.max(3, Math.ceil((now - since) / step) + 2))
        written += (await walkBack(pool, tf, null, since, limit)).written
      }

      // Geri: ilk açılışta ya da yarım kalmış doldurmada en eski mumdan hedefe kadar.
      if (!backfillDone.has(tf)) {
        const { first } = await bounds(pool, tf)
        if (first !== null && first > target) {
          const r = await walkBack(pool, tf, first, target, PAGE)
          written += r.written
          if (r.exhausted) {
            const reached = new Date(r.oldest ?? first).toISOString()
            console.log(`[axi] ${tf}: MetaApi geçmişi ${reached} tarihinde bitiyor`)
            await logRun(pool, { source, startedAt, ok: true, rowsWritten: r.written, detail: { historyStart: reached } })
          }
        }
        backfillDone.add(tf)
      }

      if (written > 1) console.log(`[axi] ${tf}: ${written} mum yazıldı`)
      ;({ last } = await bounds(pool, tf))
      if (due || written > 0) await markOk(pool, source, EXPECTED_EVERY[tf], last === null ? null : new Date(last))
    } catch (err) {
      const msg = (err as Error).name === 'TimeoutError' ? 'MetaApi zamanında yanıt vermedi' : (err as Error).message
      console.error(`[axi] ${tf}: ${msg}`)
      await logRun(pool, { source, startedAt, ok: false, error: msg })
      await markFail(pool, source, EXPECTED_EVERY[tf], msg)
    }
  }
}

// Sembol bilgisi (digits, point, lot adımı, kontrat büyüklüğü, swap...): değiştiğinde yeni satır.
export async function syncSpec(pool: Pool) {
  const source = 'axi:spec'
  const startedAt = new Date()
  try {
    const { clientUrl, accountId, symbol } = config.metaapi
    const spec = await metaapi(`${clientUrl}/users/current/accounts/${accountId}/symbols/${symbol}/specification`, 30_000)
    if (!spec || typeof spec !== 'object') throw new Error('MetaApi sembol bilgisi beklenen biçimde değil')
    const hash = createHash('sha256').update(JSON.stringify(spec)).digest('hex')
    const { rows } = await pool.query<{ spec_hash: string }>(
      'SELECT spec_hash FROM axi_symbol_spec WHERE symbol = $1 ORDER BY captured_at DESC LIMIT 1',
      [symbol],
    )
    if (rows[0]?.spec_hash !== hash) {
      await pool.query('INSERT INTO axi_symbol_spec (symbol, spec_hash, spec) VALUES ($1, $2, $3)', [symbol, hash, JSON.stringify(spec)])
      console.log(`[axi] ${symbol} sembol bilgisi kaydedildi`)
    }
    await markOk(pool, source, '6 hours')
  } catch (err) {
    const msg = (err as Error).name === 'TimeoutError' ? 'MetaApi zamanında yanıt vermedi' : (err as Error).message
    console.error(`[axi] sembol bilgisi: ${msg}`)
    await logRun(pool, { source, startedAt, ok: false, error: msg })
    await markFail(pool, source, '6 hours', msg)
  }
}
