import { createHash } from 'node:crypto'
import type { Pool } from '@pt/db'
import { config } from './config.js'
import { logRun, markFail, markOk } from './status.js'

// Axi BTCUSD mumları (MetaApi geçmiş API'si): 1m, 5m, 15m, 1h, 4h, 1d, Axi'nin kendi sınırlarıyla.
// İki ayrı iş:
//   syncAxi (dakikada bir): kapanışı gelen dilimler için son kayıttan bugüne doldurur; az önce kapanan mumu
//     bir sonraki turda bir kez daha ister (geç gelen tikler düzeltilsin). Boş dilimde yalnız en yeni sayfayı
//     yazar, canlı veri hemen başlasın.
//   backfillAxi (dakikada bir, tur başına en çok 40 sn): en eski mumdan AXI_BACKFILL_FROM'un 1000 mum öncesine
//     kadar geriye iner (göstergelerin ısınması için). MetaApi derin geçmişi bazen zamanında getiremiyor
//     ("Timed out waiting for bars"); o zaman sayfayı küçültüp bekleyerek tekrar dener. Durumu axi:backfill
//     satırında; canlı dilimlerin sağlığını etkilemez.
// MetaApi'de hesap başına aynı anda en çok 5 geçmiş isteği var ve eski dashboard en çok 3 kullanıyor;
// bu iki iş en çok 2 eşzamanlı istek yapar.

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
const MIN_PAGE = 100
const RECHECK_MS = 2 * 60_000 // kapanıştan sonraki bu süre içinde son mum bir kez daha istenir
const BACKFILL_BUDGET_MS = 40_000
const BACKFILL_ORDER: Timeframe[] = ['1d', '4h', '1h', '15m', '5m', '1m'] // ucuzdan pahalıya

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number | null; s: number | null }

