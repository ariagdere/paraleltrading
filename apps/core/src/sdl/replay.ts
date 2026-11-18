// Geçmişin yeniden oynatması (sdl_setups mode = tekrar): SDL_REPLAY_FROM'dan bu yana bütün kurulumlar, canlıdaki
// kurallarla ve araştırmadaki gibi (resmi mumlar, bias raporu üretildiği andan geçerli), benzetilen sonuçlarıyla. Saatte
// bir (xx:50) ve açılışta; satırlar baştan yazılır. Ayrıca canlı kurulumların benzetilen sonucu kendi SL/TP'leriyle.
// Lot kuralı en son sembol bilgisiyle (yoksa 0,01 lot adımı, contractSize 1); fiyat kapanış (bid) ve kapanış + spread.

import { logRun, markFail, markOk, type Pool } from '@pt/db'
import type { SdlConfig } from './config.js'
import { load4h, loadBias, loadDailyDays, loadM1, loadNews, loadSpec, loadZones } from './data.js'
import { DAY, M3, MIN, firstIndexAtOrAfter, istDay, rMultiple, scan, simExit, type Bar, type Side } from './engine.js'
import { DEFAULT_SPEC, computeSizing } from './sizing.js'
import { replaceReplay, type SetupWrite } from './store.js'

export async function replayTick(pool: Pool, cfg: SdlConfig, symbol: string): Promise<void> {
  const source = 'sdl:tekrar'
  const startedAt = new Date()
  try {
    const zones = await loadZones(pool)
    const now = Date.now()
    const cutoff = Math.floor((now - 2 * MIN) / M3) * M3 // son tamamlanmış 3m mumunun kapanışı
    const from = cfg.replayFrom
    const m1: Bar[] = (await loadM1(pool, symbol, from - DAY, cutoff)).map(({ t, o, h, l, c, sp }) => ({ t, o, h, l, c, sp }))
    let rows: SetupWrite[] = []
    if (zones.length > 0) {
      const c4 = (await load4h(pool, symbol, Math.min(...zones.map((z) => z.createdAt)) - 60 * DAY)).filter((k) => k.t + 4 * 3_600_000 <= cutoff)
      const dailyDays = await loadDailyDays(pool, symbol, from - 3 * DAY)
      const bias = await loadBias(pool, istDay(from), istDay(now))
      const news = await loadNews(pool, from - DAY, now + DAY)
      const spec = (await loadSpec(pool, symbol)) ?? DEFAULT_SPEC
      rows = scan({ m1, c4, dailyDays, zones, bias, news }).map((r): SetupWrite => {
        const { c } = r
        const base = { mode: 'tekrar' as const, c, bars: 'resmi' as const, exit: r.exit, r: r.r }
        if (!r.v.ok) return { ...base, decision: 'atla', reason: r.v.reason, detail: r.v.detail ?? null, volume: null, riskUsd: null }
        const sz = computeSizing({
          side: c.side, bid: c.close, ask: c.close + c.spread, sl: c.sl, tp: c.tp, riskUsd: cfg.riskUsd,
          minLotMaxRiskUsd: cfg.minLotMaxRiskUsd, maxVolume: cfg.maxVolume, spec,
        })
        if (sz.ok) return { ...base, decision: 'emir', reason: null, detail: sz.minLot ? { minLot: true } : null, volume: sz.volume, riskUsd: sz.riskUsd }
        return { ...base, decision: 'atla', reason: sz.code === 'lot' ? 'lot' : 'emir_hatasi', detail: { hata: sz.error }, volume: null, riskUsd: null }
      })
    }
    await replaceReplay(pool, rows)
    const updated = await updateLiveSims(pool, m1)
    await markOk(pool, source, '1 hour', new Date(cutoff - M3))
    console.log(`[sdl] tekrar: ${rows.length} kurulum, ${rows.filter((r) => r.decision === 'emir').length} işlem; canlı sonuç ${updated}`)
  } catch (err) {
    const msg = (err as Error).message ?? String(err)
    console.error(`[sdl] tekrar: ${msg}`)
    await logRun(pool, { source, startedAt, ok: false, error: msg }).catch(() => {})
    await markFail(pool, source, '1 hour', msg).catch(() => {})
  }
}

// Canlı kurulumların benzetilen sonucu (kararda kullanılan SL/TP'yle), resmi 1m mumlarıyla; açık kalanlar boş.
async function updateLiveSims(pool: Pool, m1: Bar[]): Promise<number> {
  const { rows } = await pool.query<{ id: string; entry_t: Date; side: Side; entry_ref: number; risk: number; sl: number; tp: number }>(
    `SELECT id, entry_t, side, entry_ref, risk, sl, tp FROM sdl_setups WHERE mode = 'canli' AND sim_exit_at IS NULL ORDER BY entry_t`,
  )
  let n = 0
  const first = m1[0]?.t ?? Infinity
  for (const r of rows) {
    const t = r.entry_t.getTime()
    if (t < first) continue // mumlar SDL_REPLAY_FROM'dan; daha eski kurulumun sonucu hesaplanmaz
    const ex = simExit(m1, firstIndexAtOrAfter(m1, t), r.side, r.sl, r.tp)
    if (!ex) continue
    await pool.query(`UPDATE sdl_setups SET sim_exit_at = $2, sim_exit_kind = $3, sim_r = $4, computed_at = now() WHERE id = $1`, [
      r.id, new Date(ex.t), ex.kind, rMultiple(r.side, r.entry_ref, r.risk, ex.price),
    ])
    n++
  }
  return n
}
