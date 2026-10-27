// Naif kuralın saf hesapları; veritabanına dokunmaz. Eski sistemin kuralı birebir (hakari-trigger-orchestrator):
//   - setup (computeNaiveSetup): heatmap referansı ile üst ve alt cluster arasında yakın olan yön; TP yakın
//     cluster'a mesafenin %75'i, SL uzak cluster'a mesafenin %75'i. Cluster'lar iki ondalığa yuvarlı (eski
//     computeClusters öyle veriyordu), referans yuvarlanmadan; çıktılar iki ondalık.
//   - ZLEMA 4h bölgesi (computeZlemaZone): son 150 mum, oluşan mum dahil. Eski sistem Binance vadeli 4h'yi
//     kullanıyordu; burada Axi 4h (İstanbul'a hizalı), oluşan mum karar anına kadar kapanmış 1m mumlarından.
//   - pencere: eski sistemin o tarihteki kuralı (9 Ekim'e kadar hafta içi, sonra pazartesi 00:00 – cuma 15:05).
//   - yön ZLEMA bölgesiyle aynıysa ve döngü penceredeyse eski sistem emir gönderirdi: sinyal.
// İşlem benzetimi Axi 1m mumlarıyla: mumlar bid; BUY ask'tan (bid + spread) girer, bid'le çıkar; SELL bid'den girer,
// ask'la çıkar. TP/SL eski sistemin gönderdiği gibi heatmap fiyatıyla (bazla kaydırılmadan).

import { zlemaZone, type Zone } from './indicators.js'

export const NAIVE_VERSION = 'v1'
export const NAIVE = {
  span: '12h', // eski sistem yalnız 12h heatmap'i kullanıyordu
  tpPct: 75,
  slPct: 75,
  entryDelayMs: 45_000, // heatmap'in son sütunundan emre (12 Ekim dökümü: gerçek naif emirlerde medyan 45 sn)
  zlemaBars: 150,
  fridayCutoffMin: 15 * 60,
  fridayGraceMin: 5,
  defaultSpreadUsd: 12, // mumda spread yoksa (eski panel emirlerinde ölçülen tipik değer)
} as const

const IST = 3 * 3_600_000
const H4 = 4 * 3_600_000
const M1 = 60_000

export const round2 = (x: number) => Math.round(x * 100) / 100

export type Direction = 'LONG' | 'SHORT'
export type Setup = { direction: Direction; entry: number; tp: number; sl: number; rr: number }

// Eski computeNaiveSetup: cluster'lar fiyatın iki yanında değilse ya da mesafeler sıfırsa setup yok.
export function naiveSetup(ref: number, up: number, dn: number): Setup | null {
  if (!(up > ref && dn < ref)) return null
  const upDist = up - ref
  const dnDist = ref - dn
  const direction: Direction = upDist < dnDist ? 'LONG' : 'SHORT'
  const tpDist = (NAIVE.tpPct / 100) * (direction === 'LONG' ? upDist : dnDist)
  const slDist = (NAIVE.slPct / 100) * (direction === 'LONG' ? dnDist : upDist)
  if (tpDist <= 0 || slDist <= 0) return null
  const tp = direction === 'LONG' ? ref + tpDist : ref - tpDist
  const sl = direction === 'LONG' ? ref - slDist : ref + slDist
  return { direction, entry: round2(ref), tp: round2(tp), sl: round2(sl), rr: Math.round((tpDist / slDist) * 1000) / 1000 }
}

// Pencerenin eski sistemdeki geçmişi (hakari-trigger-orchestrator): 8 Eylül 21:43'e (İstanbul) kadar pencere yok;
// sonra yalnız hafta içi (pazartesi–cuma bütün gün, emir anında); 9 Ekim 15:39'dan sonra pazartesi 00:00 – cuma 15:05
// (döngünün başladığı ana göre). Yeniden oynatma eski sistemin o gün uyguladığı kuralı kullanır.
export const WINDOW_RULES = { weekdayFrom: Date.parse('2026-09-08T18:44:00Z'), cutoffFrom: Date.parse('2026-10-09T12:40:00Z') }

// Eski isNaifWindowIstanbul: hafta içi, cuma 15:05'ten önce başlayan döngü.
export function cutoffWindow(ms: number): boolean {
  const d = new Date(ms + IST)
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false
  if (day === 5) return d.getUTCHours() * 60 + d.getUTCMinutes() < NAIVE.fridayCutoffMin + NAIVE.fridayGraceMin
  return true
}

