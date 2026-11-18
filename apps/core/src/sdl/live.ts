// Canlı karar: her 3m kapanışında (yarım saniyede bir bakılır) günün 3m mumları kurulur ve son mumda kurulum aranır.
// 1m mumları: son iki dakika fiyat akışından (dakika sınırında kapanır; resmi mumun ilk hali o an ya yok ya eksik),
// öncekiler collector'ın resmi mumlarından (axi_candles; akışta olup resmide olmayan dakika akıştan). Akış yoksa ya da
// bayatsa hepsi resmi mumlardan: o zaman karar collector'ın turunu bekler (kapanıştan ~5–15 sn sonra).
// Kapanan mumun son dakikası 60 sn içinde hiçbir kaynaktan gelmezse o kapanış atlanır (sağlık sayfasında hata).
// Hafta sonu ve pencere dışında (07:00–20:00 İstanbul) ya da günün bias'ı LONG/SHORT değilse veritabanına bakılmaz.
// Dönüşüm şartı için 4h mumları resmi; son kapanan 4h mumu kapanışından 5 dk geçmediyse 1m'lerden kurulur (resmi
// mum kapanıştan sonra bir kez daha çekiliyor, ilk hali eksik olabilir).

import { axiOpen } from '@pt/db/axitime'
import { logRun, markFail, markOk, type Pool } from '@pt/db'
import type { SdlConfig } from './config.js'
import { load4h, loadBias, loadDailyDays, loadM1, loadNews, loadZones } from './data.js'
import {
  DAY, H, H4, M3, MIN, SDL, build3, candidateAt, istDay, istDayStart, istWeekday, prevDay, verdict, wilderAtr, zoneBreaks,
  type Bar, type Bar4, type Zone,
} from './engine.js'
import type { SetupWrite } from './store.js'
import type { PriceStream } from './stream.js'
import type { Trader } from './trader.js'

const START_GRACE_MS = 1_000 // akış dakikanın mumunu en geç 1,5 sn'de kapatır; ondan önce resmi mum zaten yok
const GIVE_UP_MS = 60_000
const RETRY_MS = 2_000
const ZONES_TTL_MS = 60_000
const ATR_WARMUP_MS = 60 * DAY

const hhmm = (t: number) => new Date(t + 3 * H).toISOString().slice(11, 16)

export class SdlLive {
  private lastT: number
  private nextTry = 0
  private timer: NodeJS.Timeout | undefined
  private resolver: NodeJS.Timeout | undefined
  private running: Promise<void> | null = null
  private zonesCache: { at: number; list: Zone[] } | null = null

  constructor(
    private pool: Pool,
    private cfg: SdlConfig,
    private stream: PriceStream | null,
    private trader: Trader,
    private symbol: string,
  ) {
    // Açılıştan önceki son kapanış hâlâ 60 sn içindeyse değerlendirilir (aynı kurulum iki kez yazılmaz).
    this.lastT = Math.floor(Date.now() / M3) * M3 - M3
  }

  start() {
    this.timer = setInterval(() => this.tick(), 500)
    this.resolver = setInterval(() => {
      this.trader.resolvePending().catch((err) => console.error(`[sdl] belirsiz emir taraması: ${(err as Error).message}`))
    }, 60_000)
  }

  stop() {
    clearInterval(this.timer)
    clearInterval(this.resolver)
  }

  idle(): Promise<void> {
    return this.running ?? Promise.resolve()
  }

  private tick() {
    if (this.running) return
    const now = Date.now()
    const T = Math.floor(now / M3) * M3
    if (T <= this.lastT || now < T + START_GRACE_MS || now < this.nextTry) return
    if (now - T > GIVE_UP_MS) {
      this.lastT = T // çok geç: bu kapanış kaçtı (ör. servis yeni açıldı)
      return
    }
    this.running = this.evaluate(T, now)
      .then((done) => {
        if (done) this.lastT = T
        else this.nextTry = Date.now() + 1_000 // veri bekleniyor: saniyede bir bak
      })
      .catch(async (err) => {
        const msg = (err as Error).message ?? String(err)
        console.error(`[sdl] ${hhmm(T)} kapanışı: ${msg}`)
        this.nextTry = Date.now() + RETRY_MS
        await markFail(this.pool, 'sdl:karar', '3 minutes', msg).catch(() => {})
        await logRun(this.pool, { source: 'sdl:karar', startedAt: new Date(now), ok: false, error: msg }).catch(() => {})
      })
      .finally(() => {
        this.running = null
      })
  }

  private readonly startedAt = new Date()

  private async ok(T: number) {
    await markOk(this.pool, 'sdl:karar', '3 minutes', new Date(T - M3))
    const s = this.stream
    await this.pool.query(
      `INSERT INTO sdl_status (id, trading_enabled, magic, risk_usd, min_lot_max_risk_usd, stream_state, stream_error, last_quote_at, late_quotes, started_at, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (id) DO UPDATE SET trading_enabled = EXCLUDED.trading_enabled, magic = EXCLUDED.magic, risk_usd = EXCLUDED.risk_usd,
         min_lot_max_risk_usd = EXCLUDED.min_lot_max_risk_usd, stream_state = EXCLUDED.stream_state, stream_error = EXCLUDED.stream_error,
         last_quote_at = EXCLUDED.last_quote_at, late_quotes = EXCLUDED.late_quotes, started_at = EXCLUDED.started_at, updated_at = now()`,
      [
        this.cfg.tradingEnabled, this.cfg.magic, this.cfg.riskUsd, this.cfg.minLotMaxRiskUsd, s ? s.state : 'off', s?.error ?? null,
        s?.last ? new Date(s.last.at) : null, s?.lateQuotes ?? 0, this.startedAt,
      ],
    )
  }

