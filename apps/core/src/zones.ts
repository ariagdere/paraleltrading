// Destek/direnç bölgeleri: saf hesap (veritabanından bağımsız). Kayıt apps/core/src/sr.ts'te.
//
// Bölge = fiyatın birçok kez döndüğü ya da kapandığı fiyat aralığı. Kanıtlar ("izler") üç dilimden gelir:
//   4h dönüşleri (2 mum sağında ve solunda daha uç mum olmayan, ardından en az 1 ATR tepki veren tepe/dip),
//   günlük tepe, dip ve kapanışlar, haftalık tepe, dip ve kapanışlar.
// Her iz bilindiği andan (dönüşün onaylandığı, günün ya da haftanın kapandığı an) itibaren sayılır ve zamanla
// zayıflar (yarı ömür). Fiyat ekseninde izlerin yoğunluğu hesaplanır; yoğunluğun tepeleri bölgelerdir.
// Bölgenin bandı oluştuğu anda belirlenir ve bir daha değişmez; gücü her zaman kendi bandındaki izlerin o anki
// ağırlığıdır. Kırılma (kapanış bandın öbür yanında) bölgeyi bitirmez, rolünü çevirir; breakWear < 1 ise bant
// içindeki izler de aşınır (varsayılan 1: aşınma yok). Bölge, kendi bandının puanı sürdürme eşiğinin altına inince
// ya da daha güçlü bir bölgeyle örtüşünce biter.
//
// Hesap 4h kapanışlarında, yalnız o ana kadar bilinenle yapılır (as-of). Ardışık hesaplarda örtüşen bölgeler aynı
// bölgedir; böylece her bölgenin oluştuğu ve bittiği an ve aradaki testler kayda geçer.
//
// Gösterilecekler de her 4h kapanışında seçilir: fiyatın ±showWindowPct'sinde, üstte ve altta en güçlü showN bölge
// ve fiyatın içinde olduğu bölge. Gösterilen bir bölgenin yerine ancak (1 + showHys) kat güçlü bir bölge geçer;
// böylece küme her kapanışta yer değiştirmez.
//
// v2'den farkı (16 Ekim, Ari "bölgeler genişleyip daralıyor, fiyat aralığının her yeri bölge"): bant sabit (v2'de
// bölgelerin yarısının bandı ömrü boyunca değişiyordu), çekirdek 0,15 yerine 0,10 ATR (bantlar daha dar: ±%5
// aralığın %38'i yerine gösterilenlerle %18–20'si kaplı) ve ekranda yalnız 3 + 3 bölge. Ari'nin 12 Ekim çizimiyle o
// an gösterilen 6 bölgeden 4–5'i aynı; ölçümler proje dokümanında (claude/destek-direnc-prototipi.md).

// Algoritma ya da DEFAULTS değişince sürüm de değişmeli (kayıtlar sürümle tutulur).
export const SR_VERSION = 'v3'

export type Candle = { t: number; o: number; h: number; l: number; c: number }

export type Params = {
  pivotK: number // 4h dönüşü: solunda ve sağında bu kadar mum daha uç değil
  pivotReactAtr: number // dönüşten sonra en az bu kadar ATR tepki ...
  pivotReactBars: number // ... şu kadar mum içinde
  w4: number // 4h dönüşü ağırlığı
  w1dHL: number // günlük tepe/dip
  w1dC: number // günlük kapanış
  w1w: number // haftalık tepe/dip/kapanış
  hl4: number // yarı ömür (gün)
  hl1d: number
  hl1w: number
  sigmaAtr: number // yoğunluk çekirdeği genişliği (4h ATR cinsinden)
  edge: number // bant: yoğunluğun tepe değerinin bu oranına kadar
  maxHalfWidthAtr: number // bant tepeden en çok bu kadar uzanır
  minHalfWidthAtr: number
  nmsAtr: number // iki bölgenin merkezleri arasında en az bu kadar ATR
  createScore: number // yeni bölge için en düşük puan
  keepScore: number // var olan bölge bu puanın altına inince biter
  breakAtr: number // kapanış bandın öbür yanında en az bu kadar → kırılma
  breakWear: number // kırılınca bant içindeki izlerin ağırlığı bu oranla çarpılır
  touchAwayAtr: number // iki test arasında en az bu kadar uzaklaşma
  holdAtr: number // testten sonra bu kadar uzaklaşırsa "tuttu"
  windowPct: number // hesap fiyatın ± bu yüzdesinde
  showN: number // fiyatın üstünde ve altında gösterilecek bölge
  showWindowPct: number // gösterilecekler fiyatın ± bu yüzdesinden
  showHys: number // gösterilen bölgenin yerine ancak (1 + showHys) kat güçlü bölge geçer
}

