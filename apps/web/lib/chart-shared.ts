// Grafiğin sunucu ve tarayıcı tarafında ortak sabitleri ve türleri (veritabanına dokunmaz; tarayıcı paketine girer).

export const CHART_TFS = ['5m', '15m', '1h', '4h', '1d'] as const
export type ChartTf = (typeof CHART_TFS)[number]
export const isChartTf = (s: unknown): s is ChartTf => typeof s === 'string' && (CHART_TFS as readonly string[]).includes(s)
export const TF_MS: Record<ChartTf, number> = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }
export const MAX_CANDLES = 2000

export type CandleRow = [number, number, number, number, number] // açılış (ms), o, h, l, c

// Geçerli bir destek/direnç bölgesi (core v3): bant oluştuğu andan beri sabit.
export type ChartZone = {
  id: number
  createdAt: number // bölgenin belirdiği 4h kapanışı
  lo: number
  hi: number
  score: number // güç: bandındaki izlerin bugünkü ağırlığı
  mix: [number, number, number] // gücün 4h, 1d, 1w izlerinden gelen kısmı
  touches: number
  holds: number
  breaks: number
  shown: boolean // core'un seçtikleri: fiyatın ±%5'inde üstte ve altta en güçlü 3 ve fiyatın içinde olduğu
}
export type Zones = { version: string | null; computedAt: string | null; zones: ChartZone[] }

export type PrevLevels = {
  day: { at: number; h: number; l: number; c: number } | null // dün (kapanmış son günlük mum)
  week: { at: number; o: number; h: number; l: number; c: number } | null // geçen hafta (pazartesi 00:00 İstanbul'dan)
}

export type ChartTokens = {
  candle: number | null // son 1m mumunun açılışı: değişince grafik yeni mumları okur
  zones: string | null // bölgelerin son hesap anı
  heat: Record<'12h' | '24h' | '48h', number | null> // pencere başına en yeni snapshot
}