  private async zones(): Promise<Zone[]> {
    if (!this.zonesCache || Date.now() - this.zonesCache.at > ZONES_TTL_MS) this.zonesCache = { at: Date.now(), list: await loadZones(this.pool) }
    return this.zonesCache.list
  }

  // true: bu kapanış bitti (karar verildi ya da yapılacak bir şey yok); false: veri bekleniyor.
  private async evaluate(T: number, now: number): Promise<boolean> {
    const wall0 = Date.now()
    const day = istDay(T - M3)
    const D0 = istDayStart(day)
    if (T < D0 + SDL.winFrom * H || T > D0 + SDL.winTo * H || istWeekday(T) >= 6) {
      await this.ok(T)
      return true
    }
    const reps = (await loadBias(this.pool, day, day)).get(day) ?? []
    const last = reps.filter((r) => r.at <= T).at(-1)
    if (!last || (last.bias !== 'LONG' && last.bias !== 'SHORT')) {
      await this.ok(T)
      return true
    }

    const byT = new Map<number, Bar>()
    for (const b of await loadM1(this.pool, this.symbol, D0, T)) byT.set(b.t, b)
    let fromStream = false
    if (this.stream?.healthy(now)) {
      for (const [t, b] of this.stream.bars(T - 2 * MIN, T)) {
        byT.set(t, b)
        fromStream = true
      }
      for (const [t, b] of this.stream.bars(D0, T - 2 * MIN)) if (!byT.has(t)) byT.set(t, b)
    }
    if (!byT.has(T - MIN)) {
      if (now < T + GIVE_UP_MS) return false
      throw new Error(`${hhmm(T)} kapanışının son 1m mumu 60 sn içinde gelmedi (akış ${this.stream?.state ?? 'yok'})`)
    }

    const c3 = build3([...byT.values()].sort((a, b) => a.t - b.t))
    const j = c3.length - 1
    if (j < 2 || c3[j]!.t !== T - M3) {
      await this.ok(T)
      return true
    }
    const zones = await this.zones()
    if (zones.length === 0) {
      await this.ok(T)
      return true
    }
    // Araştırmadaki gibi: önceki günün günlük mumu yoksa gün taranmaz.
    if (!(await loadDailyDays(this.pool, this.symbol, D0 - 3 * DAY)).has(prevDay(day))) {
      await this.ok(T)
      return true
    }
    const c = candidateAt({ day, c3, zones, bias: reps }, j)
    if (!c) {
      await this.ok(T)
      return true
    }

    const c4 = await this.fourHours(T, zones, now)
    const atr = wilderAtr(c4)
    const breaks = new Map(zones.map((z) => [z.id, zoneBreaks(z, c4, atr, T)]))
    const news = await loadNews(this.pool, T - DAY, T + DAY)
    const v = verdict(c, breaks, news)
    const base: SetupWrite = {
      mode: 'canli',
      c,
      decision: v.ok ? 'emir' : 'atla',
      reason: v.ok ? null : v.reason,
      detail: v.ok ? null : (v.detail ?? null),
      bars: fromStream ? 'akis' : 'resmi',
      volume: null,
      riskUsd: null,
      exit: null,
      r: null,
    }
    console.log(
      `[sdl] kurulum ${hhmm(T)} ${c.side} #${c.zone.id} → #${c.tpZone.id}, giriş ${c.entry.toFixed(2)}, SL ${c.sl.toFixed(2)}, TP ${c.tp.toFixed(2)}: ${v.ok ? 'kurallardan geçti' : v.reason}`,
    )
    await this.trader.handle(base, now + (Date.now() - wall0)) // veri okumalarının süresi de gecikmeye sayılır
    await this.ok(T)
    return true
  }

  // 4h mumları (ATR ısınması için zonlardan 60 gün önceden); son kapanan mum kapanışından 5 dk geçmediyse 1m'lerden.
  private async fourHours(T: number, zones: Zone[], now: number): Promise<Bar4[]> {
    const from = Math.min(...zones.map((z) => z.createdAt)) - ATR_WARMUP_MS
    const list: Bar4[] = (await load4h(this.pool, this.symbol, from)).map(({ t, o, h, l, c }) => ({ t, o, h, l, c }))
    const closeT = axiOpen(T, H4) // T'yi içeren 4h mumunun açılışı = son kapanan mumun kapanışı
    if (T - closeT >= 5 * MIN) return list
    const openT = axiOpen(closeT - 1, H4)
    const mm = new Map<number, Bar>()
    for (const b of await loadM1(this.pool, this.symbol, openT, closeT)) mm.set(b.t, b)
    if (this.stream?.healthy(now)) for (const [t, b] of this.stream.bars(closeT - 2 * MIN, closeT)) mm.set(t, b)
    const bars = [...mm.values()].sort((a, b) => a.t - b.t)
    if (bars.length === 0) return list
    const k = list.findIndex((x) => x.t === openT)
    const rebuilt: Bar4 = {
      t: openT,
      o: k >= 0 ? list[k]!.o : bars[0]!.o,
      h: Math.max(...bars.map((b) => b.h)),
      l: Math.min(...bars.map((b) => b.l)),
      c: bars.at(-1)!.c,
    }
    if (k >= 0) list[k] = rebuilt
    else if (list.length === 0 || list.at(-1)!.t < openT) list.push(rebuilt)
    return list
  }
}
