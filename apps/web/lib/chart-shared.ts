// Grafiğin sunucu ve tarayıcı tarafında ortak sabitleri ve türleri (veritabanına dokunmaz; tarayıcı paketine girer).

export const CHART_TFS = ['5m', '15m', '1h', '4h', '1d'] as const
export type ChartTf = (typeof CHART_TFS)[number]
export const isChartTf = (s: unknown): s is ChartTf => typeof s === 'string' && (CHART_TFS as readonly string[]).includes(s)
export const TF_MS: Record<ChartTf, number> = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }
export const MAX_CANDLES = 2000

export type CandleRow = [number, number, number, number, number] // açılış (ms), o, h, l, c

// Elle zon (elle_zones; Ari'nin çizdiği, SDL v3 elle zon modeli bunlarla işlem yapıyor): şu an geçerli olanlar.
// breaksFrom: kırılma takibinin başlangıcı; replaces: yerine geçtiği zonlar (düzenleme ya da çakışma).
export type ManualZone = { id: number; lo: number; hi: number; createdAt: number; breaksFrom: number; replaces: number[] | null }

export type PrevLevels = {
  day: { at: number; h: number; l: number; c: number } | null // dün (kapanmış son günlük mum)
  week: { at: number; o: number; h: number; l: number; c: number } | null // geçen hafta (pazartesi 00:00 İstanbul'dan)
}

export type ChartTokens = {
  candle: number | null // son 1m mumunun açılışı: değişince grafik yeni mumları okur
  manual: string | null // elle zonların değişim işareti (zon eklenince, kapanınca, geçerliliği başlayınca değişir)
  heat: Record<'12h' | '24h' | '48h', number | null> // pencere başına en yeni snapshot
}
