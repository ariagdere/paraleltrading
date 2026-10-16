import { EventEmitter } from 'node:events'
import { SYMBOL } from './market-data'

// Canlı Axi fiyatı: MetaApi'ye tek, uzun ömürlü streaming bağlantısı, yalnız BTCUSD quote'ları. Bütün tarayıcılar
// aynı bağlantıyı /api/piyasa/canli (SSE) üzerinden paylaşır; streaming REST/RPC kredisi tüketmez. Eski
// dashboard'un lib/metaapiStream.ts'inin sadeleşmiş hali:
// - Hesabı asla deploy/undeploy etmez (hesabın yaşam döngüsü eski sistemin monitor servisinde; her başlatma en az
//   6 saat faturalanıyor). Hesap deploy'lu değilse hata verir; 30 sn sonra yeniden dener.
// - İlk istekte tembel başlar, derlemede bağlanmaz. Bağlantı globalThis'te tek (route paketleri arasında).
// - Mum aboneliği yok (eski sistemde veri getirmedi); oluşan mum tarayıcıda quote'lardan güncellenir.
// - METAAPI_TOKEN ya da METAAPI_ACCOUNT_ID yoksa kapalı; sayfa fiyatı dakikalık 1m mumlarından gösterir.

export type Quote = { bid: number; ask: number; t: number } // t: quote anı (ms, UTC)
export type LiveState = 'off' | 'idle' | 'connecting' | 'ready' | 'error'
export type LiveStatus = { state: LiveState; error: string | null; warning: string | null; lastQuoteAt: number | null }

const RETRY_MS = 30_000

type Live = {
  state: LiveState
  error: string | null
  errorAt: number | null
  warning: string | null
  last: Quote | null
  lastAt: number | null // son quote'un geldiği an (sunucu saati)
  emitter: EventEmitter
  api: unknown
  connection: { close(): Promise<void> } | null
  init: Promise<void> | null
}

const g = globalThis as typeof globalThis & { __hakari2Live?: Live }

export function getLive(): Live {
  if (!g.__hakari2Live) {
    const emitter = new EventEmitter()
    emitter.setMaxListeners(500) // her SSE istemcisi bir dinleyici
    g.__hakari2Live = { state: 'idle', error: null, errorAt: null, warning: null, last: null, lastAt: null, emitter, api: null, connection: null, init: null }
  }
  return g.__hakari2Live
}

const configured = () => !!process.env.METAAPI_TOKEN && !!process.env.METAAPI_ACCOUNT_ID

export function liveStatus(): LiveStatus {
  const s = getLive()
  return { state: configured() ? s.state : 'off', error: s.error, warning: s.warning, lastQuoteAt: s.lastAt }
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

// SDK her olayı dinleyicinin bütün yöntemlerinde arar; olmayanlar sessizce geçilir. 'then' yok: nesne thenable
// sanılmasın.
function listener(s: Live) {
  const handlers: Record<string, (...args: unknown[]) => Promise<void>> = {
    async onSymbolPriceUpdated(_i: unknown, price: unknown) {
      const p = price as { symbol?: string; bid?: unknown; ask?: unknown; time?: unknown } | null
      if (!p || p.symbol !== SYMBOL || !isNum(p.bid) || !isNum(p.ask)) return
      const t = new Date(p.time as string | Date).getTime()
      if (!Number.isFinite(t)) return
      const last = s.last
      // Yüksek güvenilirlikte iki kopya aynı quote'u gönderebilir: eskiyi ve kopyayı at.
      if (last && (t < last.t || (t === last.t && last.bid === p.bid && last.ask === p.ask))) return
      const q: Quote = { bid: p.bid, ask: p.ask, t }
      s.last = q
      s.lastAt = Date.now()
      s.emitter.emit('quote', q)
    },
  }
  return new Proxy(handlers, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined
      return prop in target ? target[prop] : async () => {}
    },
  })
}

type Sdk = {
  metatraderAccountApi: {
    getAccount(id: string): Promise<{
      state: string
      waitConnected(timeoutSec: number): Promise<void>
      getStreamingConnection(
        historyStorage: undefined,
        historyStartTime: Date,
      ): {
        addSynchronizationListener(l: object): void
        connect(): Promise<void>
        waitSynchronized(o: { timeoutInSeconds: number }): Promise<void>
        subscribeToMarketData(symbol: string, subs: Array<{ type: string }>): Promise<void>
        close(): Promise<void>
      }
    }>
  }
}

async function start(s: Live) {
  const token = process.env.METAAPI_TOKEN!
  const accountId = process.env.METAAPI_ACCOUNT_ID!
  const region = process.env.METAAPI_REGION || 'london'
  s.state = 'connecting'
  s.error = null
  s.errorAt = null
  s.warning = null
  if (!s.api) {
    // Node'un ESM paketi; next.config'te serverExternalPackages olduğu için çalışma anında yüklenir.
    const mod = (await import('metaapi.cloud-sdk/esm-node')) as { default: unknown }
    const MetaApi = ((mod.default as { default?: unknown }).default ?? mod.default) as new (token: string, opts: object) => Sdk
    s.api = new MetaApi(token, { region })
  }
  const account = await (s.api as Sdk).metatraderAccountApi.getAccount(accountId)
  if (account.state !== 'DEPLOYED') throw new Error(`MetaApi hesabı deploy'lu değil (${account.state}); web hesabı deploy etmez`)
  await account.waitConnected(120)
  // Geçmiş işlem senkronu bu bağlantının işi değil: başlangıç şimdi.
  const connection = account.getStreamingConnection(undefined, new Date())
  s.connection = connection
  connection.addSynchronizationListener(listener(s))
  await connection.connect()
  await connection.waitSynchronized({ timeoutInSeconds: 180 })
  try {
    await connection.subscribeToMarketData(SYMBOL, [{ type: 'quotes' }])
  } catch (err) {
    // Piyasa arasında ilk quote beklenirken zaman aşımı olabilir; abonelik SDK'da kalır, quote'lar sonra akar.
    s.warning = (err as Error).message ?? String(err)
    console.warn(`[web] canlı fiyat aboneliği uyarısı: ${s.warning}`)
  }
  s.state = 'ready'
  console.log(`[web] canlı fiyat akışı hazır: ${SYMBOL}`)
}

// Akışı (gerekirse) başlatır; başlamışsa aynı işi döner. Hatadan RETRY_MS sonra gelen ilk çağrı yeniden dener.
export function ensureLive(): Promise<void> {
  const s = getLive()
  if (!configured()) return Promise.resolve()
  if (s.state === 'error' && s.errorAt !== null && Date.now() - s.errorAt >= RETRY_MS) s.init = null
  if (!s.init) {
    s.init = start(s).catch(async (err) => {
      s.state = 'error'
      s.error = (err as Error)?.message ?? String(err)
      s.errorAt = Date.now()
      console.error(`[web] canlı fiyat akışı başlatılamadı: ${s.error}`)
      // Yarım kalan bağlantı kapansın: hesap başına streaming bağlantısı sınırlı.
      if (s.connection) {
        await s.connection.close().catch(() => {})
        s.connection = null
      }
    })
  }
  return s.init
}