export const DEFAULTS: Params = {
  pivotK: 2,
  pivotReactAtr: 1.0,
  pivotReactBars: 12,
  w4: 1.0,
  w1dHL: 0.5,
  w1dC: 0.5,
  w1w: 1.5,
  hl4: 21,
  hl1d: 30,
  hl1w: 120,
  sigmaAtr: 0.1,
  edge: 0.6,
  maxHalfWidthAtr: 0.5,
  minHalfWidthAtr: 0.08,
  nmsAtr: 0.8,
  createScore: 3.0,
  keepScore: 2.0,
  breakAtr: 0.15,
  breakWear: 1,
  touchAwayAtr: 0.6,
  holdAtr: 1.0,
  windowPct: 15,
  showN: 3,
  showWindowPct: 5,
  showHys: 1,
}

export type TraceKind = '4h tepe' | '4h dip' | '1d tepe' | '1d dip' | '1d kapanış' | '1w tepe' | '1w dip' | '1w kapanış'
export type Trace = { id: number; price: number; kind: TraceKind; tf: '4h' | '1d' | '1w'; at: number; src: number; w: number; wear: number }

export type EventKind = 'created' | 'touch' | 'hold' | 'break' | 'ended' | 'shown' | 'hidden'
export type ZoneEvent = { t: number; kind: EventKind; price: number; lo: number; hi: number; score: number; note?: string }

export type Zone = {
  id: number
  lo: number
  hi: number
  score: number
  mix: Record<'4h' | '1d' | '1w', number> // puanın dilimlere dağılımı
  createdAt: number
  endedAt: number | null
  endReason: string | null
  touches: number
  holds: number
  breaks: number
  shown: boolean // şu an gösterilenlerden
  events: ZoneEvent[]
  scores: Array<[number, number]> // puan geçmişi (değiştikçe; as-of görünüm için)
}

const DAY = 86_400_000
const H4 = 4 * 3_600_000
const WEEK = 7 * DAY

export function atrSeries(c: Candle[], len = 14): Array<number | null> {
  const out: Array<number | null> = new Array(c.length).fill(null)
  let atr = 0
  for (let i = 0; i < c.length; i++) {
    const k = c[i]!
    const tr = i === 0 ? k.h - k.l : Math.max(k.h - k.l, Math.abs(k.h - c[i - 1]!.c), Math.abs(k.l - c[i - 1]!.c))
    if (i < len) {
      atr += tr
      if (i === len - 1) out[i] = atr /= len
    } else out[i] = atr = (atr * (len - 1) + tr) / len
  }
  return out
}

// Günlük mumlardan haftalık (pazartesi başlangıçlı). offsetMs: haftanın başlangıcının UTC'den farkı
// (Binance UTC: 0; Axi İstanbul: günler 21:00 UTC'de açılır, 3 sa).
export function weekly(daily: Candle[], offsetMs: number): Candle[] {
  const out: Candle[] = []
  const MON = 4 * DAY
  for (const d of daily) {
    const wk = Math.floor((d.t + offsetMs - MON) / WEEK) * WEEK + MON - offsetMs
    const last = out[out.length - 1]
    if (last && last.t === wk) {
      last.h = Math.max(last.h, d.h)
      last.l = Math.min(last.l, d.l)
      last.c = d.c
    } else out.push({ t: wk, o: d.o, h: d.h, l: d.l, c: d.c })
  }
  return out
}

