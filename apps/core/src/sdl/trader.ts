// Emir kapısı: dönüşüm, haber ve hafta sonu kurallarından geçen canlı kurulumun emre dönüşüp dönüşmeyeceği ve emrin
// gönderilmesi. Sıra:
//   1. Lot kuralı (stratejinin parçası, gölgede de): hedef 10 $, aşağı yuvarlı; en küçük lotta risk 20 $'ı aşarsa lot.
//   2. Railway'de SDL_TRADING_ENABLED kapalıysa gölge (golge): karar yazılır, emir gitmez.
//   3. NO TRADE düğmesi kapalıysa (no_trade).
//   4. Dönüş mumunun kapanışından 60 sn geçtiyse (gec): fiyat kaçmış olabilir.
//   5. Son 15 dakikada sonucu belirsiz emir varsa (belirsiz_emir): önce o emrin akıbeti netleşmeli.
//   6. Güncel fiyat (akış ≤ 10 sn, yoksa REST) ve sembol bilgisi; alınamazsa emir_hatasi. Lot bu fiyatla yeniden.
//   7. Kurulum ve emir niyeti tek transaction'da yazılır (status SUBMITTING), sonra emir gider. Kurulum satırı zaten
//      varsa (yeniden başlatma) hiçbir şey gönderilmez. Emir ASLA tekrar gönderilmez; belirsiz sonuçta pozisyon
//      clientId'yle aranır (hemen ve sonra dakikada bir, 24 saat boyunca).
// Emir eski sistemin hesabına magic 15033 ile gider; eski sistemin mt5_order_monitor'ü onu eski DB'nin orders
// tablosuna "SDL_v3 - Manuel Zone No Cap" etiketiyle yazar (/live). Bu servis eski DB'ye yazmaz.

import { randomBytes } from 'node:crypto'
import { logRun, markFail, markOk, type Pool } from '@pt/db'
import type { SdlConfig } from './config.js'
import type { Candidate } from './engine.js'
import { loadSpec, switchOn } from './data.js'
import { findByClientKey, restQuote, sendMarketOrder, type Quote } from './metaapi.js'
import { computeSizing, type Sizing, type Spec } from './sizing.js'
import { insertSetup, type Reason, type SetupWrite } from './store.js'
import type { PriceStream } from './stream.js'

const MAX_AGE_MS = 60_000
const UNRESOLVED_MINUTES = 15
const QUOTE_FRESH_MS = 10_000
const SUBMIT_STALE_MS = 90_000

export function newClientId(): { clientId: string; clientKey: string } {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(10)
  let key = ''
  for (const b of bytes) key += alphabet[b % alphabet.length]
  return { clientId: `PT_${key}_1`, clientKey: `PT_${key}` }
}

export class Trader {
  constructor(
    private pool: Pool,
    private cfg: SdlConfig,
    private stream: PriceStream | null,
    private symbol: string,
  ) {}

  private sizing(c: Candidate, q: { bid: number; ask: number }, spec: Spec): Sizing {
    return computeSizing({
      side: c.side,
      bid: q.bid,
      ask: q.ask,
      sl: c.sl,
      tp: c.tp,
      riskUsd: this.cfg.riskUsd,
      minLotMaxRiskUsd: this.cfg.minLotMaxRiskUsd,
      maxVolume: this.cfg.maxVolume,
      spec,
    })
  }

  private async quote(): Promise<Quote> {
    const s = this.stream?.last
    if (s && Date.now() - s.at <= QUOTE_FRESH_MS) return { bid: s.bid, ask: s.ask, t: s.t, source: 'akis' }
    if (!this.cfg.metaapiReady) throw new Error('MetaApi değişkenleri tanımlı değil')
    return restQuote(this.cfg.metaapi, this.symbol)
  }

