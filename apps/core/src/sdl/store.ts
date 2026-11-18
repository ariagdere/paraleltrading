// sdl_setups satırları: canlı kararlar ve geçmişin yeniden oynatması aynı biçimde.

import type { Pool, PoolClient } from 'pg'
import type { Candidate, Exit, Pending } from './engine.js'

export type Reason = 'hafta_sonu' | 'donusum' | 'haber' | 'lot' | 'golge' | 'no_trade' | 'gec' | 'belirsiz_emir' | 'emir_hatasi'

export type SetupWrite = {
  mode: 'canli' | 'tekrar'
  c: Candidate
  decision: 'emir' | 'atla'
  reason: Reason | null
  detail: Record<string, unknown> | null
  bars: 'akis' | 'resmi' | null
  volume: number | null
  riskUsd: number | null
  exit: Exit | null
  r: number | null
}

const COLUMNS = [
  'mode', 'entry_t', 'side', 'day', 'entry_candle', 'zone_id', 'tp_zone_id', 'entry_in_zone', 'bias_at', 'fvg_a', 'fvg_i',
  'gap', 'fvg_lo', 'fvg_hi', 'ext', 'ext_t', 'close', 'spread', 'entry_ref', 'sl', 'tp', 'risk', 'rr', 'decision',
  'reason', 'detail', 'bars', 'volume', 'risk_usd', 'sim_exit_at', 'sim_exit_kind', 'sim_r',
] as const

export function values(w: SetupWrite): unknown[] {
  const { c } = w
  return [
    w.mode, new Date(c.entryT), c.side, c.day, new Date(c.entryCandle), c.zone.id, c.tpZone.id, c.entryInZone, new Date(c.biasAt),
    new Date(c.fvgA), new Date(c.fvgI), c.gap, c.fvgLo, c.fvgHi, c.ext, new Date(c.extT), c.close, c.spread, c.entry, c.sl, c.tp,
    c.risk, c.rr, w.decision, w.reason, w.detail ? JSON.stringify(w.detail) : null, w.bars, w.volume, w.riskUsd,
    w.exit ? new Date(w.exit.t) : null, w.exit?.kind ?? null, w.r,
  ]
}

const placeholders = (row: number) => `(${COLUMNS.map((_, i) => `$${row * COLUMNS.length + i + 1}`).join(', ')})`

// Satırı yazar; aynı kurulum (mod, giriş anı, yön) zaten varsa dokunmaz ve null döner.
export async function insertSetup(db: Pool | PoolClient, w: SetupWrite): Promise<number | null> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sdl_setups (${COLUMNS.join(', ')}) VALUES ${placeholders(0)} ON CONFLICT (mode, entry_t, side) DO NOTHING RETURNING id`,
    values(w),
  )
  return rows[0] ? Number(rows[0].id) : null
}

// Sırada bekleyen kurulumlar (sdl_pending): her 3m kapanışında baştan yazılır; durum sdl_status.pending_*'da.
export type PendingWrite = { p: Pending; volume: number | null; riskUsd: number | null; lotError: string | null }

export type PendingInfo = {
  // liste: hesaplandı (boş olabilir); öbürleri listenin neden hesaplanmadığı
  durum: 'liste' | 'hafta_sonu' | 'kapali' | 'bias_yok' | 'notr' | 'zon_yok' | 'gun_mumu_yok'
  bias: string | null
  close: number | null // son 3m kapanışı (bid)
  pencere: boolean // sonraki kapanış 07:00–20:00 içinde
  haber: { from: number; to: number; at: number[] } | null // sonraki kapanışı kapsayan ya da 20:00'den önce başlayan ilk haber engeli
}

const PENDING_COLUMNS = [
  'side', 'fvg_a', 'day', 'status', 'fvg_i', 'gap', 'fvg_lo', 'fvg_hi', 'trigger', 'ext', 'ext_t', 'zone_id', 'tp_zone_id',
  'entry', 'sl', 'tp', 'risk', 'rr', 'volume', 'risk_usd', 'lot_error', 'expires_at', 'as_of',
] as const

export async function replacePending(pool: Pool, asOf: number, info: PendingInfo, ws: PendingWrite[]): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM sdl_pending')
    if (ws.length > 0) {
      const n = PENDING_COLUMNS.length
      await client.query(
        `INSERT INTO sdl_pending (${PENDING_COLUMNS.join(', ')}) VALUES ${ws.map((_, k) => `(${PENDING_COLUMNS.map((_, i) => `$${k * n + i + 1}`).join(', ')})`).join(', ')}`,
        ws.flatMap(({ p, volume, riskUsd, lotError }) => [
          p.side, new Date(p.fvgA), p.day, p.status, new Date(p.fvgI), p.gap, p.fvgLo, p.fvgHi, p.trigger, p.ext, new Date(p.extT), p.zone.id,
          p.tpZone.id, p.entry, p.sl, p.tp, p.risk, p.rr, volume, riskUsd, lotError, new Date(p.expiresAt), new Date(asOf),
        ]),
      )
    }
    await client.query('UPDATE sdl_status SET pending_as_of = $1, pending_info = $2 WHERE id = 1', [new Date(asOf), JSON.stringify(info)])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// Tekrar satırlarını baştan yazar (tek transaction). Tekrar satırlarına emir bağlanmaz.
export async function replaceReplay(pool: Pool, ws: SetupWrite[]): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`DELETE FROM sdl_setups WHERE mode = 'tekrar'`)
    for (let i = 0; i < ws.length; i += 200) {
      const chunk = ws.slice(i, i + 200)
      await client.query(
        `INSERT INTO sdl_setups (${COLUMNS.join(', ')}) VALUES ${chunk.map((_, k) => placeholders(k)).join(', ')}`,
        chunk.flatMap(values),
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
