// Grafiğin sunucu ve tarayıcı tarafında ortak sabitleri ve türleri (veritabanına dokunmaz; tarayıcı paketine girer).

export const CHART_TFS = ['5m', '15m', '1h', '4h', '1d'] as const
export type ChartTf = (typeof CHART_TFS)[number]
export const isChartTf = (s: unknown): s is ChartTf => typeof s === 'string' && (CHART_TFS as readonly string[]).includes(s)
export const TF_MS: Record<ChartTf, number> = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }
export const MAX_CANDLES = 2000


export type CandleRow = [number, number, number, number, number] // açılış (ms), o, h, l, c

export type ChartZone = {
  id: number
  createdAt: number
  endedAt: number | null
  endReason: string | null
  lo: number // son bant (bittiyse bittiği andaki)
  hi: number
  score: number
  mix: [number, number, number] // puanın 4h, 1d, 1w izlerinden gelen kısmı
  touches: number
  holds: number
  breaks: number
  bands: Array<[number, number, number]> // [an, lo, hi]: bant o andan itibaren (oluşma ve boyut değişimleri)
  marks: Array<[number, 'touch' | 'hold' | 'break', number]> // [an, olay, fiyat]
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