// Eski isWeekdayIstanbul: İstanbul'da pazartesi–cuma.
export function weekdayIstanbul(ms: number): boolean {
  const day = new Date(ms + IST).getUTCDay()
  return day >= 1 && day <= 5
}

export function inNaifWindow(cycleAt: number, decidedAt = cycleAt + NAIVE.entryDelayMs): boolean {
  if (cycleAt >= WINDOW_RULES.cutoffFrom) return cutoffWindow(cycleAt)
  if (decidedAt >= WINDOW_RULES.weekdayFrom) return weekdayIstanbul(decidedAt)
  return true
}

export type Bar4 = { t: number; o: number; h: number; l: number; c: number }
export type Bar1 = { t: number; o: number; h: number; l: number; c: number; s: number | null } // s: spread ($)

// Sıralı dizide açılışı t'den küçük ya da eşit son mumun sırası (yoksa -1).
export function lastAtOrBefore(bars: { t: number }[], t: number): number {
  let lo = 0
  let hi = bars.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid]!.t <= t) ((ans = mid), (lo = mid + 1))
    else hi = mid - 1
  }
  return ans
}

// Axi 4h aralığının başı (İstanbul'a hizalı: 00, 04, 08 …).
export const h4Open = (t: number) => Math.floor((t + IST) / H4) * H4 - IST

// Karar anındaki 4h bölgesi: oluşan aralıktan önceki son 149 kapanmış mum ve oluşan mum (o ana kadar kapanmış 1m
// mumlarından; hiç yoksa son fiyatla tek değerli mum). Geçmiş yetmezse null.
export function zoneAt(c4: Bar4[], m1: Bar1[], at: number): { zone: Zone; forming: Bar4 } | null {
  const f = h4Open(at)
  const lastClosed = lastAtOrBefore(c4, f - 1)
  if (lastClosed + 1 < NAIVE.zlemaBars - 1) return null
  const closed = c4.slice(lastClosed + 2 - NAIVE.zlemaBars, lastClosed + 1)
  const end = lastAtOrBefore(m1, at - M1) // kapanmış son 1m (açılış + 1 dk ≤ at)
  let o = NaN
  let h = -Infinity
  let l = Infinity
  let c = NaN
  for (let i = end; i >= 0 && m1[i]!.t >= f; i--) {
    const b = m1[i]!
    if (Number.isNaN(c)) c = b.c
    o = b.o
    if (b.h > h) h = b.h
    if (b.l < l) l = b.l
  }
  if (Number.isNaN(c)) {
    const last = end >= 0 ? m1[end]!.c : closed[closed.length - 1]?.c
    if (last === undefined) return null
    o = h = l = c = last
  }
  const forming: Bar4 = { t: f, o, h, l, c }
  return { zone: zlemaZone([...closed, forming].map((b) => ({ high: b.h, low: b.l, close: b.c }))).zone, forming }
}

export type Trade = {
  entryBid: number
  entryPrice: number
  spread: number
  exitAt: number | null // çıkışın olduğu 1m mumunun açılışı; açık işlemde null
  exitReason: 'TP' | 'SL' | null
  exitPrice: number | null
  r: number | null
  mfe: number // en iyi lehe hareket ($, girişten)
  mae: number // en kötü aleyhe hareket ($)
  ambiguous: boolean // TP ve SL aynı 1m mumunda: SL sayıldı
}

// Karar anındaki fiyat: içinde bulunulan 1m mumunun açılışı (yoksa son kapanış) ve o mumun spread'i.
export function priceAt(m1: Bar1[], at: number): { bid: number; spread: number } | null {
  const i = lastAtOrBefore(m1, at)
  if (i < 0) return null
  const b = m1[i]!
  if (at - b.t > 10 * M1) return null // mum yok (boşluk): fiyat bilinmiyor
  return { bid: at < b.t + M1 ? b.o : b.c, spread: b.s ?? NAIVE.defaultSpreadUsd }
}

