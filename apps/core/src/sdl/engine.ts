// SDL v3, elle zonlar: saf hesaplar; veritabanına ve ağa dokunmaz. Araştırma motorunun (Python, "SDL v3 Örnek
// Trade" sayfası ve claude/sdl-v3-ornek-trade.md) birebir karşılığı, şu ayarlarla: likiditesiz versiyon (nosweep),
// hedef girişin tamamen ötesindeki ilk zon (beyond), iğne zonu aşabilir (pierce), dönüşüm şartı açık. Araştırmadaki
// işlem sınırı ve 3 kayıp kuralı yok (Ari, 18 Kasım: ikisi de kaldırıldı); hafta sonu ve haber filtresi canlı kural
// olarak eklendi (aşağıda). Aynı fonksiyonlar hem canlı karar (live.ts) hem geçmişin yeniden oynatması (replay.ts) için.
//
// Kurallar (zamanlar UTC ms; gün ve saat İstanbul, UTC+3 sabit):
// - 3m mumlar 1m'lerden (3 dakikalık UTC sınırları; İstanbul'la aynı hizada). Spread mumdaki en büyük değer (point).
// - Bias: o günün (run_date) karar anına kadar gelmiş son raporu. LONG ya da SHORT değilse (NEUTRAL) işlem aranmaz.
// - Pencere: 3m kapanışı İstanbul 07:00–20:00 (iki uç dahil), hafta içi.
// - Short: boğa FVG (3. mumun dibi − 1. mumun tepesi ≥ 50 $), aynı gün ve dönüşten en çok 80 mum (4 saat) önce
//   oluşmuş; FVG'nin altındaki ilk 3m kapanışı giriştir (bid). Aynı mumda birden çok FVG dönerse en son oluşan.
//   İğne: FVG'nin 1. mumundan dönüş mumuna en yüksek fitil. Zon: iğnenin ulaştığı (lo ≤ iğne) ve giriş kapanışının
//   üst kenarın altında kaldığı en üstteki geçerli zon. SL = iğne + 15; TP = girişin tamamen altındaki en yakın zonun
//   üst kenarı + 15. Altta zon yoksa kurulum yok.
// - Long: aynası. Ayı FVG; FVG üstündeki ilk 3m kapanışı; giriş ask (kapanış + spread); iğne en düşük fitil; zon
//   hi ≥ iğne ve kapanış > lo olan en alttaki; SL = iğne − 15; TP = girişin tamamen üstündeki en yakın zonun alt
//   kenarı − 15.
// - Dönüşüm şartı: giriş zonunun girişten önceki son kırılması işlem yönünde (short'ta aşağı, long'da yukarı); hiç
//   kırılmamış zon geçmez. Kırılma: zon oluştuktan sonra bir 4h kapanışının bandın 0,15 ATR(14, Wilder) ötesine
//   geçmesi; zonun yanı oluştuğu 4h kapanışında kapanışın orta noktaya göre yeri. Kırılma anı 4h kapanışı.
// - Haber filtresi (Hakan Bey'in kuralı; araştırmada yoktu): haberden 1 saat önce yeni işlem yok, 30 dk sonra başlar.
// - Çıkış benzetimi 1m mumlarıyla: mumlar bid; short ask'la (bid + spread) çıkar, long bid'le; aynı mumda SL ve TP →
//   SL. Spread yoksa 1200 point (12 $).

export const MIN = 60_000
export const M3 = 3 * MIN
export const H = 3_600_000
export const H4 = 4 * H
export const DAY = 24 * H
const IST = 3 * H

export const SDL = {
  minGap: 50,
  slBuf: 15,
  tpBuf: 15,
  winFrom: 7,
  winTo: 20,
  point: 0.01,
  fvgMaxAge: 80,
  spreadDefaultPts: 1200,
  breakAtr: 0.15,
  atrLen: 14,
  newsBeforeMs: 60 * MIN,
  newsAfterMs: 30 * MIN,
} as const

export type Side = 'LONG' | 'SHORT'
export type Bar = { t: number; o: number; h: number; l: number; c: number; sp: number | null } // 1m; sp point
export type Bar3 = Bar & { n: number; last: number }
export type Bar4 = { t: number; o: number; h: number; l: number; c: number } // açılış anı
export type Zone = { id: number; lo: number; hi: number; createdAt: number; endedAt: number | null }
export type Break = { t: number; dir: 'down' | 'up' } // t: 4h kapanışı
export type BiasReport = { at: number; bias: string }
export type Exit = { t: number; kind: 'SL' | 'TP'; price: number; ambiguous: boolean }

