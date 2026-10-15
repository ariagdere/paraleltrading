import { logRun, markFail, markOk, type Pool } from '@pt/db'
import { computeSeries } from './indicators.js'

// Axi göstergeleri: 15m, 1h, 4h, 1d. Her turda dilim başına önce göstergesi olmayan ya da hesaptan sonra
// düzeltilmiş ilk mum aranır (yeni mum, collector'ın düzelttiği son mum, boşluk denetiminin araya eklediği mum).
// Varsa o mumdan sonuna kadar yeniden hesaplanır: RSI ve ATR serinin başından yürüdüğü için bütün seri okunur
// (dilim başına birkaç bin mum), yalnız değişen satırlar yazılır. Değişen bir şey yoksa tur tek sorgudur.

export const SYMBOL = process.env.AXI_SYMBOL || 'BTCUSD'
export const TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const
export type Timeframe = (typeof TIMEFRAMES)[number]
const EXPECTED_EVERY: Record<Timeframe, string> = {
  '15m': '15 minutes',
  '1h': '1 hour',
  '4h': '4 hours',
  '1d': '1 day',
}
const BATCH = 1000

type CandleRow = { t: string; high: number; low: number; close: number; su: string }

export async function syncIndicators(pool: Pool) {
  for (const tf of TIMEFRAMES) {
    const source = `core:${tf}`
    const startedAt = new Date()
    try {
      const { rows: dirty } = await pool.query<{ first_dirty: Date | null }>(
        `SELECT min(c.open_time) AS first_dirty
         FROM axi_candles c
         LEFT JOIN axi_indicators i ON i.symbol = c.symbol AND i.timeframe = c.timeframe AND i.open_time = c.open_time
         WHERE c.symbol = $1 AND c.timeframe = $2
           AND (i.open_time IS NULL OR i.src_updated_at IS DISTINCT FROM c.updated_at)`,
        [SYMBOL, tf],
      )
      const firstDirty = dirty[0]?.first_dirty?.getTime()
      if (firstDirty === undefined) continue

      // updated_at metin olarak okunup aynen geri yazılır (mikrosaniye hassasiyeti JS Date'te kaybolur).
      const { rows: candles } = await pool.query<CandleRow>(
        `SELECT (extract(epoch FROM open_time) * 1000)::bigint::text AS t, high, low, close, updated_at::text AS su
         FROM axi_candles WHERE symbol = $1 AND timeframe = $2 ORDER BY open_time`,
        [SYMBOL, tf],
      )
      const from = candles.findIndex((c) => Number(c.t) >= firstDirty)
      if (from < 0) continue // mum bu arada silinmiş
      const rows = computeSeries(candles, from)

      let written = 0
      for (let i = 0; i < rows.length; i += BATCH) {
        const part = rows.slice(i, i + BATCH)
        const src = candles.slice(from + i, from + i + part.length)
        const res = await pool.query(
          `INSERT INTO axi_indicators
             (symbol, timeframe, open_time, zlema_fast, zlema_slow, zlema_zone, rsi14, atr14, src_updated_at)
           SELECT $1, $2, to_timestamp(u.t / 1000.0), u.zf, u.zs, u.zz, u.rsi, u.atr, u.su::timestamptz
           FROM unnest($3::bigint[], $4::float8[], $5::float8[], $6::text[], $7::float8[], $8::float8[], $9::text[])
             AS u(t, zf, zs, zz, rsi, atr, su)
           ON CONFLICT (symbol, timeframe, open_time) DO UPDATE SET
             zlema_fast = EXCLUDED.zlema_fast, zlema_slow = EXCLUDED.zlema_slow, zlema_zone = EXCLUDED.zlema_zone,
             rsi14 = EXCLUDED.rsi14, atr14 = EXCLUDED.atr14, src_updated_at = EXCLUDED.src_updated_at,
             computed_at = now()
           WHERE (axi_indicators.zlema_fast, axi_indicators.zlema_slow, axi_indicators.zlema_zone,
                  axi_indicators.rsi14, axi_indicators.atr14, axi_indicators.src_updated_at)
             IS DISTINCT FROM (EXCLUDED.zlema_fast, EXCLUDED.zlema_slow, EXCLUDED.zlema_zone,
                  EXCLUDED.rsi14, EXCLUDED.atr14, EXCLUDED.src_updated_at)`,
          [
            SYMBOL,
            tf,
            src.map((c) => c.t),
            part.map((r) => r.zlemaFast),
            part.map((r) => r.zlemaSlow),
            part.map((r) => r.zone),
            part.map((r) => r.rsi),
            part.map((r) => r.atr),
            src.map((c) => c.su),
          ],
        )
        written += res.rowCount ?? 0
      }
      if (rows.length > 1) console.log(`[core] ${tf}: ${rows.length} mum hesaplandı, ${written} satır yazıldı`)
      const last = new Date(Number(candles[candles.length - 1]!.t))
      await markOk(pool, source, EXPECTED_EVERY[tf], last)
    } catch (err) {
      const msg = (err as Error).message
      console.error(`[core] ${tf}: ${msg}`)
      await logRun(pool, { source, startedAt, ok: false, error: msg })
      await markFail(pool, source, EXPECTED_EVERY[tf], msg)
    }
  }
}