async function metaapi(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'auth-token': config.metaapi.token, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`MetaApi HTTP ${res.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

const errText = (err: unknown) =>
  (err as Error).name === 'TimeoutError' ? 'MetaApi zamanında yanıt vermedi' : (err as Error).message
const iso = (t: number) => new Date(t).toISOString()
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
  const since = beforeMs === null ? '' : `&startTime=${encodeURIComponent(iso(beforeMs))}`
  const url =
    `${marketDataUrl}/users/current/accounts/${accountId}/historical-market-data/symbols/${symbol}` +
    `/timeframes/${tf}/candles?limit=${limit}${since}`
  return parse(await metaapi(url, limit > 50 ? 90_000 : 20_000))
}

// Yalnız kapanmış mumları yazar: yenileri ekler, değişenleri günceller (received_at ilk gelişte kalır).
// Dönüş: eklenen + değişen satır.
async function saveClosed(pool: Pool, tf: Timeframe, candles: Candle[]): Promise<number> {
  const now = Date.now()
  const closed = candles.filter((c) => c.t + STEP_MS[tf] <= now)
  const rows = [...new Map(closed.map((c) => [c.t, c])).values()] // aynı mum iki kez gelirse sonuncusu
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

async function bounds(pool: Pool, tf: Timeframe) {
  const { rows } = await pool.query<{ first: Date | null; last: Date | null }>(
    'SELECT min(open_time) AS first, max(open_time) AS last FROM axi_candles WHERE symbol = $1 AND timeframe = $2',
    [config.metaapi.symbol, tf],
  )
  return { first: rows[0]?.first?.getTime() ?? null, last: rows[0]?.last?.getTime() ?? null }
}

// Dilim başına durum. limit: geçmişe (startTime ile) sayfa isterken kullanılan boyut; MetaApi zaman aşımına
// düştükçe yarıya iner (en az MIN_PAGE) ve iki iş de onu kullanır.
type TfState = { done: boolean; limit: number; nextAt: number; failures: number }
const states = new Map<Timeframe, TfState>()
let backfillReported = false

function state(tf: Timeframe): TfState {
  let s = states.get(tf)
  if (!s) states.set(tf, (s = { done: false, limit: PAGE, nextAt: 0, failures: 0 }))
  return s
}

// Canlı: kapanışı gelen dilimler için son kayıttan bugüne doldurur. Boşluk tek sayfaya sığmıyorsa (servis bir süre
// kapalı kaldıysa) eski uçtan pencere pencere ilerler: bir pencere hata verirse kayıtlı seri yine kesintisiz kalır
// ve sonraki tur kaldığı yerden sürer. (En yeni sayfadan geriye inseydik, yarıda kalan bir doldurma son mumların
// arkasında kalıcı bir delik bırakırdı.)
export async function syncAxi(pool: Pool) {
  for (const tf of TIMEFRAMES) {
    const step = STEP_MS[tf]
    const source = `axi:${tf}`
    const startedAt = new Date()
    let windowed = false
    try {
      const now = Date.now()
      let { last } = await bounds(pool, tf)
      const due = last === null || last + 2 * step <= now || now - (last + step) < RECHECK_MS
      if (!due) continue
      let written = 0
      if (last === null) {
        written += await saveClosed(pool, tf, await fetchPage(tf, PAGE, null)) // boş dilim: en yeni sayfa
      } else {
        let from = last // son kayıtlı mum da yeniden istenir (geç gelen tik düzeltmesi)
        for (;;) {
          const remaining = Math.ceil((now - from) / step) + 2
          const limit = state(tf).limit
          if (remaining <= limit) {
            written += await saveClosed(pool, tf, await fetchPage(tf, Math.max(3, remaining), null))
            break
          }
          windowed = true
          const windowEnd = from + limit * step // (from, windowEnd] aralığındaki mumlar
          written += await saveClosed(pool, tf, await fetchPage(tf, limit, windowEnd + 1))
          from = windowEnd
        }
      }
      if (written > 1) console.log(`[axi] ${tf}: ${written} mum yazıldı`)
      ;({ last } = await bounds(pool, tf))
      await markOk(pool, source, EXPECTED_EVERY[tf], last === null ? null : new Date(last))
    } catch (err) {
      if (windowed) state(tf).limit = Math.max(MIN_PAGE, Math.floor(state(tf).limit / 2))
      const msg = errText(err)
      console.error(`[axi] ${tf}: ${msg}`)
      await logRun(pool, { source, startedAt, ok: false, error: msg })
      await markFail(pool, source, EXPECTED_EVERY[tf], msg)
    }
  }
}

// Geri: tur başına en çok BACKFILL_BUDGET_MS; hata verirse o dilim bekletilir, diğerleri sürer.
export async function backfillAxi(pool: Pool) {
  const started = Date.now()
  for (const tf of BACKFILL_ORDER) {
    const st = state(tf)
    if (st.done || Date.now() < st.nextAt) continue
    const target = config.metaapi.backfillFrom - PAGE * STEP_MS[tf]
    let { first } = await bounds(pool, tf)
    if (first === null) continue // canlı tur ilk sayfayı henüz yazmadı
    try {
      while (Date.now() - started < BACKFILL_BUDGET_MS) {
        if (first <= target) {
          st.done = true
          break
        }
        const page = await fetchPage(tf, st.limit, first - 1)
        const written = await saveClosed(pool, tf, page)
        const min = page.length > 0 ? Math.min(...page.map((c) => c.t)) : null
        if (min === null || min >= first) {
          st.done = true // MetaApi'de daha eski mum yok
          console.log(`[axi] ${tf}: MetaApi geçmişi ${iso(first)} tarihinde bitiyor`)
          await logRun(pool, { source: `axi:${tf}`, startedAt: new Date(started), ok: true, rowsWritten: written, detail: { historyStart: iso(first) } })
          break
        }
        first = min
        st.failures = 0
        console.log(`[axi] ${tf}: geriye ${written} mum yazıldı, ${iso(first)} tarihine inildi`)
        await markOk(pool, 'axi:backfill', '1 hour', new Date(first))
        await new Promise((r) => setTimeout(r, config.metaapi.pagePauseMs))
      }
    } catch (err) {
      st.failures++
      st.limit = Math.max(MIN_PAGE, Math.floor(st.limit / 2))
      const waitMin = Math.min(60, config.metaapi.backfillRetryMinutes * 2 ** (st.failures - 1))
      st.nextAt = Date.now() + waitMin * 60_000
      const msg = `${tf}: ${errText(err)}; ${iso(first)} tarihine kadar inildi, ${waitMin} dk sonra ${st.limit}'lik sayfayla tekrar denenecek`
      console.error(`[axi] geriye doldurma ${msg}`)
      await logRun(pool, { source: 'axi:backfill', startedAt: new Date(started), ok: false, error: msg, detail: { tf, cursor: iso(first), limit: st.limit } })
      await markFail(pool, 'axi:backfill', '1 hour', msg)
    }
    if (Date.now() - started >= BACKFILL_BUDGET_MS) return
  }
  if (!backfillReported && TIMEFRAMES.every((tf) => state(tf).done)) {
    backfillReported = true
    console.log('[axi] geriye doldurma tamamlandı')
    await markOk(pool, 'axi:backfill', '1 hour')
  }
}

