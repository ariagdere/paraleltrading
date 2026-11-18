// MetaApi fiyat akışı: hesaba tek, uzun ömürlü streaming bağlantısı, yalnız BTCUSD quote'ları (web'deki canlı fiyatın
// aynısı, apps/web/lib/live.ts). Quote'lardan 1m mum kurulur: fiyatlar bid, spread dakikadaki en büyük (point). Dakika
// dolunca mum kapanır: sonraki dakikanın ilk quote'u gelince ya da sınırdan 1,5 sn sonra (sakin piyasada). Kapanan mum
// değişmez; sonra gelen eski quote'lar sayılır ama mumu değiştirmez. Bağlantı (yeniden) kurulduktan sonraki ilk mum
// dakikanın ortasından başladığı için atılır.
// - Hesabı deploy/undeploy etmez (yaşam döngüsü eski sistemin monitör servisinde; her başlatma en az 6 saat
//   faturalanıyor). Hesap deploy'lu değilse hata verir; 30 sn sonra yeniden dener.
// - Streaming REST/RPC kredisi tüketmez. MetaApi'de mum aboneliği eski sistemde veri getirmemişti; mum quote'lardan.
// - Quote anı sunucu saatinden (brokerTime): MetaApi'nin UTC zamanı Axi kış saatindeyken bir saat erken (@pt/db/axitime).

import { axiToUtc, logRun, markFail, markOk, type Pool } from '@pt/db'
import { MIN, SDL, type Bar } from './engine.js'

const CLOSE_GRACE_MS = 1_500
const RETRY_MS = 30_000
const STALE_MS = 30_000 // bu kadar quote gelmezse akış karar için kullanılmaz
const GAP_MS = 20_000 // iki quote arasında bu kadar süre varsa o dakikanın mumu eksik sayılır
const KEEP_MS = 30 * 3_600_000 // bellekte tutulan mumlar (bugünün kararı için yeter)
const RECONNECT_MS = 10 * 60_000 // bağlıyken bu kadar quote gelmezse bağlantı yeniden kurulur

export type StreamQuote = { bid: number; ask: number; t: number; at: number } // t: quote anı, at: geliş anı
export type StreamState = 'off' | 'connecting' | 'ready' | 'error'

type Building = Bar & { quotes: number; partial: boolean }

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

function quoteTime(time: unknown, brokerTime: unknown): number {
  const t = new Date(time as string | Date).getTime()
  const local = typeof brokerTime === 'string' ? Date.parse(`${brokerTime.replace(' ', 'T')}Z`) : NaN
  if (Number.isFinite(local) && (!Number.isFinite(t) || Math.abs(local - t) <= 12 * 3_600_000)) return axiToUtc(local, Date.now())
  return t
}

export class PriceStream {
  state: StreamState = 'off'
  error: string | null = null
  last: StreamQuote | null = null
  lateQuotes = 0
  private cur: Building | null = null
  private closed = new Map<number, Bar & { quotes: number }>()
  private connection: { close(): Promise<void> } | null = null
  private api: unknown = null
  private timer: NodeJS.Timeout | undefined
  private retry: NodeJS.Timeout | undefined
  private stopped = false
  private freshStart = true

  constructor(
    private pool: Pool,
    private conf: { token: string; accountId: string; region: string },
    private symbol: string,
  ) {}

  // Akış karar için kullanılabilir mi: bağlı ve son quote yeni.
  healthy(now = Date.now()): boolean {
    return this.state === 'ready' && this.last !== null && now - this.last.at < STALE_MS
  }

  // Kapanmış mumlar, açılışı [from, to) aralığında.
  bars(from: number, to: number): Map<number, Bar> {
    const out = new Map<number, Bar>()
    for (const [t, b] of this.closed) if (t >= from && t < to) out.set(t, b)
    return out
  }

  start() {
    if (!this.conf.token || !this.conf.accountId) return
    this.timer = setInterval(() => this.tick(), 250)
    void this.connect()
  }

  async stop() {
    this.stopped = true
    clearInterval(this.timer)
    clearTimeout(this.retry)
    await this.connection?.close().catch(() => {})
    this.connection = null
  }

