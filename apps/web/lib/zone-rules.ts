// Elle zon ekleme ve düzenleme kuralları (Ari, 18 Kasım): tarayıcı çizerken çakışmaları anında gösterir, sunucu kayıtta
// aynı fonksiyonla yeniden denetler. Veritabanına dokunmaz; tarayıcı paketine girer. Eski sistemin /live grafiğinde
// aynısı var (hakari-dashboard lib/zoneRules.ts); değişirse ikisi birlikte.
//
// - Çakışma: yeni zon başka bir geçerli zonu kesiyorsa ya da aradaki boşluk eşikten küçükse. Eşik 0,15 × ATR(14) 4h:
//   SDL'nin kırılma eşiği (bir 4h kapanışı zonu bu kadar geçince kırılma sayılır); daha yakın iki zon kırılma
//   kuralında birbirinden ayrılmıyor. ATR okunamazsa 150 $.
// - Düzenlemede düzenlenen zon denetime girmez.
// - Uyarı (ek onayla kaydedilir): 20 $'dan dar, 2.000 $'dan geniş ya da fiyattan %25'ten uzak zon.

export type ZoneLike = { id: number; lo: number; hi: number }
export type ZoneConflict = { id: number; lo: number; hi: number; kind: 'kesisiyor' | 'yakin'; gap: number }
export type ZoneRule = {
  threshold: number // $; bu kadardan yakın zon çakışma sayılır
  atr: number | null // ATR(14) 4h, son kapanmış mum
  price: number | null // son fiyat (uzaklık uyarısı için)
  minWidth: number
  maxWidth: number
  maxDistPct: number
  defaultBreaksFrom: string // yeni zonda kırılma takibinin varsayılan başlangıcı (ISO)
}

export const ZONE_ATR_MULT = 0.15
export const ZONE_FALLBACK_THRESHOLD = 150
export const ZONE_MIN_WIDTH = 20
export const ZONE_MAX_WIDTH = 2000
export const ZONE_MAX_DIST_PCT = 25
export const ZONE_DEFAULT_BREAKS_FROM = '2026-08-31T21:00:00.000Z' // 1 Eylül 2026 00:00 İstanbul (ilk 15 zon)

export const zoneThreshold = (atr: number | null) =>
  atr !== null && Number.isFinite(atr) && atr > 0 ? Math.round(ZONE_ATR_MULT * atr) : ZONE_FALLBACK_THRESHOLD

export const roundPrice = (p: number) => Math.round(p * 100) / 100

export function zoneConflicts(zones: ZoneLike[], lo: number, hi: number, threshold: number, exceptId: number | null = null): ZoneConflict[] {
  const out: ZoneConflict[] = []
  for (const z of zones) {
    if (z.id === exceptId) continue
    if (lo <= z.hi && hi >= z.lo) out.push({ id: z.id, lo: z.lo, hi: z.hi, kind: 'kesisiyor', gap: 0 })
    else {
      const gap = lo > z.hi ? lo - z.hi : z.lo - hi
      if (gap < threshold) out.push({ id: z.id, lo: z.lo, hi: z.hi, kind: 'yakin', gap: roundPrice(gap) })
    }
  }
  return out.sort((a, b) => b.hi - a.hi)
}

export type ZoneWarning = { code: 'dar' | 'genis' | 'uzak'; text: string }

export function zoneWarnings(lo: number, hi: number, rule: Pick<ZoneRule, 'price' | 'minWidth' | 'maxWidth' | 'maxDistPct'>): ZoneWarning[] {
  const out: ZoneWarning[] = []
  const w = hi - lo
  if (w < rule.minWidth) out.push({ code: 'dar', text: `Zon ${rule.minWidth} $'dan dar` })
  if (w > rule.maxWidth) out.push({ code: 'genis', text: `Zon ${rule.maxWidth.toLocaleString('tr-TR')} $'dan geniş` })
  if (rule.price !== null && rule.price > 0) {
    const d = lo > rule.price ? lo - rule.price : rule.price > hi ? rule.price - hi : 0
    if ((d / rule.price) * 100 > rule.maxDistPct) out.push({ code: 'uzak', text: `Zon fiyattan %${rule.maxDistPct}'ten uzak` })
  }
  return out
}

// Kayıt isteği (tarayıcıdan ve /live'dan aynı biçim). seen: kullanıcının gördüğü çakışmalar (sunucuda farklıysa
// kaydedilmez, güncel çakışmalar döner); end: bunlardan pasife alınacaklar.
export type ZoneSaveRequest = {
  lo: number
  hi: number
  editId?: number | null
  seen: number[]
  end: number[]
  breaksFrom?: string | null
}