  private async unresolved(): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM sdl_orders WHERE status IN ('SUBMITTING', 'UNKNOWN') AND created_at > now() - $1::interval`,
      [`${UNRESOLVED_MINUTES} minutes`],
    )
    return Number(rows[0]?.n ?? 0)
  }

  // Canlı kurulumun kararı ve (gerekiyorsa) emri. base: kural kararından gelen satır (emir ya da atla).
  async handle(base: SetupWrite, now = Date.now()): Promise<void> {
    if (base.decision === 'atla') {
      await insertSetup(this.pool, base)
      return
    }
    const c = base.c
    const skip = async (reason: Reason, detail: Record<string, unknown> | null = null, extra: Partial<SetupWrite> = {}) => {
      await insertSetup(this.pool, { ...base, ...extra, decision: 'atla', reason, detail })
    }

    // Lot ve risk bilgisi gölgede ve NO TRADE'de de yazılsın: eldeki fiyatla (akış yoksa kapanış ve spread).
    const spec = await loadSpec(this.pool, this.symbol).catch(() => null)
    const s = this.stream?.last
    const infoQuote = s && now - s.at <= QUOTE_FRESH_MS ? s : { bid: c.close, ask: c.close + c.spread }
    const info = spec ? this.sizing(c, infoQuote, spec) : null
    const infoExtra = info?.ok ? { volume: info.volume, riskUsd: info.riskUsd } : {}
    // Lot kuralı stratejinin parçası: gölgede de işlemi eler.
    if (info && !info.ok && info.code === 'lot') return skip('lot', { hata: info.error, enKucukLotRiski: info.minRiskUsd })

    if (!this.cfg.tradingEnabled) return skip('golge', null, infoExtra)
    if (!(await switchOn(this.pool, this.cfg.strategy))) return skip('no_trade', null, infoExtra)
    if (now - c.entryT > MAX_AGE_MS) return skip('gec', { gecikmeSn: Math.round((now - c.entryT) / 1000) }, infoExtra)
    if ((await this.unresolved()) > 0) return skip('belirsiz_emir', null, infoExtra)
    if (!this.cfg.metaapiReady) return skip('emir_hatasi', { hata: 'MetaApi değişkenleri tanımlı değil' }, infoExtra)
    if (!spec) return skip('emir_hatasi', { hata: 'Sembol bilgisi yok (axi_symbol_spec)' }, infoExtra)

    let q: Quote
    try {
      q = await this.quote()
    } catch (err) {
      return skip('emir_hatasi', { hata: (err as Error).message }, infoExtra)
    }
    const sz = this.sizing(c, q, spec)
    if (!sz.ok) {
      if (sz.code === 'lot') return skip('lot', { hata: sz.error, enKucukLotRiski: sz.minRiskUsd })
      return skip('emir_hatasi', { hata: sz.error, bid: q.bid, ask: q.ask })
    }

    // Kurulum ve emir niyeti birlikte; kurulum zaten yazılmışsa (yeniden başlatma) emir gitmez.
    const { clientId, clientKey } = newClientId()
    const client = await this.pool.connect()
    let orderId: number | null = null
    try {
      await client.query('BEGIN')
      const setupId = await insertSetup(client, { ...base, volume: sz.volume, riskUsd: sz.riskUsd, detail: { fiyat: q.source, minLot: sz.minLot } })
      if (setupId === null) {
        await client.query('ROLLBACK')
        return
      }
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO sdl_orders (setup_id, client_id, client_key, magic, status, side, volume, risk_target_usd, risk_usd, sl, tp, bid, ask, quote_at, submitted_at)
         VALUES ($1, $2, $3, $4, 'SUBMITTING', $5, $6, $7, $8, $9, $10, $11, $12, $13, now()) RETURNING id`,
        [setupId, clientId, clientKey, this.cfg.magic, c.side, sz.volume, this.cfg.riskUsd, sz.riskUsd, c.sl, c.tp, q.bid, q.ask, new Date(q.t)],
      )
      orderId = Number(rows[0]!.id)
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }

    const sentAt = new Date()
    const out = await sendMarketOrder(this.cfg.metaapi, {
      symbol: this.symbol, side: c.side, volume: sz.volume, sl: round2(c.sl), tp: round2(c.tp), clientId, magic: this.cfg.magic,
    })
    const startedAt = new Date()
    if (out.kind === 'executed') {
      await this.pool.query(
        `UPDATE sdl_orders SET status = 'FILLED', mt5_order_id = $2, mt5_position_id = $3, trade_code = $4, trade_message = $5,
           completed_at = now(), updated_at = now() WHERE id = $1`,
        [orderId, out.orderId, out.positionId, out.code, out.message || null],
      )
      console.log(`[sdl] emir: ${c.side} ${sz.volume} lot, SL ${round2(c.sl)}, TP ${round2(c.tp)}, pozisyon ${out.positionId ?? '?'} (${out.code})`)
      await markOk(this.pool, 'sdl:emir', '1 day')
      await this.fillPrice(orderId, clientKey, sentAt)
    } else if (out.kind === 'rejected') {
      await this.pool.query(
        `UPDATE sdl_orders SET status = 'REJECTED', trade_code = $2, trade_message = $3, completed_at = now(), updated_at = now() WHERE id = $1`,
        [orderId, out.code, out.message || null],
      )
      const msg = `emir reddedildi: ${out.code}${out.message ? ` (${out.message})` : ''}`
      console.error(`[sdl] ${msg}`)
      await markFail(this.pool, 'sdl:emir', '1 day', msg)
      await logRun(this.pool, { source: 'sdl:emir', startedAt, ok: false, error: msg })
    } else {
      await this.pool.query(`UPDATE sdl_orders SET status = 'UNKNOWN', error = $2, updated_at = now() WHERE id = $1`, [orderId, out.message])
      const msg = `emrin sonucu belirsiz: ${out.message}`
      console.error(`[sdl] ${msg}`)
      await markFail(this.pool, 'sdl:emir', '1 day', msg)
      await logRun(this.pool, { source: 'sdl:emir', startedAt, ok: false, error: msg })
      await new Promise((r) => setTimeout(r, 3_000))
      await this.resolveOne(orderId, clientKey, sentAt)
    }
  }

  // Dolum fiyatı (açık pozisyondan ya da açılış deal'inden); bulunamazsa boş kalır (eski sistemin kaydında var).
  private async fillPrice(orderId: number, clientKey: string, since: Date) {
    try {
      const f = await findByClientKey(this.cfg.metaapi, clientKey, since)
      if (f) {
        await this.pool.query(
          `UPDATE sdl_orders SET fill_price = $2, mt5_position_id = coalesce(mt5_position_id, $3), updated_at = now() WHERE id = $1`,
          [orderId, f.price, f.positionId],
        )
      }
    } catch (err) {
      console.warn(`[sdl] dolum fiyatı okunamadı: ${(err as Error).message}`)
    }
  }

  private async resolveOne(orderId: number, clientKey: string, since: Date): Promise<boolean> {
    try {
      const f = await findByClientKey(this.cfg.metaapi, clientKey, since)
      if (!f) return false
      await this.pool.query(
        `UPDATE sdl_orders SET status = 'FILLED', mt5_position_id = $2, mt5_order_id = coalesce(mt5_order_id, $3), fill_price = $4,
           completed_at = now(), updated_at = now(), error = coalesce(error, '') || ' — pozisyon sonradan bulundu' WHERE id = $1`,
        [orderId, f.positionId, f.orderId, f.price],
      )
      console.log(`[sdl] belirsiz emir bulundu: pozisyon ${f.positionId}`)
      return true
    } catch (err) {
      console.warn(`[sdl] belirsiz emir aranamadı: ${(err as Error).message}`)
      return false
    }
  }

  // Dakikada bir: yarım kalan (SUBMITTING, 90 sn'den eski) ve belirsiz emirlerin pozisyonunu ara (24 saat).
  async resolvePending(): Promise<void> {
    if (!this.cfg.metaapiReady) return
    const { rows } = await this.pool.query<{ id: string; client_key: string; status: string; submitted_at: Date | null; created_at: Date }>(
      `SELECT id, client_key, status, submitted_at, created_at FROM sdl_orders
       WHERE (status = 'UNKNOWN' OR (status = 'SUBMITTING' AND created_at < now() - $1::interval))
         AND created_at > now() - interval '1 day' ORDER BY id`,
      [`${SUBMIT_STALE_MS / 1000} seconds`],
    )
    for (const r of rows) {
      if (r.status === 'SUBMITTING') {
        await this.pool.query(
          `UPDATE sdl_orders SET status = 'UNKNOWN', error = 'gönderim yarım kaldı (servis yeniden başladı ya da yanıt yazılamadı)', updated_at = now() WHERE id = $1 AND status = 'SUBMITTING'`,
          [r.id],
        )
      }
      await this.resolveOne(Number(r.id), r.client_key, r.submitted_at ?? r.created_at)
    }
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100
