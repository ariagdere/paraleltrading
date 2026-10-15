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

export const config = {
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