// Bütün izler ve bilindikleri an. 4h dönüşü, tepki eşiği aşıldığında bilinir (en erken K mum sonra).
export function buildTraces(c4: Candle[], d1: Candle[], w1: Candle[], p: Params): Trace[] {
  const atr = atrSeries(c4)
  const out: Trace[] = []
  let id = 0
  for (let j = p.pivotK; j < c4.length - p.pivotK; j++) {
    const a = atr[j]
    if (a === null) continue
    const cj = c4[j]!
    let low = true
    let high = true
    for (let m = j - p.pivotK; m <= j + p.pivotK; m++) {
      if (m === j) continue
      if (c4[m]!.l <= cj.l) low = false
      if (c4[m]!.h >= cj.h) high = false
    }
    for (const side of ['dip', 'tepe'] as const) {
      if ((side === 'dip' && !low) || (side === 'tepe' && !high)) continue
      const px = side === 'dip' ? cj.l : cj.h
      let known: number | null = null
      for (let m = j + 1; m <= Math.min(c4.length - 1, j + p.pivotReactBars); m++) {
        const k = c4[m]!
        if (side === 'dip' ? k.l < px : k.h > px) break // uç aşıldı: dönüş değil
        if ((side === 'dip' ? k.h - px : px - k.l) >= p.pivotReactAtr * a) {
          known = Math.max(k.t, c4[j + p.pivotK]!.t) + H4
          break
        }
      }
      if (known === null) continue
      out.push({ id: id++, price: px, kind: side === 'dip' ? '4h dip' : '4h tepe', tf: '4h', at: known, src: cj.t, w: p.w4, wear: 1 })
    }
  }
  for (const d of d1) {
    const at = d.t + DAY
    out.push({ id: id++, price: d.h, kind: '1d tepe', tf: '1d', at, src: d.t, w: p.w1dHL, wear: 1 })
    out.push({ id: id++, price: d.l, kind: '1d dip', tf: '1d', at, src: d.t, w: p.w1dHL, wear: 1 })
    out.push({ id: id++, price: d.c, kind: '1d kapanış', tf: '1d', at, src: d.t, w: p.w1dC, wear: 1 })
  }
  for (const w of w1) {
    const at = w.t + WEEK
    out.push({ id: id++, price: w.h, kind: '1w tepe', tf: '1w', at, src: w.t, w: p.w1w, wear: 1 })
    out.push({ id: id++, price: w.l, kind: '1w dip', tf: '1w', at, src: w.t, w: p.w1w, wear: 1 })
    out.push({ id: id++, price: w.c, kind: '1w kapanış', tf: '1w', at, src: w.t, w: p.w1w, wear: 1 })
  }
  return out.sort((a, b) => a.at - b.at)
}

const halfLife = (tr: Trace, p: Params) => (tr.tf === '4h' ? p.hl4 : tr.tf === '1d' ? p.hl1d : p.hl1w)
export const traceWeight = (tr: Trace, t: number, p: Params) => tr.w * tr.wear * 0.5 ** ((t - tr.at) / DAY / halfLife(tr, p))

type Peak = { lo: number; hi: number; center: number; score: number; mix: Record<'4h' | '1d' | '1w', number> }

// t anındaki bütün yoğunluk tepeleri, puan sırasıyla (komşu bastırması run'da: var olan bölgeler öncelikli).
export type Live = { price: number; w: number; tf: '4h' | '1d' | '1w' }

export function peaksAt(traces: Trace[], t: number, price: number, atr: number, p: Params, liveOut?: Live[]): Peak[] {
  const sigma = p.sigmaAtr * atr
  const lo = price * (1 - p.windowPct / 100)
  const hi = price * (1 + p.windowPct / 100)
  const step = sigma / 4
  const n = Math.ceil((hi - lo) / step) + 1
  const dens = new Float64Array(n)
  const live: Live[] = liveOut ?? []
  for (const tr of traces) {
    if (tr.at > t) break
    if (tr.price < lo - 4 * sigma || tr.price > hi + 4 * sigma) continue
    const w = traceWeight(tr, t, p)
    if (w < 0.02) continue
    live.push({ price: tr.price, w, tf: tr.tf })
    const i0 = Math.max(0, Math.floor((tr.price - 4 * sigma - lo) / step))
    const i1 = Math.min(n - 1, Math.ceil((tr.price + 4 * sigma - lo) / step))
    for (let i = i0; i <= i1; i++) {
      const x = (lo + i * step - tr.price) / sigma
      dens[i]! += w * Math.exp(-0.5 * x * x)
    }
  }
  const peaks: Peak[] = []
  for (let i = 1; i < n - 1; i++) {
    if (!(dens[i]! > dens[i - 1]! && dens[i]! >= dens[i + 1]!)) continue
    const top = dens[i]!
    let a = i
    while (a > 0 && dens[a - 1]! >= top * p.edge && dens[a - 1]! <= dens[a]!) a--
    let b = i
    while (b < n - 1 && dens[b + 1]! >= top * p.edge && dens[b + 1]! <= dens[b]!) b++
    const center = lo + i * step
    const half = (x: number) => Math.min(Math.max(x, p.minHalfWidthAtr * atr), p.maxHalfWidthAtr * atr)
    const zlo = center - half(center - (lo + a * step))
    const zhi = center + half(lo + b * step - center)
    const mix = { '4h': 0, '1d': 0, '1w': 0 }
    for (const x of live) if (x.price >= zlo - sigma / 2 && x.price <= zhi + sigma / 2) mix[x.tf] += x.w
    peaks.push({ lo: zlo, hi: zhi, center, score: mix['4h'] + mix['1d'] + mix['1w'], mix })
  }
  return peaks.sort((x, y) => y.score - x.score)
}