// Boşluk denetimi: son AXI_GAP_RECHECK_HOURS içinde kayıtlı seride iki mum arasında dilimden uzun aralık varsa
// (MetaApi o an mumu eksik vermiş olabilir) aralık MetaApi'den yeniden istenir; gelen mum yazılır. Pencereden
// çıkana kadar gelmeyen boşluk broker'ın gerçek boşluğu sayılır (ör. kısa bakım araları). Geriye doldurma
// sürerken çalışmaz: eski dashboard'la birlikte MetaApi'nin eşzamanlı istek sınırı aşılmasın.
export async function auditAxiGaps(pool: Pool) {
  if (!TIMEFRAMES.every((tf) => state(tf).done)) return
  const source = 'axi:gaps'
  const startedAt = new Date()
  const windowMs = config.metaapi.gapRecheckHours * 3_600_000
  let found = 0
  let filled = 0
  try {
    for (const tf of TIMEFRAMES) {
      const step = STEP_MS[tf]
      const { rows: gaps } = await pool.query<{ gap_start: Date; gap_end: Date }>(
        `SELECT gap_start, gap_end FROM (
           SELECT open_time AS gap_start, lead(open_time) OVER (ORDER BY open_time) AS gap_end
           FROM axi_candles WHERE symbol = $1 AND timeframe = $2 AND open_time >= $3
         ) g WHERE gap_end - gap_start > make_interval(secs => $4) ORDER BY gap_start`,
        [config.metaapi.symbol, tf, new Date(Date.now() - windowMs - step), step / 1000],
      )
      for (const g of gaps) {
        found++
        const missing = Math.round((g.gap_end.getTime() - g.gap_start.getTime()) / step) - 1
        await saveClosed(pool, tf, await fetchPage(tf, Math.min(PAGE, missing + 2), g.gap_end.getTime()))
        const { rows } = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM axi_candles
           WHERE symbol = $1 AND timeframe = $2 AND open_time > $3 AND open_time < $4`,
          [config.metaapi.symbol, tf, g.gap_start, g.gap_end],
        )
        const got = rows[0]?.n ?? 0
        if (got > 0) {
          filled += got
          console.log(`[axi] ${tf}: ${iso(g.gap_start.getTime())} sonrasındaki boşluğa ${got}/${missing} mum geldi`)
          await logRun(pool, {
            source,
            startedAt,
            ok: true,
            rowsWritten: got,
            detail: { tf, gapStart: iso(g.gap_start.getTime()), gapEnd: iso(g.gap_end.getTime()), missing, filled: got },
          })
        }
      }
    }
    await markOk(pool, source, '30 minutes')
    return { found, filled }
  } catch (err) {
    const msg = errText(err)
    console.error(`[axi] boşluk denetimi: ${msg}`)
    await logRun(pool, { source, startedAt, ok: false, error: msg, detail: { found, filled } })
    await markFail(pool, source, '30 minutes', msg)
    return { found, filled }
  }
}

// Sembol bilgisi (digits, point, lot adımı, kontrat büyüklüğü, swap...): değiştiğinde yeni satır. 15 dakikada bir
// çağrılır ama MetaApi'ye yalnız son başarılı okumanın üzerinden 6 saat geçtiyse gider; hata verirse 15 dakika
// sonra yeniden dener.
let specOkAt = 0
const SPEC_EVERY_MS = 6 * 3_600_000

export async function syncSpec(pool: Pool) {
  if (Date.now() - specOkAt < SPEC_EVERY_MS) return
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
    specOkAt = Date.now()
    await markOk(pool, source, '6 hours')
  } catch (err) {
    const msg = errText(err)
    console.error(`[axi] sembol bilgisi: ${msg}`)
    await logRun(pool, { source, startedAt, ok: false, error: msg })
    await markFail(pool, source, '6 hours', msg)
  }
}
