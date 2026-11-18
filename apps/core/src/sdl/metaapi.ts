// MetaApi REST: güncel fiyat, market emri, açık pozisyonlar, işlem geçmişi. Eski sistemin panel kodunun
// (hakari-dashboard lib/metaapiTrade.ts) karşılığı: emir burada ASLA tekrar gönderilmez; sonuç belirsizse çağıran
// taraf pozisyonu clientId'yle arar. Hesabı deploy/undeploy etmez (yaşam döngüsü eski sistemin monitöründe).

import type { Side } from './engine.js'

export type MetaApiConf = { token: string; accountId: string; clientUrl: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)

async function json(conf: MetaApiConf, path: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<{ status: number; ok: boolean; body: any }> {
  const res = await fetch(`${conf.clientUrl}/users/current/accounts/${conf.accountId}${path}`, {
    ...init,
    headers: { 'auth-token': conf.token, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text.slice(0, 400)
  }
  return { status: res.status, ok: res.ok, body }
}

export type Quote = { bid: number; ask: number; t: number; source: 'akis' | 'rest' }

// REST current-price; 5xx ya da zaman aşımında bir kez daha.
export async function restQuote(conf: MetaApiConf, symbol: string): Promise<Quote> {
  let last = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await sleep(500)
    try {
      const r = await json(conf, `/symbols/${encodeURIComponent(symbol)}/current-price`, {}, 6_000)
      const bid = num(r.body?.bid)
      const ask = num(r.body?.ask)
      if (r.ok && bid !== null && ask !== null) return { bid, ask, t: Date.now(), source: 'rest' }
      last = `HTTP ${r.status}`
      if (r.ok || (r.status < 500 && r.status !== 429)) break
    } catch (err) {
      last = (err as Error).name === 'TimeoutError' ? 'zaman aşımı' : String((err as Error).message ?? err)
    }
  }
  throw new Error(`Güncel fiyat alınamadı (${last})`)
}

export type TradeOutcome =
  | { kind: 'executed'; code: string; message: string; orderId: string | null; positionId: string | null }
  | { kind: 'rejected'; code: string; message: string }
  | { kind: 'unknown'; message: string }

// MetaApi SDK'sının başarı saydığı kodlar ve emrin İŞLENMEDİĞİ kesin MT5 kodları (eski sistemle aynı listeler).
const SUCCESS = new Set(['ERR_NO_ERROR', 'TRADE_RETCODE_PLACED', 'TRADE_RETCODE_DONE', 'TRADE_RETCODE_DONE_PARTIAL', 'TRADE_RETCODE_NO_CHANGES'])
const SUCCESS_NUMERIC = new Set([0, 10008, 10009, 10010, 10025])
const REJECT = new Set([
  'TRADE_RETCODE_REQUOTE', 'TRADE_RETCODE_REJECT', 'TRADE_RETCODE_CANCEL', 'TRADE_RETCODE_INVALID',
  'TRADE_RETCODE_INVALID_VOLUME', 'TRADE_RETCODE_INVALID_PRICE', 'TRADE_RETCODE_INVALID_STOPS',
  'TRADE_RETCODE_TRADE_DISABLED', 'TRADE_RETCODE_MARKET_CLOSED', 'TRADE_RETCODE_NO_MONEY',
  'TRADE_RETCODE_PRICE_CHANGED', 'TRADE_RETCODE_PRICE_OFF', 'TRADE_RETCODE_INVALID_EXPIRATION',
  'TRADE_RETCODE_ORDER_CHANGED', 'TRADE_RETCODE_TOO_MANY_REQUESTS', 'TRADE_RETCODE_SERVER_DISABLES_AT',
  'TRADE_RETCODE_CLIENT_DISABLES_AT', 'TRADE_RETCODE_LOCKED', 'TRADE_RETCODE_FROZEN', 'TRADE_RETCODE_INVALID_FILL',
  'TRADE_RETCODE_CONNECTION', 'TRADE_RETCODE_ONLY_REAL', 'TRADE_RETCODE_LIMIT_ORDERS', 'TRADE_RETCODE_LIMIT_VOLUME',
  'TRADE_RETCODE_INVALID_ORDER', 'TRADE_RETCODE_POSITION_CLOSED', 'TRADE_RETCODE_INVALID_CLOSE_VOLUME',
  'TRADE_RETCODE_CLOSE_ORDER_EXIST', 'TRADE_RETCODE_LIMIT_POSITIONS', 'TRADE_RETCODE_REJECT_CANCEL',
  'TRADE_RETCODE_LONG_ONLY', 'TRADE_RETCODE_SHORT_ONLY', 'TRADE_RETCODE_CLOSE_ONLY', 'TRADE_RETCODE_FIFO_CLOSE',
  'TRADE_RETCODE_HEDGE_PROHIBITED',
])

// Mutlak SL/TP ile market emri; comment boş (MetaApi clientId'yi MT5'in comment alanında saklar, toplam 26 karakter).
export async function sendMarketOrder(
  conf: MetaApiConf,
  p: { symbol: string; side: Side; volume: number; sl: number; tp: number; clientId: string; magic: number },
): Promise<TradeOutcome> {
  const body = {
    actionType: p.side === 'LONG' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL',
    symbol: p.symbol,
    volume: p.volume,
    stopLoss: p.sl,
    takeProfit: p.tp,
    magic: p.magic,
    clientId: p.clientId,
  }
  let r: { status: number; ok: boolean; body: any }
  try {
    r = await json(conf, '/trade', { method: 'POST', body: JSON.stringify(body) }, 30_000)
  } catch (err) {
    return { kind: 'unknown', message: (err as Error).name === 'TimeoutError' ? "MetaApi 30 sn'de yanıt vermedi" : String((err as Error).message ?? err) }
  }
  if (r.status >= 500) return { kind: 'unknown', message: `MetaApi HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}` }
  const b = r.body && typeof r.body === 'object' ? r.body : {}
  const stringCode: string | null = typeof b.stringCode === 'string' ? b.stringCode : typeof b.description === 'string' ? b.description : null
  const numericCode: number | null = typeof b.numericCode === 'number' ? b.numericCode : typeof b.error === 'number' ? b.error : null
  const message = String(b.message ?? '')
  if (r.ok) {
    if ((stringCode && SUCCESS.has(stringCode)) || (!stringCode && numericCode !== null && SUCCESS_NUMERIC.has(numericCode))) {
      return {
        kind: 'executed',
        code: stringCode ?? String(numericCode),
        message,
        orderId: b.orderId != null ? String(b.orderId) : null,
        positionId: b.positionId != null ? String(b.positionId) : null,
      }
    }
    if (stringCode && REJECT.has(stringCode)) return { kind: 'rejected', code: stringCode, message }
    return { kind: 'unknown', message: `MetaApi belirsiz yanıt: ${stringCode ?? numericCode ?? JSON.stringify(r.body).slice(0, 200)}${message ? ` (${message})` : ''}` }
  }
  // 4xx: istek MT5'e iletilmedi (doğrulama, yetki, hesap bağlı değil, hız sınırı …)
  return { kind: 'rejected', code: String(stringCode ?? (typeof b.error === 'string' ? b.error : null) ?? `HTTP_${r.status}`), message }
}

// clientId'nin ilk iki parçası (PT_<anahtar>); MetaApi son parçayı değiştirebiliyor.
export const clientKeyOf = (clientId: unknown): string | null => {
  if (typeof clientId !== 'string' || !clientId.startsWith('PT_')) return null
  const parts = clientId.split('_')
  return parts.length >= 2 && /^[a-z0-9]{10}$/.test(parts[1]!) ? `${parts[0]}_${parts[1]}` : null
}

// Emrin açılış kaydı: önce açık pozisyonlar, yoksa (pozisyon hemen kapanmış olabilir) geçmişteki açılış deal'i.
export async function findByClientKey(
  conf: MetaApiConf,
  clientKey: string,
  since: Date,
): Promise<{ positionId: string; orderId: string | null; price: number; volume: number; open: boolean } | null> {
  const r = await json(conf, '/positions', {}, 10_000)
  if (!r.ok || !Array.isArray(r.body)) throw new Error(`Açık pozisyonlar okunamadı (HTTP ${r.status})`)
  const p = r.body.find((x: any) => clientKeyOf(x?.clientId) === clientKey)
  if (p && p.id != null && num(p.openPrice) !== null) {
    return { positionId: String(p.id), orderId: null, price: p.openPrice, volume: Number(p.volume), open: true }
  }
  const fmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, '.000Z')
  const h = await json(conf, `/history-deals/time/${fmt(new Date(since.getTime() - 60_000))}/${fmt(new Date(Date.now() + 60_000))}?limit=1000`, {}, 10_000)
  if (!h.ok || !Array.isArray(h.body)) throw new Error(`İşlem geçmişi okunamadı (HTTP ${h.status})`)
  const d = h.body.find((x: any) => x?.entryType === 'DEAL_ENTRY_IN' && clientKeyOf(x?.clientId) === clientKey && x.positionId != null)
  if (d && num(d.price) !== null) {
    return { positionId: String(d.positionId), orderId: d.orderId != null ? String(d.orderId) : null, price: d.price, volume: Number(d.volume), open: false }
  }
  return null
}