// ─── Zaman ─────────────────────────────────────────────────────────────────────────────────────────────────────
export const istDay = (t: number) => new Date(t + IST).toISOString().slice(0, 10) // 'YYYY-MM-DD'
export const istDayStart = (day: string) => Date.parse(`${day}T00:00:00+03:00`)
export const prevDay = (day: string) => istDay(istDayStart(day) - 12 * H)
export function istWeekday(t: number): number {
  const d = new Date(t + IST).getUTCDay()
  return d === 0 ? 7 : d // 1 pazartesi … 7 pazar
}

// ─── Mumlar ────────────────────────────────────────────────────────────────────────────────────────────────────
export function build3(m1: Bar[]): Bar3[] {
  const out: Bar3[] = []
  let cur: Bar3 | null = null
  for (const c of m1) {
    const b = Math.floor(c.t / M3) * M3
    if (!cur || cur.t !== b) {
      if (cur) out.push(cur)
      cur = { t: b, o: c.o, h: c.h, l: c.l, c: c.c, sp: c.sp, n: 1, last: c.t }
    } else {
      cur.h = Math.max(cur.h, c.h)
      cur.l = Math.min(cur.l, c.l)
      cur.c = c.c
      cur.n += 1
      cur.last = c.t
      if (c.sp !== null) cur.sp = Math.max(cur.sp ?? 0, c.sp)
    }
  }
  if (cur) out.push(cur)
  return out
}

// ─── Zonlar ve dönüşüm ─────────────────────────────────────────────────────────────────────────────────────────
export const activeZones = (zones: Zone[], t: number) =>
  zones.filter((z) => z.createdAt <= t && (z.endedAt === null || z.endedAt > t))

// ATR(14), Wilder: ilk 14 gerçek aralığın ortalaması, sonra (önceki × 13 + yeni) / 14. İlk mumun aralığı h − l.
export function wilderAtr(c4: Bar4[], n: number = SDL.atrLen): Array<number | null> {
  const out: Array<number | null> = new Array(c4.length).fill(null)
  let a = 0
  for (let i = 0; i < c4.length; i++) {
    const k = c4[i]!
    const tr = i === 0 ? k.h - k.l : Math.max(k.h - k.l, Math.abs(k.h - c4[i - 1]!.c), Math.abs(k.l - c4[i - 1]!.c))
    if (i < n) {
      a += tr
      if (i === n - 1) {
        a /= n
        out[i] = a
      }
    } else {
      a = (a * (n - 1) + tr) / n
      out[i] = a
    }
  }
  return out
}

// Zonun kırılmaları, oluştuğu 4h kapanışından (createdAt bir 4h kapanışı değilse ondan sonraki ilk kapanıştan)
// bitişine ya da upto'ya kadar (dahil). c4 açılış sırasıyla; atr = wilderAtr(c4).
export function zoneBreaks(z: Zone, c4: Bar4[], atr: Array<number | null>, upto?: number): Break[] {
  let i0 = c4.findIndex((k) => k.t + H4 === z.createdAt)
  if (i0 < 0) i0 = c4.findIndex((k) => k.t + H4 >= z.createdAt)
  if (i0 < 0) return []
  let side: 'above' | 'below' = c4[i0]!.c >= (z.lo + z.hi) / 2 ? 'above' : 'below'
  const end = z.endedAt ?? Number.POSITIVE_INFINITY
  const out: Break[] = []
  for (let i = i0 + 1; i < c4.length; i++) {
    const now = c4[i]!.t + H4
    if (now > end || (upto !== undefined && now > upto)) break
    const a = atr[i]
    if (a === null || a === undefined) continue
    const k = c4[i]!
    if (side === 'above' && k.c < z.lo - SDL.breakAtr * a) {
      side = 'below'
      out.push({ t: now, dir: 'down' })
    } else if (side === 'below' && k.c > z.hi + SDL.breakAtr * a) {
      side = 'above'
      out.push({ t: now, dir: 'up' })
    }
  }
  return out
}

export function lastBreak(breaks: Break[] | undefined, t: number): Break | null {
  let last: Break | null = null
  for (const b of breaks ?? []) if (b.t <= t) last = b
  return last
}

export const flipOk = (breaks: Break[] | undefined, side: Side, t: number) =>
  lastBreak(breaks, t)?.dir === (side === 'SHORT' ? 'down' : 'up')

// ─── Kurulum ───────────────────────────────────────────────────────────────────────────────────────────────────
export type Candidate = {
  day: string
  side: Side
  biasAt: number
  fvgA: number // FVG'nin 1. mumunun açılışı
  fvgI: number // FVG'nin 3. mumunun açılışı
  gap: number
  fvgLo: number
  fvgHi: number
  ext: number // iğne
  extT: number
  zone: Zone
  entryCandle: number // dönüş mumunun (3m) açılışı
  entryT: number // dönüş mumunun kapanışı: karar anı
  entry: number // short bid, long ask (kapanış + spread)
  close: number // dönüş mumunun kapanışı (bid)
  spread: number // $
  sl: number
  tp: number
  tpZone: Zone
  entryInZone: number[]
  risk: number
  rr: number
}

