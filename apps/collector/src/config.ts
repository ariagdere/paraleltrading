// Ortam değişkenleri. DATABASE_URL zorunlu (packages/db okur); Apify değişkenleri yoksa heatmap kapalı kalır.
// *_BASE_URL değişkenleri yalnız yerel test içindir.

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

const metaapiRegion = process.env.METAAPI_REGION || 'london'
const trimSlash = (s: string) => s.replace(/\/+$/, '')

export const config = {
  bias: {
    repo: process.env.BIAS_REPO || 'ariagdere/hakari-dashboard',
    branch: process.env.BIAS_BRANCH || 'bias-data',
    dir: process.env.BIAS_DIR || 'data/daily-bias',
    // İsteğe bağlı: repo açık, token gerekmez; verilirse GitHub API kotası yükselir.
    token: process.env.GITHUB_TOKEN ?? '',
    gitUrl: trimSlash(process.env.GITHUB_URL || 'https://github.com'),
    apiUrl: trimSlash(process.env.GITHUB_API_URL || 'https://api.github.com'),
    rawUrl: trimSlash(process.env.GITHUB_RAW_URL || 'https://raw.githubusercontent.com'),
  },
  metaapi: {
    token: process.env.METAAPI_TOKEN ?? '',
    accountId: process.env.METAAPI_ACCOUNT_ID ?? '',
    symbol: process.env.AXI_SYMBOL || 'BTCUSD',
    marketDataUrl: trimSlash(
      process.env.METAAPI_MARKET_DATA_URL || `https://mt-market-data-client-api-v1.${metaapiRegion}.agiliumtrade.ai`,
    ),
    clientUrl: trimSlash(process.env.METAAPI_CLIENT_API_URL || `https://mt-client-api-v1.${metaapiRegion}.agiliumtrade.ai`),
    backfillFrom: time('AXI_BACKFILL_FROM', '2026-09-18T00:00:00Z'),
    // Geriye doldururken sayfalar arası bekleme: MetaApi istek kotası eski dashboard'la ortak.
    pagePauseMs: num('AXI_PAGE_PAUSE_MS', 2000),
    // Geriye doldurma hata verirse ilk tekrar bu kadar dakika sonra; her hatada ikiye katlanır (en çok 60).
    backfillRetryMinutes: num('AXI_BACKFILL_RETRY_MINUTES', 10),
  },
  apify: {
    token: process.env.APIFY_TOKEN ?? '',
    // API yolunda "kullanıcı/aktör" yerine "kullanıcı~aktör" kullanılır.
    actorId: (process.env.APIFY_ACT_ID ?? '').replace('/', '~'),
    baseUrl: process.env.APIFY_BASE_URL ?? 'https://api.apify.com',
    runCostUsd: num('HEATMAP_RUN_COST_USD', 0.01),
    budgetUsd: num('HEATMAP_BUDGET_USD', 28),
    waitMinutes: num('HEATMAP_WAIT_MINUTES', 15),
  },
  binance: {
    baseUrl: process.env.BINANCE_FAPI_BASE_URL ?? 'https://fapi.binance.com',
    symbol: process.env.LSR_SYMBOL ?? 'BTCUSDT',
    backfillFrom: time('LSR_BACKFILL_FROM', '2026-09-18T00:00:00Z'),
  },
}
