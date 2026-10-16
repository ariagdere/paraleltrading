import { gunzipSync } from 'node:zlib'
import { logRun, markFail, markOk, type Pool } from '@pt/db'
import { BANDS, computeLevels, TOP, type Cluster } from './levels.js'
import { SYMBOL } from './sync.js'

// Heatmap seviyeleri: seviyesi hesaplanmamış her snapshot için cluster'lar, bant likiditesi ve baz (heatmap_levels).
// Snapshot değişmediği için bir kez hesaplanır. Yalnız baz o anki Axi 1m mumuna bağlı: mum o an yoksa (henüz
// gelmemiş ya da boşluk denetimiyle sonradan gelecek) son bir gündeki satırlarda baz her dakika yeniden aranır.

const BATCH = 50
const BASIS_RETRY = '1 day'

// Snapshot'ın anına (update_time, yoksa received_at) kadar kapanmış son Axi 1m mumu; son 5 dakikada yoksa yok.
const AXI_AT = `(SELECT c.close FROM axi_candles c
   WHERE c.symbol = $1 AND c.timeframe = '1m'
     AND c.open_time <= coalesce(s.update_time, s.received_at) - interval '1 minute'
     AND c.open_time > coalesce(s.update_time, s.received_at) - interval '6 minutes'
   ORDER BY c.open_time DESC LIMIT 1)`

type SnapshotRow = { id: string; span: string; received_at: Date; axi: number | null; payload_gz: Buffer }

const cluster = (list: Cluster[], i: number) => [list[i]?.price ?? null, list[i]?.usd ?? null]

export async function syncHeatmapLevels(pool: Pool) {
  const source = 'core:heatmap'
  const startedAt = new Date()
  let done = 0
  let last: Date | null = null
  try {
    for (;;) {
      const { rows } = await pool.query<SnapshotRow>(
        `SELECT s.id, s.span, s.received_at, ${AXI_AT} AS axi, s.payload_gz
         FROM heatmap_snapshots s
         WHERE NOT EXISTS (SELECT 1 FROM heatmap_levels l WHERE l.snapshot_id = s.id)
         ORDER BY s.id
         LIMIT $2`,
        [SYMBOL, BATCH],
      )
      if (rows.length === 0) break
      for (const r of rows) {
        let lv: ReturnType<typeof computeLevels> = null
        try {
          lv = computeLevels(JSON.parse(gunzipSync(r.payload_gz).toString()))
        } catch {
          lv = null // açılmayan ya da bozuk çıktı: boş satır yazılır, yeniden denenmez
        }
        if (!lv) console.warn(`[core] heatmap ${r.id} (${r.span}): seviye çıkmadı (boş ya da beklenmeyen çıktı)`)
        const values = lv
          ? [
              lv.ref,
              r.axi,
              r.axi === null ? null : lv.ref - r.axi,
              ...Array.from({ length: TOP }, (_, i) => cluster(lv!.up, i)).flat(),
              ...Array.from({ length: TOP }, (_, i) => cluster(lv!.dn, i)).flat(),
              ...lv.upLiq,
              ...lv.dnLiq,
            ]
          : new Array(3 + 4 * TOP + 2 * BANDS.length).fill(null)
        await pool.query(
          `INSERT INTO heatmap_levels (snapshot_id, span, received_at, ref_price, axi_price, basis,
             up1_price, up1_usd, up2_price, up2_usd, up3_price, up3_usd,
             dn1_price, dn1_usd, dn2_price, dn2_usd, dn3_price, dn3_usd,
             up_liq_1pct, up_liq_2pct, up_liq_3pct, dn_liq_1pct, dn_liq_2pct, dn_liq_3pct)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                   $19, $20, $21, $22, $23, $24)
           ON CONFLICT (snapshot_id) DO NOTHING`,
          [r.id, r.span, r.received_at, ...values],
        )
        done++
        if (!last || r.received_at > last) last = r.received_at
      }
    }

    // Bazı eksik kalan son bir günün satırları: Axi mumu sonradan geldiyse doldur.
    const filled = await pool.query(
      `UPDATE heatmap_levels l SET axi_price = a.close, basis = l.ref_price - a.close, computed_at = now()
       FROM heatmap_snapshots s, LATERAL (SELECT ${AXI_AT} AS close) a
       WHERE s.id = l.snapshot_id AND l.ref_price IS NOT NULL AND l.axi_price IS NULL
         AND s.received_at > now() - $2::interval AND a.close IS NOT NULL`,
      [SYMBOL, BASIS_RETRY],
    )

    if (done > 1) console.log(`[core] heatmap: ${done} snapshot hesaplandı`)
    if ((filled.rowCount ?? 0) > 0) console.log(`[core] heatmap: ${filled.rowCount} snapshot'ın bazı sonradan gelen Axi mumuyla dolduruldu`)
    if (done > 0) await markOk(pool, source, '1 hour', last)
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[core] heatmap: ${msg}`)
    await logRun(pool, { source, startedAt, ok: false, error: msg, detail: { done } })
    await markFail(pool, source, '1 hour', msg)
  }
}