export type DayContext = {
  day: string
  c3: Bar3[] // günün 3m mumları (İstanbul günü), açılış sırasıyla
  zones: Zone[]
  bias: BiasReport[] // günün raporları, zaman sırasıyla
}

const pick = <T>(xs: T[], better: (a: T, b: T) => boolean): T => xs.reduce((best, x) => (better(x, best) ? x : best))

// Günün j. 3m mumunun kapanışında kurulum var mı (pencere ve bias dahil; dönüşüm, haber ve hafta sonu hariç).
export function candidateAt(ctx: DayContext, j: number): Candidate | null {
  const { c3 } = ctx
  if (j < 2 || j >= c3.length) return null
  const D0 = istDayStart(ctx.day)
  const cj = c3[j]!
  const tclose = cj.t + M3
  if (tclose < D0 + SDL.winFrom * H || tclose > D0 + SDL.winTo * H) return null
  let rep: BiasReport | null = null
  for (const r of ctx.bias) if (r.at <= tclose) rep = r
  if (!rep || (rep.bias !== 'LONG' && rep.bias !== 'SHORT')) return null
  const side = rep.bias as Side

  let best: { i: number; gap: number; ext: number; extT: number } | null = null
  for (let i = Math.max(2, j - SDL.fvgMaxAge); i < j; i++) {
    const a = c3[i - 2]!
    const c = c3[i]!
    let gap: number
    if (side === 'SHORT') {
      gap = c.l - a.h
      if (gap < SDL.minGap) continue
      const bot = a.h
      if (!(cj.c < bot)) continue
      let turned = false
      for (let k = i + 1; k < j; k++) if (c3[k]!.c < bot) turned = true // daha önce dönmüş
      if (turned) continue
    } else {
      gap = a.l - c.h
      if (gap < SDL.minGap) continue
      const top = a.l
      if (!(cj.c > top)) continue
      let turned = false
      for (let k = i + 1; k < j; k++) if (c3[k]!.c > top) turned = true
      if (turned) continue
    }
    let ext = side === 'SHORT' ? -Infinity : Infinity
    let extT = 0
    for (let k = i - 2; k <= j; k++) {
      const x = c3[k]!
      if (side === 'SHORT' ? x.h > ext : x.l < ext) {
        ext = side === 'SHORT' ? x.h : x.l
        extT = x.t
      }
    }
    if (!best || i > best.i) best = { i, gap, ext, extT } // en son oluşan FVG
  }
  if (!best) return null

  const Zs = activeZones(ctx.zones, tclose)
  const spread = (cj.sp ?? SDL.spreadDefaultPts) * SDL.point
  const { i, gap, ext, extT } = best
  const a = c3[i - 2]!
  const c = c3[i]!
  let zone: Zone, entry: number, sl: number, tpZone: Zone, tp: number
  if (side === 'SHORT') {
    const zt = Zs.filter((z) => z.lo <= ext && cj.c < z.hi)
    if (zt.length === 0) return null
    zone = pick(zt, (x, b) => x.lo > b.lo)
    entry = cj.c
    sl = ext + SDL.slBuf
    const below = Zs.filter((z) => z.hi < entry)
    if (below.length === 0) return null
    tpZone = pick(below, (x, b) => x.hi > b.hi)
    tp = tpZone.hi + SDL.tpBuf
    if (tp >= entry) return null
  } else {
    const zt = Zs.filter((z) => z.hi >= ext && cj.c > z.lo)
    if (zt.length === 0) return null
    zone = pick(zt, (x, b) => x.hi < b.hi)
    entry = cj.c + spread
    sl = ext - SDL.slBuf
    const above = Zs.filter((z) => z.lo > entry)
    if (above.length === 0) return null
    tpZone = pick(above, (x, b) => x.lo < b.lo)
    tp = tpZone.lo - SDL.tpBuf
    if (tp <= entry) return null
  }
  const entryInZone = Zs.filter((z) => z.lo <= entry && entry <= z.hi && z.id !== zone.id).map((z) => z.id)
  const risk = Math.abs(entry - sl)
  return {
    day: ctx.day,
    side,
    biasAt: rep.at,
    fvgA: a.t,
    fvgI: c.t,
    gap,
    fvgLo: side === 'SHORT' ? a.h : c.h,
    fvgHi: side === 'SHORT' ? c.l : a.l,
    ext,
    extT,
    zone,
    entryCandle: cj.t,
    entryT: tclose,
    entry,
    close: cj.c,
    spread,
    sl,
    tp,
    tpZone,
    entryInZone,
    risk,
    rr: Math.abs(tp - entry) / risk,
  }
}

