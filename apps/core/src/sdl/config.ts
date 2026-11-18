// SDL ayarları (Railway değişkenleri). Emir için SDL_TRADING_ENABLED=true ve web'deki NO TRADE düğmesinin açık olması
// gerekir; ikisinden biri kapalıysa kararlar yine yazılır, emir gitmez. MetaApi değişkenleri collector'daki paylaşılan
// değerler (fiyat akışı ve emir aynı hesaptan); yoksa akış ve emir kapalı, kararlar resmi mumlarla verilir.

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`${name} sayı olmalı: ${raw}`)
  return n
}

function time(name: string, fallback: string): number {
  const raw = process.env[name] || fallback
  const t = Date.parse(raw)
  if (Number.isNaN(t)) throw new Error(`${name} geçerli bir zaman olmalı: ${raw}`)
  return t
}

export type SdlConfig = ReturnType<typeof loadSdlConfig>

export function loadSdlConfig() {
  const region = process.env.METAAPI_REGION || 'london'
  const metaapi = {
    token: process.env.METAAPI_TOKEN ?? '',
    accountId: process.env.METAAPI_ACCOUNT_ID ?? '',
    region,
    clientUrl: (process.env.METAAPI_CLIENT_API_URL || `https://mt-client-api-v1.${region}.agiliumtrade.ai`).replace(/\/+$/, ''),
  }
  return {
    strategy: 'sdl_elle', // trading_switch satırı
    label: 'SDL_v3 - Manuel Zone No Cap', // eski sistemin STRATEGY_MAP'indeki etiket (bilgi için)
    tradingEnabled: process.env.SDL_TRADING_ENABLED === 'true',
    magic: num('SDL_MAGIC', 15033),
    riskUsd: num('SDL_RISK_USD', 10),
    minLotMaxRiskUsd: num('SDL_MIN_LOT_MAX_RISK_USD', 20),
    // Güvenlik sınırı: SL en az 65 $ uzakta olduğu için (FVG ≥ 50 $ + 15 $) 10 $ riskte lot 0,15'i geçmez.
    maxVolume: num('SDL_MAX_VOLUME', 0.2),
    replayFrom: time('SDL_REPLAY_FROM', '2026-10-01T00:00:00+03:00'),
    metaapi,
    metaapiReady: !!metaapi.token && !!metaapi.accountId,
  }
}
