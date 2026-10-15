// Göstergelerin saf hesapları; veritabanına dokunmaz. Geriye dönük simülasyon da (oluşan mumlu değerler için)
// aynı fonksiyonları kullanacak.
//
// ZLEMA bölgesi eski sistemin formülü (hakari-trigger-orchestrator, computeZlemaZone; trueRange, kalmanFilter,
// ema, zlema birebir): hlc3 → Kalman → ZLEMA(8) ve ZLEMA(21). Eski sistem her hesapta son 150 mumu kullanıyordu;
// Kalman'ın başlangıç değeri yüzünden sonuç pencereye bağlı olduğu için burada da her mum o muma kadarki son 150
// mumla hesaplanır.
// RSI ve ATR 14, Wilder ortalamasıyla (TradingView'deki ta.rsi ve ta.atr gibi): ilk 14 değerin düz ortalamasıyla
// başlar, serinin başından yürür.

export type Bar = { high: number; low: number; close: number }
export type Zone = 'LONG' | 'SHORT' | 'NO_TRADE'

export const ZLEMA_WINDOW = 150
export const ZLEMA_FAST = 8
export const ZLEMA_SLOW = 21
export const RSI_PERIOD = 14
export const ATR_PERIOD = 14

function trueRange(bars: Bar[]): number[] {
  const tr = [bars[0]!.high - bars[0]!.low]
  for (let i = 1; i < bars.length; i++) {
    const { high: h, low: l } = bars[i]!
    const pc = bars[i - 1]!.close
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)))
  }
  return tr
}

function kalman(src: number[], bars: Bar[]): number[] {
  const tr = trueRange(bars)
  let value1 = 0
  let value2 = 0
  let value3 = 0
  let prev: number | null = null
  const out: number[] = []
  for (let i = 0; i < src.length; i++) {
    const d = prev === null ? 0 : src[i]! - prev
    value1 = 0.2 * d + 0.8 * value1
    value2 = 0.1 * tr[i]! + 0.8 * value2
    const lam = value2 !== 0 ? Math.abs(value1 / value2) : 0
    const inner = Math.pow(lam, 4) + 16 * Math.pow(lam, 2)
    const alpha = inner >= 0 ? (-Math.pow(lam, 2) + Math.sqrt(inner)) / 8 : 0
    value3 = alpha * src[i]! + (1 - alpha) * value3
    out.push(value3)
    prev = src[i]!
  }
  return out
}

function ema(series: number[], period: number): number[] {
  const alpha = 2 / (period + 1)
  const out = [series[0]!]
  for (let i = 1; i < series.length; i++) out.push(alpha * series[i]! + (1 - alpha) * out[i - 1]!)
  return out
}

function zlema(src: number[], period: number): number[] {
  const lag = Math.round((period - 1) / 2)
  const data: number[] = []
  for (let i = 0; i < src.length; i++) {
    const lagged = i - lag >= 0 ? src[i - lag]! : src[0]!
    data.push(src[i]! + (src[i]! - lagged))
  }
  return ema(data, period)
}

// Pencerenin son mumu için bölge ve iki ZLEMA (eski computeZlemaZone'un hesap kısmı).
export function zlemaZone(window: Bar[]): { zone: Zone; fast: number; slow: number } {
  const hlc3 = window.map((b) => (b.high + b.low + b.close) / 3)
  const src = kalman(hlc3, window)
  const ma1 = zlema(src, ZLEMA_FAST)
  const ma2 = zlema(src, ZLEMA_SLOW)
  const n = window.length
  let zone: Zone = 'NO_TRADE'
  if (n >= 3) {
    const rising = ma1[n - 1]! > ma1[n - 2]! && ma1[n - 2]! > ma1[n - 3]!
    const falling = ma1[n - 1]! < ma1[n - 2]! && ma1[n - 2]! < ma1[n - 3]!
    if (ma1[n - 1]! > ma2[n - 1]! && rising) zone = 'LONG'
    else if (ma1[n - 1]! < ma2[n - 1]! && falling) zone = 'SHORT'
  }
  return { zone, fast: ma1[n - 1]!, slow: ma2[n - 1]! }
}

const rsiOf = (gain: number, loss: number) => (loss === 0 ? 100 : gain === 0 ? 0 : 100 - 100 / (1 + gain / loss))

// İlk değer RSI_PERIOD. mumda (ilk 14 değişimin ortalaması).
export function rsiSeries(closes: number[], period = RSI_PERIOD): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null)
  if (closes.length <= period) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!
    if (d > 0) gain += d
    else loss -= d
  }
  gain /= period
  loss /= period
  out[period] = rsiOf(gain, loss)
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!
    gain = (gain * (period - 1) + Math.max(d, 0)) / period
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period
    out[i] = rsiOf(gain, loss)
  }
  return out
}

// İlk değer (period - 1). mumda (ilk 14 gerçek aralığın ortalaması; ilk mumun aralığı yüksek - düşük).
export function atrSeries(bars: Bar[], period = ATR_PERIOD): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null)
  if (bars.length < period) return out
  const tr = trueRange(bars)
  let atr = 0
  for (let i = 0; i < period; i++) atr += tr[i]!
  atr /= period
  out[period - 1] = atr
  for (let i = period; i < bars.length; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period
    out[i] = atr
  }
  return out
}

export type IndicatorRow = {
  zlemaFast: number | null
  zlemaSlow: number | null
  zone: Zone | null
  rsi: number | null
  atr: number | null
}

// Serinin from. mumundan sonuna kadar her mum için göstergeler. ZLEMA o muma kadarki son 150 mumla; RSI ve ATR
// serinin başından (bu yüzden bütün seri verilmeli). Yetersiz geçmişte null.
export function computeSeries(bars: Bar[], from = 0): IndicatorRow[] {
  const rsi = rsiSeries(bars.map((b) => b.close))
  const atr = atrSeries(bars)
  const out: IndicatorRow[] = []
  for (let k = Math.max(0, from); k < bars.length; k++) {
    const z = k >= ZLEMA_WINDOW - 1 ? zlemaZone(bars.slice(k - ZLEMA_WINDOW + 1, k + 1)) : null
    out.push({ zlemaFast: z?.fast ?? null, zlemaSlow: z?.slow ?? null, zone: z?.zone ?? null, rsi: rsi[k] ?? null, atr: atr[k] ?? null })
  }
  return out
}
