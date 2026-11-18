import type { Candle, ChartExit, ChartSetup } from '@/lib/sdl-chart-shared'

// SDL kurulum grafiği (SVG, tarayıcıda çizilir): araştırma sayfasındaki çizimin ("SDL v3 Örnek Trade",
// claude/sdl-v3-ornek-trade.md, TradingView görünümü) karşılığı. Girişten çıkışa TradingView'daki pozisyon aracı:
// giriş–hedef arası yeşil, giriş–stop arası kırmızı, sağ eksende hedef, giriş ve stop etiketleri; FVG kutusu, iğne,
// zonlar; geniş 3m grafikte 1 iğne, 2 FVG, 3 giriş rozetleri; mumun üstünde imleç ve ipucu (ok tuşlarıyla da).
// Bekleyen kurulumda giriş henüz yok: FVG kutusu ve kesik tetik çizgisi son muma kadar, planlanan pozisyon sağdaki boş
// alanda (soluk), 3 rozeti tetikte. Mumların yeri zamandan: veri boşluğu varsa boş kalır.
// Sınıflar setup-chart.module.css'te (:global, grafik kutusunun altında).

const NS = 'http://www.w3.org/2000/svg'
const H = 3_600_000
const MIN = 60_000
const DAYS = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt']
const MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara']

type Attrs = Record<string, string | number>

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag)
  for (const k in attrs) e.setAttribute(k, String(attrs[k]))
  if (parent) parent.appendChild(e)
  return e
}

function text(parent: Element, x: number, y: number, s: string, cls = 'lab', anchor = 'start') {
  const t = el('text', { x, y, class: cls, 'text-anchor': anchor }, parent)
  t.textContent = s
  return t
}

export const fmt = (n: number, d = 0) => n.toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d })
export const sgn = (n: number, d = 2) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n), d)
const ist = (t: number) => new Date(t + 3 * H)
export function hhmm(t: number) {
  const d = ist(t)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
export function dayLabel(t: number, short = false) {
  const d = ist(t)
  return short ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}
export const resWord = (k: ChartExit['kind']) => (k === 'TP' ? 'hedef' : k === 'SL' ? 'stop' : k === 'MANUEL' ? 'kapandı' : 'açık')
const resCls = (x: ChartExit) => (x.kind === 'TP' ? 'tp' : x.kind === 'SL' ? 'sl' : x.kind === 'MANUEL' ? (x.r >= 0 ? 'tp' : 'sl') : 'open')

function drawCandles(g: Element, C: Candle[], x: (i: number) => number, y: (p: number) => number, bodyW: number) {
  // Mumlar çok sıkışınca (uzun işlemde 3m) gövde çizilmez, yalnız yüksek–düşük çizgisi
  const dense = bodyW < 1.6
  C.forEach((c, i) => {
    const cls = c.c >= c.o ? 'c-up' : 'c-down'
    const cx = x(i)
    if (dense) {
      el('line', { x1: cx, x2: cx, y1: y(c.h), y2: Math.max(y(c.l), y(c.h) + 1), class: cls, 'stroke-width': Math.max(0.8, bodyW * 1.2) }, g)
      return
    }
    el('line', { x1: cx, x2: cx, y1: y(c.h), y2: y(c.l), class: `${cls} c-wick` }, g)
    const top = y(Math.max(c.o, c.c))
    const bot = y(Math.min(c.o, c.c))
    el('rect', { x: cx - bodyW / 2, y: top, width: bodyW, height: Math.max(1.2, bot - top), rx: Math.min(2, bodyW / 4), class: cls }, g)
  })
}

function badge(svg: Element, cx: number, cy: number, k: number) {
  el('circle', { cx, cy, r: 9, class: 'step-c' }, svg)
  text(svg, cx, cy + 4, String(k), 'step', 'middle')
}

function row(tip: HTMLElement, a: string, b: string) {
  const d = document.createElement('div')
  d.className = 'r'
  const s1 = document.createElement('span')
  s1.textContent = a
  const s2 = document.createElement('span')
  s2.textContent = b
  d.append(s1, s2)
  tip.appendChild(d)
}

type HoverOpts = {
  W: number
  padL: number
  padT: number
  pw: number
  ph: number
  n: number
  xi: (i: number) => number
  pick: (px: number) => number
  focus: number
  render: (tip: HTMLElement, i: number) => void
  label: string
}

// İmleç ve ipucu: muma göre; klavyeyle ok tuşları.
function hover(host: HTMLElement, svg: SVGSVGElement, o: HoverOpts) {
  const tip = document.createElement('div')
  tip.className = 'tip'
  tip.hidden = true
  host.appendChild(tip)
  const cross = el('line', { x1: 0, x2: 0, y1: o.padT, y2: o.padT + o.ph, class: 'cross', visibility: 'hidden' }, svg)
  const hit = el('rect', { x: o.padL, y: o.padT, width: o.pw, height: o.ph, fill: 'transparent', tabindex: 0, 'aria-label': o.label }, svg)
  let cur = -1
  const show = (i: number) => {
    if (i < 0 || i >= o.n) return
    cur = i
    const x = o.xi(i)
    cross.setAttribute('x1', String(x))
    cross.setAttribute('x2', String(x))
    cross.setAttribute('visibility', 'visible')
    tip.textContent = ''
    o.render(tip, i)
    tip.hidden = false
    const tw = tip.offsetWidth
    let left = x + 14
    if (left + tw > o.W - 4) left = x - 14 - tw
    tip.style.left = `${Math.max(0, left)}px`
    tip.style.top = `${o.padT + 8}px`
  }
  const hide = () => {
    cross.setAttribute('visibility', 'hidden')
    tip.hidden = true
  }
  const at = (e: PointerEvent) => {
    const r = svg.getBoundingClientRect()
    return o.pick((e.clientX - r.left) * (o.W / r.width))
  }
  hit.addEventListener('pointermove', (e) => show(at(e)))
  hit.addEventListener('pointerleave', hide)
  hit.addEventListener('blur', hide)
  hit.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') {
      show(Math.min(o.n - 1, cur + 1))
      e.preventDefault()
    } else if (e.key === 'ArrowLeft') {
      show(Math.max(0, cur < 0 ? o.n - 1 : cur - 1))
      e.preventDefault()
    } else if (e.key === 'Escape') hide()
  })
  hit.addEventListener('focus', () => show(cur < 0 ? o.focus : cur))
}