// ─── Canlı kurallar ────────────────────────────────────────────────────────────────────────────────────────────
// Haberin etkisi: [haber − 1 saat, haber + 30 dk) içinde yeni işlem yok. Dönen değer engelleyen haberin anı.
export function newsBlock(events: number[], t: number): number | null {
  for (const e of events) if (t >= e - SDL.newsBeforeMs && t < e + SDL.newsAfterMs) return e
  return null
}

export type Verdict =
  | { ok: true }
  | { ok: false; reason: 'hafta_sonu' | 'donusum' | 'haber'; detail?: Record<string, unknown> }

// Kurulumun işleme dönüşmesi için kalan kurallar (emir kapısının lot ve anahtar kuralları hariç).
export function verdict(c: Candidate, breaks: Map<number, Break[]>, news: number[]): Verdict {
  if (istWeekday(c.entryT) >= 6) return { ok: false, reason: 'hafta_sonu' }
  if (!flipOk(breaks.get(c.zone.id), c.side, c.entryT)) {
    const lb = lastBreak(breaks.get(c.zone.id), c.entryT)
    return { ok: false, reason: 'donusum', detail: { sonKirilma: lb ? { t: lb.t, yon: lb.dir } : null } }
  }
  const e = newsBlock(news, c.entryT)
  if (e !== null) return { ok: false, reason: 'haber', detail: { haber: e } }
  return { ok: true }
}

// ─── Çıkış benzetimi ───────────────────────────────────────────────────────────────────────────────────────────
// m1[k0..] mumlarında ilk SL ya da TP. k0: girişten (3m kapanışı) sonraki ilk 1m mumu.
export function simExit(m1: Bar[], k0: number, side: Side, sl: number, tp: number): Exit | null {
  for (let k = k0; k < m1.length; k++) {
    const c = m1[k]!
    const sp = (c.sp ?? SDL.spreadDefaultPts) * SDL.point
    let hitSl: boolean, hitTp: boolean
    if (side === 'SHORT') {
      hitSl = c.h + sp >= sl
      hitTp = c.l + sp <= tp
    } else {
      hitSl = c.l <= sl
      hitTp = c.h >= tp
    }
    if (hitSl && hitTp) return { t: c.t, kind: 'SL', price: sl, ambiguous: true }
    if (hitSl) return { t: c.t, kind: 'SL', price: sl, ambiguous: false }
    if (hitTp) return { t: c.t, kind: 'TP', price: tp, ambiguous: false }
  }
  return null
}

export function firstIndexAtOrAfter(m1: Bar[], t: number): number {
  let lo = 0
  let hi = m1.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (m1[mid]!.t < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

export const rMultiple = (side: Side, entry: number, risk: number, price: number) =>
  (side === 'SHORT' ? entry - price : price - entry) / risk

// ─── Toplu tarama (yeniden oynatma ve doğrulama) ───────────────────────────────────────────────────────────────
export type ScanInput = {
  m1: Bar[] // bütün dönem, açılış sırasıyla
  c4: Bar4[] // 4h, zonların oluşmasından önceden başlamalı (ATR ısınması)
  dailyDays: Set<string> // günlük mumu olan İstanbul günleri (araştırmadaki gibi: önceki günün mumu yoksa gün atlanır)
  zones: Zone[]
  bias: Map<string, BiasReport[]> // run_date → zaman sırasıyla raporlar
  news: number[]
  days?: string[] // verilmezse bias'ı olan günler
}

export type ScanRow = {
  c: Candidate
  v: Verdict
  exit: Exit | null
  r: number | null
}

export function scan(input: ScanInput): ScanRow[] {
  const m3 = build3(input.m1)
  const atr = wilderAtr(input.c4)
  const breaks = new Map(input.zones.map((z) => [z.id, zoneBreaks(z, input.c4, atr)]))
  const days = input.days ?? [...input.bias.keys()].sort()
  const out: ScanRow[] = []
  for (const day of days) {
    const reps = input.bias.get(day)
    if (!reps || reps.length === 0) continue
    if (!input.dailyDays.has(prevDay(day))) continue
    const D0 = istDayStart(day)
    const c3 = m3.filter((c) => c.t >= D0 && c.t < D0 + DAY)
    const ctx: DayContext = { day, c3, zones: input.zones, bias: reps }
    for (let j = 2; j < c3.length; j++) {
      const c = candidateAt(ctx, j)
      if (!c) continue
      const v = verdict(c, breaks, input.news)
      const exit = simExit(input.m1, firstIndexAtOrAfter(input.m1, c.entryT), c.side, c.sl, c.tp)
      out.push({ c, v, exit, r: exit ? rMultiple(c.side, c.entry, c.risk, exit.price) : null })
    }
  }
  return out
}
