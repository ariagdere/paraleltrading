// SDL kurulum grafiğinin verisi (sunucu ve tarayıcı ortak tipleri; /api/sdl/grafik döndürür).

export type Candle = { t: number; o: number; h: number; l: number; c: number } // açılış anı (UTC ms), bid

export type ChartZone = { id: number; lo: number; hi: number; role: 'entry' | 'target' | 'other' }

// Çıkış: gerçek işlem (eski sistemin kaydı) > benzetim (resmi 1m mumlarında aynı SL/TP) > açık (son fiyat).
export type ChartExit = {
  t: number
  kind: 'TP' | 'SL' | 'MANUEL' | 'OPEN'
  price: number
  r: number
  source: 'gercek' | 'benzetim' | 'acik'
}

export type ChartSetup = {
  kind: 'kurulum' | 'bekleyen'
  side: 'LONG' | 'SHORT'
  fvgA: number // FVG'nin 1. mumunun açılışı
  fvgI: number // FVG'nin 3. mumunun açılışı
  fvgLo: number
  fvgHi: number
  ext: number // iğne
  extT: number
  entryCandle: number | null // dönüş mumunun açılışı (bekleyende yok)
  entryT: number // giriş anı (dönüş mumunun kapanışı); bekleyende listenin hesaplandığı kapanış
  entry: number
  sl: number
  tp: number
  trigger: number | null // bekleyende kapanışın geçmesi gereken seviye
  status: 'tetik' | 'derin' | 'zon' | null // bekleyenin türü
  expiresAt: number | null // bekleyen en son bu kapanışta dönebilir
  zone: number
  tpZone: number
  zones: ChartZone[]
  exit: ChartExit | null // bekleyende yok
  real: boolean // giriş gerçek dolum fiyatı
}

export type ChartPayload = {
  setup: ChartSetup
  c3: Candle[]
  c15: Candle[]
  future3: number // bekleyende son mumdan sonra planlanan pozisyon için boş mum yeri
  future15: number
  asOf: number // verinin sonu
}