function candleTip(C: Candle[], tf: number) {
  return (tip: HTMLElement, i: number) => {
    const c = C[i]!
    const s = document.createElement('strong')
    s.textContent = `${dayLabel(c.t)} · ${hhmm(c.t)}–${hhmm(c.t + tf)}`
    tip.appendChild(s)
    row(tip, 'Açılış', fmt(c.o, 2))
    row(tip, 'Yüksek', fmt(c.h, 2))
    row(tip, 'Düşük', fmt(c.l, 2))
    row(tip, 'Kapanış', fmt(c.c, 2))
  }
}

function niceStep(range: number, px: number, minPx: number) {
  const c = [25, 50, 100, 200, 250, 500, 1000, 2000, 5000]
  for (const s of c) if (px / (range / s) >= minPx) return s
  return c[c.length - 1]!
}

function timeTicks(t0: number, t1: number, pw: number, narrow: boolean) {
  const span = t1 - t0
  const minGap = narrow ? 58 : 76
  const steps = [15, 30, 60, 120, 180, 360, 720, 1440, 2880].map((m) => m * MIN)
  const st = steps.find((s) => pw / (span / s) >= minGap) ?? steps[steps.length - 1]!
  const out: number[] = []
  const first = Math.ceil((t0 + 3 * H) / st) * st - 3 * H
  for (let t = first; t <= t1; t += st) out.push(t)
  return out
}