  private async connect() {
    if (this.stopped) return
    this.state = 'connecting'
    this.error = null
    this.freshStart = true
    try {
      if (!this.api) {
        const mod = (await import('metaapi.cloud-sdk/esm-node')) as { default: unknown }
        const MetaApi = ((mod.default as { default?: unknown }).default ?? mod.default) as new (token: string, opts: object) => unknown
        this.api = new MetaApi(this.conf.token, { region: this.conf.region })
      }
      const account = await (this.api as any).metatraderAccountApi.getAccount(this.conf.accountId)
      if (account.state !== 'DEPLOYED') throw new Error(`MetaApi hesabı deploy'lu değil (${account.state}); core hesabı deploy etmez`)
      await account.waitConnected(120)
      const connection = account.getStreamingConnection(undefined, new Date())
      this.connection = connection
      connection.addSynchronizationListener(this.listener())
      await connection.connect()
      await connection.waitSynchronized({ timeoutInSeconds: 180 })
      try {
        await connection.subscribeToMarketData(this.symbol, [{ type: 'quotes' }])
      } catch (err) {
        // Piyasa arasında ilk quote beklenirken zaman aşımı olabilir; abonelik SDK'da kalır, quote'lar sonra akar.
        console.warn(`[sdl] fiyat aboneliği uyarısı: ${(err as Error).message ?? err}`)
      }
      this.state = 'ready'
      console.log(`[sdl] fiyat akışı hazır: ${this.symbol}`)
    } catch (err) {
      this.state = 'error'
      this.error = (err as Error)?.message ?? String(err)
      console.error(`[sdl] fiyat akışı başlatılamadı: ${this.error}`)
      await markFail(this.pool, 'sdl:akis', '1 minute', this.error).catch(() => {})
      await logRun(this.pool, { source: 'sdl:akis', startedAt: new Date(), ok: false, error: this.error }).catch(() => {})
      await this.connection?.close().catch(() => {}) // hesap başına streaming bağlantısı sınırlı
      this.connection = null
      if (!this.stopped) this.retry = setTimeout(() => void this.connect(), RETRY_MS)
    }
  }

  private listener() {
    const handlers: Record<string, (...args: unknown[]) => Promise<void>> = {
      onSymbolPriceUpdated: async (_i: unknown, price: unknown) => {
        const p = price as { symbol?: string; bid?: unknown; ask?: unknown; time?: unknown; brokerTime?: unknown } | null
        if (!p || p.symbol !== this.symbol || !isNum(p.bid) || !isNum(p.ask)) return
        const t = quoteTime(p.time, p.brokerTime)
        if (!Number.isFinite(t)) return
        const last = this.last
        // Yüksek güvenilirlikte iki kopya aynı quote'u gönderebilir: eskiyi ve kopyayı at.
        if (last && (t < last.t || (t === last.t && last.bid === p.bid && last.ask === p.ask))) return
        this.last = { bid: p.bid, ask: p.ask, t, at: Date.now() }
        // Uzun sessizlik bağlantı kopması olabilir: o dakikanın mumu eksik sayılır (karar resmi mumla verilir).
        this.onQuote(p.bid, p.ask, t, !last || t - last.t > GAP_MS)
      },
      onDisconnected: async () => {
        this.freshStart = true
        if (this.cur) this.cur.partial = true
      },
    }
    return new Proxy(handlers, {
      get(target, prop) {
        if (typeof prop === 'symbol' || prop === 'then') return undefined
        return prop in target ? target[prop] : async () => {}
      },
    })
  }

  private onQuote(bid: number, ask: number, t: number, gap: boolean) {
    const minute = Math.floor(t / MIN) * MIN
    const sp = Math.round((ask - bid) / SDL.point)
    const cur = this.cur
    if (cur && minute < cur.t) {
      this.lateQuotes++
      return
    }
    if (cur && minute > cur.t) this.close(cur)
    if (!this.cur || minute > this.cur.t) {
      if (this.closed.has(minute)) {
        this.lateQuotes++ // bu dakika zaman aşımıyla kapandı
        return
      }
      // Dakikanın ilk quote'u sessizlikten sonra geldiyse dakikanın başı kaçmış olabilir.
      this.cur = { t: minute, o: bid, h: bid, l: bid, c: bid, sp, quotes: 1, partial: this.freshStart || gap }
      this.freshStart = false
      return
    }
    const b = this.cur
    if (gap) b.partial = true
    b.h = Math.max(b.h, bid)
    b.l = Math.min(b.l, bid)
    b.c = bid
    b.sp = Math.max(b.sp ?? 0, sp)
    b.quotes++
  }

  private tick() {
    const cur = this.cur
    if (cur && Date.now() >= cur.t + MIN + CLOSE_GRACE_MS) this.close(cur)
    // SDK kopan bağlantıyı kendisi yeniler; yenileyemezse (uzun süre quote yok) bağlantı baştan kurulur.
    if (this.state === 'ready' && this.last && Date.now() - this.last.at > RECONNECT_MS) {
      console.warn(`[sdl] ${Math.round((Date.now() - this.last.at) / 60_000)} dakikadır quote yok; fiyat akışı yeniden kuruluyor`)
      this.state = 'connecting'
      this.last = null
      const old = this.connection
      this.connection = null
      void (old?.close() ?? Promise.resolve()).catch(() => {}).then(() => this.connect())
    }
  }

  private close(b: Building) {
    if (this.cur === b) this.cur = null
    if (b.partial) return
    const bar = { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, sp: b.sp, quotes: b.quotes }
    this.closed.set(b.t, bar)
    for (const t of this.closed.keys()) if (t < b.t - KEEP_MS) this.closed.delete(t)
    void this.pool
      .query(
        `INSERT INTO sdl_bars (open_time, open, high, low, close, spread_points, quotes) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (open_time) DO NOTHING`,
        [new Date(b.t), b.o, b.h, b.l, b.c, b.sp, b.quotes],
      )
      .then(() => markOk(this.pool, 'sdl:akis', '1 minute', new Date(b.t)))
      .catch((err) => console.error(`[sdl] akış mumu yazılamadı: ${(err as Error).message}`))
  }
}