type Contact = { side: 'above' | 'below'; armed: boolean; touchAt: number | null }

export type Run = { zones: Zone[]; traces: Trace[] }

// 4h mumlarıyla ilerleyen as-of hesap. d1 ve w1 kapanmış mumlar; her 4h kapanışında yalnız o ana kadar
// kapanmış gün/hafta izleri sayılır.
export function run(c4: Candle[], d1: Candle[], w1: Candle[], p: Params, from = 0, to = Infinity): Run {
  const traces = buildTraces(c4, d1, w1, p)
  const atr = atrSeries(c4)
  const zones: Zone[] = []
  const active: Zone[] = []
  const contact = new Map<number, Contact>()
  let seq = 0
  const ev = (z: Zone, t: number, kind: EventKind, price: number, note?: string) => z.events.push({ t, kind, price, lo: z.lo, hi: z.hi, score: z.score, note })

  for (let i = 0; i < c4.length; i++) {
    const k = c4[i]!
    const now = k.t + H4
    const a = atr[i]
    if (a === null || now < from || now > to) continue

    // 1) Etkin bölgelerle bu mumun ilişkisi.
    for (const z of active) {
      const st = contact.get(z.id)!
      const overlaps = k.l <= z.hi && k.h >= z.lo
      if (overlaps && st.armed) {
        z.touches++
        st.armed = false
        st.touchAt = now
        ev(z, now, 'touch', st.side === 'above' ? k.l : k.h, st.side === 'above' ? 'yukarıdan' : 'aşağıdan')
      }
      if (st.side === 'above' && k.c < z.lo - p.breakAtr * a) {
        z.breaks++
        st.side = 'below'
        st.armed = false
        st.touchAt = null
        wear(z, now)
        ev(z, now, 'break', k.c, 'aşağı kırıldı; destek dirence döndü')
      } else if (st.side === 'below' && k.c > z.hi + p.breakAtr * a) {
        z.breaks++
        st.side = 'above'
        st.armed = false
        st.touchAt = null
        wear(z, now)
        ev(z, now, 'break', k.c, 'yukarı kırıldı; direnç desteğe döndü')
      }
      const near = st.side === 'above' ? k.l - z.hi : z.lo - k.h
      const far = st.side === 'above' ? k.h - z.hi : z.lo - k.l
      if (near >= p.touchAwayAtr * a) st.armed = true
      if (st.touchAt !== null && far >= p.holdAtr * a) {
        z.holds++
        st.touchAt = null
        ev(z, now, 'hold', st.side === 'above' ? k.h : k.l, `${(far / a).toFixed(1)} ATR uzaklaştı`)
      }
    }

    // 2) Yoğunluk tepeleri ve bölgelerin sürekliliği. Var olan bölge kendi bandındaki izlerle sürer; ona denk gelen
    // tepe yeni bölge açmaz. İzleri sürdürme eşiğinin altına inince ya da bandı daha güçlü bir bölgeninkiyle
    // örtüşünce biter. Yeni tepeler yalnız çevrelerinde bölge yoksa açılır.
    const live: Live[] = []
    const peaks = peaksAt(traces, now, k.c, a, p, live)
    const sigma = p.sigmaAtr * a
    const own = (lo: number, hi: number) => {
      const mix = { '4h': 0, '1d': 0, '1w': 0 }
      for (const x of live) if (x.price >= lo - sigma / 2 && x.price <= hi + sigma / 2) mix[x.tf] += x.w
      return { score: mix['4h'] + mix['1d'] + mix['1w'], mix }
    }
    const used = new Set<Peak>()
    const kept: Zone[] = []
    const overlapsKept = (lo: number, hi: number) => kept.some((o) => lo <= o.hi && hi >= o.lo)
    for (const z of [...active].sort((x, y) => y.score - x.score)) {
      let best: Peak | null = null
      let bestOv = -Infinity
      for (const pk of peaks) {
        if (used.has(pk)) continue
        const ov = Math.min(z.hi, pk.hi) - Math.max(z.lo, pk.lo)
        const close = Math.abs((z.lo + z.hi) / 2 - pk.center) < 0.5 * p.nmsAtr * a
        if ((ov > 0 || close) && ov > bestOv) {
          best = pk
          bestOv = ov
        }
      }
      const last = z.scores[z.scores.length - 1]![1]
      const o = own(z.lo, z.hi)
      if (o.score >= p.keepScore && !overlapsKept(z.lo, z.hi)) {
        if (best) used.add(best)
        z.score = o.score
        z.mix = o.mix
      } else {
        z.endedAt = now
        z.endReason = o.score < p.keepScore ? 'izler zayıfladı' : 'daha güçlü bir bölgeyle örtüştü'
        z.score = o.score
        z.shown = false
        z.scores.push([now, z.score])
        ev(z, now, 'ended', k.c, z.endReason)
        contact.delete(z.id)
        continue
      }
      if (Math.abs(z.score - last) > 0.15 * last) z.scores.push([now, z.score])
      kept.push(z)
    }
    active.length = 0
    active.push(...kept)
    for (const pk of peaks) {
      if (used.has(pk) || pk.score < p.createScore) continue
      if (active.some((z) => Math.abs((z.lo + z.hi) / 2 - pk.center) < p.nmsAtr * a || (pk.lo <= z.hi && pk.hi >= z.lo))) continue
      const z: Zone = {
        id: ++seq,
        lo: pk.lo,
        hi: pk.hi,
        score: pk.score,
        mix: pk.mix,
        createdAt: now,
        endedAt: null,
        endReason: null,
        touches: 0,
        holds: 0,
        breaks: 0,
        shown: false,
        events: [],
        scores: [[now, pk.score]],
      }
      ev(z, now, 'created', k.c)
      zones.push(z)
      active.push(z)
      const side = k.c >= (z.lo + z.hi) / 2 ? 'above' : 'below'
      const dist = side === 'above' ? k.l - z.hi : z.lo - k.h
      contact.set(z.id, { side, armed: dist >= p.touchAwayAtr * a, touchAt: null })
    }

    // 3) Gösterilecekler.
    const show = pickShown(active, k.c, p)
    for (const z of active) {
      const on = show.has(z)
      if (on === z.shown) continue
      z.shown = on
      ev(z, now, on ? 'shown' : 'hidden', k.c)
    }
  }

  // Kırılma aşınması: bant içindeki ve o ana kadar bilinen izler zayıflar (sonra gelen izler etkilenmez).
  function wear(z: Zone, now: number) {
    for (const tr of traces) {
      if (tr.at > now) break
      if (tr.price >= z.lo && tr.price <= z.hi) tr.wear *= p.breakWear
    }
  }

  return { zones, traces }
}

// Fiyatın ±showWindowPct'sinde, üstte ve altta en güçlü showN bölge ve fiyatın içinde olduğu bölge. Şu an gösterilen
// bölge sıralamada (1 + showHys) katı güçle yarışır; eşitlikte önce açılan.
export function pickShown(active: Zone[], px: number, p: Params): Set<Zone> {
  const near = active.filter((z) => z.hi >= px * (1 - p.showWindowPct / 100) && z.lo <= px * (1 + p.showWindowPct / 100))
  const rank = (z: Zone) => z.score * (z.shown ? 1 + p.showHys : 1)
  const top = (list: Zone[]) => list.sort((x, y) => rank(y) - rank(x) || x.id - y.id).slice(0, p.showN)
  return new Set([...top(near.filter((z) => z.lo > px)), ...top(near.filter((z) => z.hi < px)), ...near.filter((z) => z.lo <= px && z.hi >= px)])
}
