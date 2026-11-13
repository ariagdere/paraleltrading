import type { Pool } from '@pt/db'
import { config } from './config.js'

// Tek seferlik onarım (Kasım 2026). MetaApi'nin zamanları 1 Kasım'da Axi'nin kış saatine geçmesinden beri bir saat
// erkendi: mumlar bir saat önceki etiketle yazıldı, geçişten sonraki ilk saat bir önceki gerçek saatin üstüne yazıldı,
// oluşan mum kapanmış sayıldı. 1 Kasım 00:00'dan (İstanbul) beri yazılan Axi mumları ve göstergeleri silinir, o andan
// sonraki heatmap bazları boşaltılır. Canlı tur mumları doğru saatle yeniden çeker; core göstergeleri, bazları,
// destek/direnç bölgelerini ve naif kararları kendiliğinden yeniden hesaplar. collector_runs'ta başarılı kaydı varsa
// bir daha çalışmaz.

const SOURCE = 'axi:onarim-2026-11'
const FROM = new Date('2026-10-31T21:00:00Z')

export async function repairAxiShift(pool: Pool): Promise<void> {
  const done = await pool.query('SELECT 1 FROM collector_runs WHERE source = $1 AND ok LIMIT 1', [SOURCE])
  if ((done.rowCount ?? 0) > 0) return
  const startedAt = new Date()
  const symbol = config.metaapi.symbol
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<{ timeframe: string; n: number }>(
      `WITH d AS (DELETE FROM axi_candles WHERE symbol = $1 AND open_time >= $2 RETURNING timeframe)
       SELECT timeframe, count(*)::int AS n FROM d GROUP BY timeframe ORDER BY timeframe`,
      [symbol, FROM],
    )
    const indicators = await client.query('DELETE FROM axi_indicators WHERE symbol = $1 AND open_time >= $2', [symbol, FROM])
    const bases = await client.query(
      `UPDATE heatmap_levels l SET axi_price = NULL, basis = NULL, computed_at = now()
       FROM heatmap_snapshots s
       WHERE s.id = l.snapshot_id AND l.axi_price IS NOT NULL AND coalesce(s.update_time, s.received_at) >= $1`,
      [FROM],
    )
    const candles = Object.fromEntries(rows.map((r) => [r.timeframe, r.n]))
    const total = rows.reduce((a, r) => a + r.n, 0)
    const detail = { from: FROM.toISOString(), candles, indicators: indicators.rowCount ?? 0, bases: bases.rowCount ?? 0 }
    await client.query(
      `INSERT INTO collector_runs (source, started_at, finished_at, ok, rows_written, detail) VALUES ($1, $2, now(), true, $3, $4)`,
      [SOURCE, startedAt, total, JSON.stringify(detail)],
    )
    await client.query('COMMIT')
    console.log(
      `[axi] saat onarımı: ${FROM.toISOString()} sonrasındaki ${total} mum (${rows.map((r) => `${r.timeframe} ${r.n}`).join(', ')}), ` +
        `${detail.indicators} gösterge satırı silindi, ${detail.bases} heatmap bazı boşaltıldı; mumlar doğru saatle yeniden çekilecek`,
    )
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}