// Girişten sonraki 1m mumlarıyla TP/SL. Mum seviyenin ötesinde açılırsa açılıştan çıkılır; TP ve SL aynı mumdaysa
// hangisinin önce olduğu bilinmez, SL sayılır.
export function simulate(direction: Direction, at: number, bid: number, spread: number, sl: number, tp: number, m1: Bar1[]): Trade {
  const long = direction === 'LONG'
  const entry = long ? bid + spread : bid
  const risk = long ? entry - sl : sl - entry
  const out: Trade = { entryBid: bid, entryPrice: entry, spread, exitAt: null, exitReason: null, exitPrice: null, r: null, mfe: 0, mae: 0, ambiguous: false }
  const start = lastAtOrBefore(m1, at) + 1 // girişten sonra açılan ilk mum
  for (let i = Math.max(0, start); i < m1.length; i++) {
    const b = m1[i]!
    const sp = b.s ?? spread
    // BUY bid'le, SELL ask'la (bid + spread) çıkar
    const o = long ? b.o : b.o + sp
    const hi = long ? b.h : b.h + sp
    const lo = long ? b.l : b.l + sp
    const fav = long ? hi - entry : entry - lo
    const adv = long ? entry - lo : hi - entry
    let reason: 'TP' | 'SL' | null = null
    let px = 0
    if (long ? o <= sl : o >= sl) ((reason = 'SL'), (px = o))
    else if (long ? o >= tp : o <= tp) ((reason = 'TP'), (px = o))
    else {
      const hitSl = long ? lo <= sl : hi >= sl
      const hitTp = long ? hi >= tp : lo <= tp
      if (hitSl) ((reason = 'SL'), (px = sl), (out.ambiguous = hitTp))
      else if (hitTp) ((reason = 'TP'), (px = tp))
    }
    if (reason) {
      // çıkış mumunda ancak çıkış fiyatına kadarki hareket sayılır
      out.mfe = Math.max(out.mfe, reason === 'TP' ? (long ? px - entry : entry - px) : Math.min(fav, long ? tp - entry : entry - tp))
      out.mae = Math.max(out.mae, reason === 'SL' ? (long ? entry - px : px - entry) : Math.min(adv, long ? entry - sl : sl - entry))
      out.exitAt = b.t
      out.exitReason = reason
      out.exitPrice = px
      out.r = risk > 0 ? (long ? px - entry : entry - px) / risk : null
      return out
    }
    if (fav > out.mfe) out.mfe = fav
    if (adv > out.mae) out.mae = adv
  }
  return out
}

export type SnapshotInput = {
  id: number
  cycleAt: number // döngü anı: heatmap'in son sütunu (yoksa güncelleme ya da alınma anı)
  ref: number | null
  up: number | null
  dn: number | null
  basis: number | null
}

export type Reason = 'seviye_yok' | 'cluster_yok' | 'bolge_yok' | 'bolge_farkli' | 'pencere_disi' | 'fiyat_yok' | 'gecersiz_seviye'

export type Decision = {
  snapshotId: number
  cycleAt: number
  decidedAt: number
  inWindow: boolean
  ref: number | null
  up: number | null
  dn: number | null
  basis: number | null
  setup: Setup | null
  zone: Zone | null
  aligned: boolean
  signal: boolean
  reason: Reason | null
  trade: Trade | null
}

// Bir snapshot'ın kararı ve (sinyalse) benzetilen işlem.
export function decide(s: SnapshotInput, c4: Bar4[], m1: Bar1[]): Decision {
  const decidedAt = s.cycleAt + NAIVE.entryDelayMs
  const inWindow = inNaifWindow(s.cycleAt)
  const up = s.up === null ? null : round2(s.up)
  const dn = s.dn === null ? null : round2(s.dn)
  const d: Decision = {
    snapshotId: s.id,
    cycleAt: s.cycleAt,
    decidedAt,
    inWindow,
    ref: s.ref,
    up,
    dn,
    basis: s.basis,
    setup: null,
    zone: null,
    aligned: false,
    signal: false,
    reason: null,
    trade: null,
  }
  if (s.ref === null) return { ...d, reason: 'seviye_yok' }
  d.setup = up !== null && dn !== null ? naiveSetup(s.ref, up, dn) : null
  if (!d.setup) return { ...d, reason: 'cluster_yok' }
  const z = zoneAt(c4, m1, decidedAt)
  if (!z) return { ...d, reason: 'bolge_yok' }
  d.zone = z.zone
  d.aligned = z.zone === d.setup.direction
  if (!d.aligned) return { ...d, reason: 'bolge_farkli' }
  if (!inWindow) return { ...d, reason: 'pencere_disi' }
  d.signal = true
  const p = priceAt(m1, decidedAt)
  if (!p) return { ...d, reason: 'fiyat_yok' }
  const { direction, sl, tp } = d.setup
  // Axi fiyatına göre yanlış taraftaki seviye (BUY bid'le, SELL ask'la kapanır): broker emri reddederdi
  const close = direction === 'LONG' ? p.bid : p.bid + p.spread
  if (direction === 'LONG' ? !(sl < close && tp > close) : !(sl > close && tp < close)) return { ...d, reason: 'gecersiz_seviye' }
  d.trade = simulate(direction, decidedAt, p.bid, p.spread, sl, tp, m1)
  return d
}