// 'A' 3 dakikalık giriş (ve çıkış), 'B' geniş görünüm. future: bekleyende son mumdan sonraki boş mum yeri.
export function drawSetup(host: HTMLElement, T: ChartSetup, C: Candle[], tfMin: number, mode: 'A' | 'B', future: number, uid: string) {
  host.textContent = ''
  if (C.length === 0) return
  const W = Math.max(300, host.clientWidth)
  const narrow = W < 680
  const Hh = narrow ? 380 : 470
  const padL = 6
  const padR = narrow ? 64 : 124
  const padT = 18
  const padB = 28
  const pw = W - padL - padR
  const ph = Hh - padT - padB
  const P = T.kind === 'bekleyen'
  const X = T.exit
  const n = C.length
  const tf = tfMin * MIN
  const t0 = C[0]!.t
  const tEnd = C[n - 1]!.t + tf + (P ? future * tf : 0)
  const slot = pw / ((tEnd - t0) / tf)
  const xt = (t: number) => padL + ((t - t0) / tf) * slot
  const xc = (i: number) => xt(C[i]!.t) + slot / 2 // mumun ortası
  const xAt = (t: number) => xt(t0 + Math.floor((t - t0) / tf) * tf) + slot / 2 // t'yi içeren mumun ortası
  const inWin = (t: number) => t >= t0 && t < tEnd
  const zE = T.zones.find((z) => z.role === 'entry')
  const zT = T.zones.find((z) => z.role === 'target')
  let cLo = Infinity
  let cHi = -Infinity
  for (const c of C) {
    cLo = Math.min(cLo, c.l)
    cHi = Math.max(cHi, c.h)
  }
  // Short'ta hedef aşağıda, long'da yukarıda. Stop ve hedef her grafikte ölçeğe alınır.
  const L = T.side === 'LONG'
  let lo = Math.min(cLo, T.entry, T.sl, T.ext, T.tp)
  let hi = Math.max(cHi, T.entry, T.sl, T.ext, T.tp)
  if (T.trigger !== null) {
    lo = Math.min(lo, T.trigger)
    hi = Math.max(hi, T.trigger)
  }
  if (zE && zE.lo > lo - 400) lo = Math.min(lo, zE.lo)
  if (zE && zE.hi < hi + 400) hi = Math.max(hi, zE.hi)
  if (zT) {
    if (L && zT.hi < hi + 150) hi = Math.max(hi, zT.hi)
    if (!L && zT.lo > lo - 150) lo = Math.min(lo, zT.lo)
  }
  const padY = (hi - lo) * 0.05 + 15
  const yMin = lo - padY
  const yMax = hi + padY
  const y = (p: number) => padT + ((yMax - p) / (yMax - yMin)) * ph
  const yTP = y(T.tp)
  const yE0 = y(T.entry)
  // Eksen etiketleri (hedef yeşil, giriş gri, stop kırmızı); birbirine binmesin diye en az 19 px aralık, taşarsa hepsi yukarı
  const axTags = [
    { p: T.tp, k: 'tp', y: 0 },
    { p: T.entry, k: 'en', y: 0 },
    { p: T.sl, k: 'sl', y: 0 },
  ]
    .map((a) => ({ ...a, y: y(a.p) }))
    .sort((a, b) => a.y - b.y)
  for (let q = 1; q < axTags.length; q++) if (axTags[q]!.y - axTags[q - 1]!.y < 19) axTags[q]!.y = axTags[q - 1]!.y + 19
  const over = axTags[axTags.length - 1]!.y + 9 - (padT + ph)
  if (over > 0) for (const a of axTags) a.y -= over
  let bodyW = Math.min(12, slot * 0.56)
  if (bodyW >= 1.6) bodyW = Math.max(2, bodyW)
  const obst: Array<[number, number, number, number]> = [] // etiketlerin kaçınacağı pikseller: noktalar, rozetler, yazılar
  const ob = (x0: number, y0: number, x1: number, y1: number) => obst.push([x0, y0, x1, y1])
  const place = (yTop: number, yBot: number, w: number): number | null => {
    const pLo = yMax - ((yBot - padT) / ph) * (yMax - yMin)
    const pHi = yMax - ((yTop - padT) / ph) * (yMax - yMin)
    for (let x = padL + 4; x + w <= padL + pw - 4; x += 4) {
      const ok =
        C.every((c, i) => {
          const cx = xc(i)
          if (cx + bodyW / 2 + 3 < x || cx - bodyW / 2 - 3 > x + w) return true
          return c.h < pLo || c.l > pHi
        }) && obst.every((r) => r[2] < x || r[0] > x + w || r[3] < yTop || r[1] > yBot)
      if (ok) return x
    }
    return null
  }

  const res = P
    ? `bekleyen kurulum, tetik ${fmt(T.trigger ?? T.entry, 2)}`
    : !X
      ? 'sonuç yok'
      : X.kind === 'OPEN'
        ? `işlem açık, ${dayLabel(X.t, true)} ${hhmm(X.t)} itibarıyla ${sgn(X.r)}R`
        : `sonuç ${resWord(X.kind)}, ${sgn(X.r)}R`
  const svg = el('svg', {
    viewBox: `0 0 ${W} ${Hh}`,
    width: W,
    height: Hh,
    role: 'img',
    'aria-label': `${L ? 'Long' : 'Short'} kurulum, ${tfMin} dakikalık: zon #${T.zone}, iğne ${fmt(T.ext, 2)}, giriş ${fmt(T.entry, 2)}, stop ${fmt(T.sl, 2)}, hedef ${fmt(T.tp, 2)}; ${res}.`,
  })
  host.appendChild(svg)
  const cid = `clip-${uid}-${mode}`
  const cp = el('clipPath', { id: cid }, el('defs', {}, svg))
  el('rect', { x: padL, y: padT, width: pw, height: ph }, cp)
  const plot = el('g', { 'clip-path': `url(#${cid})` }, svg)

  for (const z of T.zones) {
    if (z.hi < yMin || z.lo > yMax) continue
    el('rect', { x: padL, y: y(z.hi), width: pw, height: y(z.lo) - y(z.hi), class: `z-${z.role}` }, plot)
    if (z.role !== 'other') {
      el('line', { x1: padL, x2: padL + pw, y1: y(z.hi), y2: y(z.hi), class: 'z-edge' }, plot)
      el('line', { x1: padL, x2: padL + pw, y1: y(z.lo), y2: y(z.lo), class: 'z-edge' }, plot)
    }
  }
  const step = niceStep(yMax - yMin, ph, narrow ? 42 : 34)
  for (let p = Math.ceil(yMin / step) * step; p <= yMax; p += step) {
    el('line', { x1: padL, x2: padL + pw, y1: y(p), y2: y(p), class: 'g-grid' }, svg)
    if (axTags.every((a) => Math.abs(y(p) - a.y) > 14)) text(svg, padL + pw + 8, y(p) + 4, fmt(p), 'g-axis')
  }

  // Pozisyon kutusu: girişten çıkışa (bekleyende listenin anından sağ kenara, soluk)
  const xE = xt(T.entryT)
  const exIn = X ? inWin(X.t) : false
  const xX = X && exIn ? xt(X.t + 30_000) : padL + pw
  const bx0 = Math.max(padL, xE)
  let bx1 = P ? padL + pw : xX
  if (bx1 - bx0 < 16) bx1 = Math.min(padL + pw, bx0 + 16)
  const xFvg = xAt(T.fvgA)
  if (mode === 'A' && inWin(T.fvgA)) {
    const fx0 = xFvg - slot * 0.45
    const fx1 = P ? bx0 : xAt(T.entryCandle ?? T.entryT - tf) + slot * 0.45
    el('rect', { x: fx0, y: y(T.fvgHi), width: Math.max(2, fx1 - fx0), height: y(T.fvgLo) - y(T.fvgHi), class: 'fvg-box' }, plot)
    ob(fx0, y(T.fvgHi) - 2, fx1, y(T.fvgLo) + 2)
  }
  el('rect', { x: bx0, y: Math.min(yE0, yTP), width: bx1 - bx0, height: Math.abs(yTP - yE0), class: P ? 'pos-tp plan' : 'pos-tp' }, plot)
  el('rect', { x: bx0, y: Math.min(yE0, y(T.sl)), width: bx1 - bx0, height: Math.abs(y(T.sl) - yE0), class: P ? 'pos-sl plan' : 'pos-sl' }, plot)
  el('line', { x1: bx0, x2: bx1, y1: yE0, y2: yE0, class: 'pos-entry' }, plot)
  if (P && T.trigger !== null) {
    const x0 = Math.max(padL, inWin(T.fvgI) ? xAt(T.fvgI) : padL)
    el('line', { x1: x0, x2: bx0, y1: y(T.trigger), y2: y(T.trigger), class: 'pos-trigger' }, plot)
  }
  drawCandles(el('g', {}, svg), C, xc, y, bodyW)

  const exitY = X ? y(X.price) : yE0
  if (!P && X) el('line', { x1: bx0, y1: yE0, x2: exIn ? xX : padL + pw, y2: exitY, class: 'pos-path' }, svg)
  if (inWin(T.extT)) {
    el('circle', { cx: xAt(T.extT), cy: y(T.ext), r: 4.5, class: 'dot wick' }, svg)
    ob(xAt(T.extT) - 8, y(T.ext) - 8, xAt(T.extT) + 8, y(T.ext) + 8)
  }
  if (!P && inWin(T.entryT - 1)) {
    el('circle', { cx: xE, cy: yE0, r: 5, class: 'dot entry' }, svg)
    ob(xE - 8, yE0 - 8, xE + 8, yE0 + 8)
  }
  if (!P && X && exIn) {
    el('circle', { cx: xX, cy: exitY, r: 5, class: `dot ${resCls(X)}` }, svg)
    ob(xX - 8, exitY - 8, xX + 8, exitY + 8)
  }

  for (const a of axTags) {
    el('rect', { x: padL + pw + 1, y: a.y - 9, width: padR - 2, height: 18, rx: 2, class: `tag-${a.k}` }, svg)
    text(svg, padL + pw + 6, a.y + 4, fmt(a.p, narrow ? 0 : 2), 'tag-t')
  }
  if (!narrow && mode === 'A' && bodyW >= 1.6) {
    const bp: Array<[number, number, number]> = []
    if (inWin(T.extT)) bp.push([xAt(T.extT) + 15, y(T.ext) + (L ? 6 : -6), 1])
    if (inWin(T.fvgA)) bp.push([xFvg, L ? y(T.fvgLo) + 14 : y(T.fvgHi) - 14, 2])
    if (!P) bp.push([xE - 14, yE0 + (L ? -18 : 18), 3])
    else if (T.trigger !== null) bp.push([bx0 - 14, y(T.trigger) + (L ? -18 : 18), 3])
    for (const b of bp) {
      badge(svg, b[0], b[1], b[2])
      ob(b[0] - 11, b[1] - 11, b[0] + 11, b[1] + 11)
    }
  }
  if (P && T.trigger !== null && !narrow) {
    const lab = `tetik ${fmt(T.trigger, 2)}${T.status === 'derin' ? ' (derin kapanış)' : ''}`
    const ly = y(T.trigger) + (L ? 15 : -7)
    text(svg, bx0 + 6, ly, lab, 'lab trig')
    ob(bx0 + 4, ly - 12, bx0 + 8 + lab.length * 7, ly + 4)
  }
  if (!P && X && X.kind === 'OPEN') {
    let rl = narrow ? 'açık' : `açık · ${dayLabel(X.t, true)} ${hhmm(X.t)} · ${sgn(X.r)}R`
    let rx: number
    let ry: number
    // etiket fiyattan uzak yanda: short'ta altta, long'da üstte
    if (exIn) {
      rx = Math.min(xX, padL + pw - 4)
      ry = exitY + (!L ? 20 : -10)
    } else {
      rl = `→ ${rl}`
      rx = padL + pw - 6
      ry = exitY + (!L ? -8 : 16)
    }
    text(svg, rx, ry, rl, 'lab open', 'end')
    ob(rx - rl.length * 7, ry - 13, rx, ry + 4)
  }

  // Hedef ve stop etiketleri pozisyon kutusunun başında; çıkış etiketi sonunda
  const dT = Math.abs(T.tp - T.entry)
  const dS = Math.abs(T.entry - T.sl)
  const pct = (d: number) => `%${fmt((d / T.entry) * 100, 2)}`
  const shortLab = narrow || mode === 'B'
  const approx = P ? '≈ ' : ''
  const tl = shortLab
    ? `Hedef ${fmt(dT)} $ · 1:${fmt(dT / dS, 2)}`
    : `Hedef ${fmt(T.tp, 2)} · ${approx}${fmt(dT, 2)} $ (${pct(dT)}) · R:R ${approx}1:${fmt(dT / dS, 2)}`
  const slb = shortLab ? `Stop ${fmt(dS)} $` : `Stop ${approx}${fmt(T.sl, 2)} · ${fmt(dS, 2)} $ (${pct(dS)})`
  const tagW = (str: string) => str.length * 6.6 + 14
  const rowY = (yy: number, up: boolean, k: number) => {
    const yt = up ? yy - 23 - k * 23 : yy + 3 + k * 23
    return Math.max(padT + 1, Math.min(padT + ph - 21, yt))
  }
  const clampX = (x: number, w: number) => Math.max(padL + 2, Math.min(padL + pw - w - 2, x))
  const tag = (x: number, yt: number, str: string, k: string, out: boolean) => {
    const w = tagW(str)
    el('rect', { x, y: yt, width: w, height: 20, rx: 3, class: out ? `res-${k}` : `tag-${k}` }, svg)
    text(svg, x + 7, yt + 14, str, out ? `lab ${k}` : 'tag-t')
    ob(x, yt, x + w, yt + 20)
    return x + w
  }
  const upT = L
  const upS = !L
  const eT = tag(clampX(bx0, tagW(tl)), rowY(yTP, upT, 0), tl, 'tp', false)
  const eS = tag(clampX(bx0, tagW(slb)), rowY(y(T.sl), upS, 0), slb, 'sl', false)
  if (!P && X && X.kind !== 'OPEN') {
    const hit = X.kind === 'TP' || (X.kind === 'MANUEL' && X.r >= 0)
    const rs = `${resWord(X.kind)} ${exIn ? hhmm(X.t) : `${dayLabel(X.t, true)} ${hhmm(X.t)}`} · ${sgn(X.r)}R`
    const wR = tagW(rs)
    const xR = clampX(bx1 - wR, wR)
    const k = xR < (hit ? eT : eS) + 6 ? 1 : 0
    tag(xR, rowY(hit ? yTP : y(T.sl), hit ? upT : upS, k), rs, hit ? 'tp' : 'sl', true)
  }

  // zon etiketleri
  const perPx = (yMax - yMin) / ph
  for (const z of [zE, zT]) {
    if (!z || z.hi < yMin + 8 * perPx || z.lo > yMax) continue
    const lab = `#${z.id}${narrow ? '' : z.role === 'entry' ? ' giriş zonu' : ' hedef zonu'}`
    const w = lab.length * 7.2 + 6
    const yt = y(Math.min(z.hi, yMax)) + 2
    const x = place(yt, yt + 16, w) ?? padL + 4
    text(svg, x + 2, yt + 13, lab, 'lab zone')
    ob(x, yt, x + w, yt + 16)
  }

  for (const t of timeTicks(t0, tEnd, pw, narrow)) {
    const x = xt(t)
    if (x < padL + 18 || x > padL + pw - 18) continue
    const d = ist(t)
    text(svg, x, padT + ph + 18, d.getUTCHours() === 0 && d.getUTCMinutes() === 0 ? dayLabel(t, true) : hhmm(t), 'g-axis', 'middle')
  }

  // ipucu: imlecin altındaki mum (gelecekteki boş alanda son mum)
  const pick = (px: number) => {
    const t = t0 + ((px - padL) / slot) * tf
    let lo2 = 0
    let hi2 = n - 1
    while (lo2 < hi2) {
      const mid = (lo2 + hi2 + 1) >> 1
      if (C[mid]!.t <= t) lo2 = mid
      else hi2 = mid - 1
    }
    return lo2
  }
  const focusT = P ? C[n - 1]!.t : (T.entryCandle ?? T.entryT - tf)
  hover(host, svg, {
    W,
    padL,
    padT,
    pw,
    ph,
    n,
    xi: xc,
    pick,
    focus: pick(xt(focusT) + 1),
    render: candleTip(C, tf),
    label: 'Mum ayrıntısı için üzerine gelin ya da ok tuşlarını kullanın',
  })
}
