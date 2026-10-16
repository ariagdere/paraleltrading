'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import type { HeatView, Span } from '@/lib/market-data'
import s from './market-chart.module.css'

// Axi mumları ve CoinGlass likidasyon heatmap'i aynı grafikte. Heatmap seviyeleri sunucuda bazla Axi fiyatına
// kaydırılmış gelir. Pencere (12h/24h/48h) adreste (?span=): seçilince sayfa o pencerenin en yeni snapshot'ıyla
// yeniden çizilir, dakikalık yenileme de aynı pencereyi getirir. Önceki ve sonraki snapshot'lar
// /api/piyasa/heatmap'ten okunur; o sırada yenileme grafiği değiştirmez.

const SPANS: Span[] = ['12h', '24h', '48h']
const H = 3_600_000
const fmtP = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 })
const fmtUsd = new Intl.NumberFormat('tr-TR', { notation: 'compact', maximumFractionDigits: 1 })
const usd = (v: number) => `${fmtUsd.format(v)} $`
const hm = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit' })
const dm = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', day: 'numeric', month: 'short' })
const dmh = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const pct = (a: number, b: number) => {
  const v = ((a - b) / b) * 100
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}%${Math.abs(v).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}`
}

type Colors = Record<'surface' | 'line' | 'text' | 'muted' | 'up' | 'down' | 'heat' | 'grid', string>

function readColors(el: Element): Colors {
  const st = getComputedStyle(el)
  const v = (n: string) => st.getPropertyValue(n).trim()
  return {
    surface: v('--ink-2'),
    line: v('--line'),
    grid: v('--ink-3'),
    text: v('--text'),
    muted: v('--muted'),
    up: v('--up'),
    down: v('--down'),
    heat: v('--heat'),
  }
}
function rgba(hex: string, a: number) {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

type Geo = {
  x: (t: number) => number
  y: (p: number) => number
  t0: number
  t1: number
  p0: number
  p1: number
  L: number
  R: number
  T: number
  B: number
}

export function MarketChart({ span: pageSpan, initial, price }: { span: Span; initial: HeatView | null; price: number | null }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [view, setView] = useState<HeatView | null>(initial)
  const [span, setSpan] = useState<Span>(pageSpan)
  const [follow, setFollow] = useState(true) // en yeni snapshot izleniyor
  const [loading, setLoading] = useState(false)
  const busy = loading || pending
  const [error, setError] = useState<string | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const base = useRef<HTMLCanvasElement>(null)
  const over = useRef<HTMLCanvasElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const geo = useRef<Geo | null>(null)
  const cache = useRef(new Map<string, HeatView>())
  const seq = useRef(0) // son okuma isteği; pencere değişir ya da en yeniye dönülürse süren okuma yok sayılır

  // en yeniye dön: süren okumayı bırak, sayfanın snapshot'ını göster, sayfayı hemen yenile (ya da pencereyi değiştir)
  const latest = useCallback(
    (sp: Span) => {
      seq.current++
      setLoading(false)
      setError(null)
      setSpan(sp)
      setFollow(true)
      startTransition(() => (sp === pageSpan ? router.refresh() : router.replace(`/piyasa?span=${sp}`, { scroll: false })))
    },
    [pageSpan, router],
  )

  // en yeni izleniyorsa sayfanın getirdiği snapshot (yenilemede ve pencere değişince); pencerede snapshot yoksa boş
  useEffect(() => {
    if (follow && pageSpan === span) setView(initial)
  }, [initial, pageSpan, follow, span])

  const load = useCallback(async (sp: Span, id: number) => {
    const n = ++seq.current
    const hit = cache.current.get(`${sp}:${id}`)
    if (hit) {
      setLoading(false)
      setView(hit)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/piyasa/heatmap?span=${sp}&id=${id}`, { cache: 'no-store' })
      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
        return
      }
      const body = await res.json()
      if (n !== seq.current) return
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
      const v = body as HeatView
      cache.current.set(`${sp}:${v.snapshot.id}`, v)
      setView(v)
    } catch (err) {
      if (n === seq.current) setError(`Heatmap okunamadı: ${(err as Error).message}`)
    } finally {
      if (n === seq.current) setLoading(false)
    }
  }, [])

  const draw = useCallback(() => {
    const cv = base.current
    const ov = over.current
    const box = wrap.current
    if (!cv || !ov || !box) return
    const W = box.clientWidth
    const Hh = box.clientHeight
    const dpr = window.devicePixelRatio || 1
    for (const c of [cv, ov]) {
      c.width = Math.round(W * dpr)
      c.height = Math.round(Hh * dpr)
    }
    const g = cv.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, W, Hh)
    const C = readColors(box)
    const font = getComputedStyle(box).fontFamily
    if (!view || view.candles.rows.length === 0) {
      geo.current = null
      return
    }
    const rows = view.candles.rows
    const tfMs = rows.length > 1 ? rows[1]![0] - rows[0]![0] : 15 * 60_000
    const grid = view.grid
    const snapAt = Date.parse(view.snapshot.at)
    const axisW = W < 560 ? 60 : 76
    const L = 2
    const R = W - axisW
    const T = 14
    const B = Hh - 24
    const t0 = Math.min(grid ? grid.cols[0]! : rows[0]![0], rows[0]![0])
    const tEnd = Math.max(rows[rows.length - 1]![0] + tfMs, grid ? grid.cols[grid.cols.length - 1]! + grid.step : 0, snapAt)
    const t1 = tEnd + (tEnd - t0) * 0.07
    let p0 = Infinity
    let p1 = -Infinity
    for (const k of rows) {
      p0 = Math.min(p0, k[3])
      p1 = Math.max(p1, k[2])
    }
    if (price !== null) {
      p0 = Math.min(p0, price)
      p1 = Math.max(p1, price)
    }
    // en yakın cluster'lar grafiğe girsin (fiyatın %6'sından uzak değilse)
    const mid = price ?? rows[rows.length - 1]![4]
    const near = (c: { price: number } | undefined) => c && Math.abs(c.price - mid) / mid < 0.06
    if (near(view.up[0])) p1 = Math.max(p1, view.up[0]!.price)
    if (near(view.dn[0])) p0 = Math.min(p0, view.dn[0]!.price)
    const pad = (p1 - p0) * 0.08 + p1 * 0.003
    p0 -= pad
    p1 += pad
    const x = (t: number) => L + ((t - t0) / (t1 - t0)) * (R - L)
    const y = (p: number) => T + ((p1 - p) / (p1 - p0)) * (B - T)
    geo.current = { x, y, t0, t1, p0, p1, L, R, T, B }
    g.font = `12px ${font}`
    g.textBaseline = 'middle'

    // fiyat ızgarası ve ekseni
    const raw = (p1 - p0) / (Hh < 480 ? 5 : 8)
    const mag = 10 ** Math.floor(Math.log10(raw))
    const stp = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw)!
    g.strokeStyle = C.grid
    g.lineWidth = 1
    g.fillStyle = C.muted
    g.textAlign = 'left'
    for (let p = Math.ceil(p0 / stp) * stp; p <= p1; p += stp) {
      const yy = Math.round(y(p)) + 0.5
      g.beginPath()
      g.moveTo(L, yy)
      g.lineTo(R, yy)
      g.stroke()
      g.fillText(fmtP.format(p), R + 8, yy)
    }
    // zaman ekseni (İstanbul): pencereye göre 2/4/8 saatte bir; gün değişince tarih
    const hours = (t1 - t0) / H
    const hstep = hours <= 16 ? 2 : hours <= 30 ? 4 : 8
    g.textAlign = 'center'
    g.textBaseline = 'top'
    const IST = 3 * H
    for (let t = Math.ceil((t0 + IST) / (hstep * H)) * hstep * H - IST; t < t1; t += hstep * H) {
      const xx = Math.round(x(t)) + 0.5
      g.strokeStyle = C.grid
      g.beginPath()
      g.moveTo(xx, T)
      g.lineTo(xx, B)
      g.stroke()
      const midnight = (t + IST) % (24 * H) === 0
      const label = midnight ? dm.format(t) : hm.format(t)
      const w = g.measureText(label).width
      if (xx - w / 2 < L || xx + w / 2 > R) continue
      g.fillStyle = midnight ? C.text : C.muted
      g.fillText(label, xx, B + 7)
    }
    g.textBaseline = 'middle'

    g.save()
    g.beginPath()
    g.rect(L, T, R - L, B - T)
    g.clip()

    // ısı: hücre değeri büyüdükçe daha opak (0,7 üslü ölçek: küçük değerler soluk kalsın, ortalar seçilsin)
    if (grid && grid.max > 0) {
      const lv = grid.levels
      const half = lv.length > 1 ? Math.abs(lv[1]! - lv[0]!) / 2 : 25
      const cw = Math.max(1, x(t0 + grid.step) - x(t0) + 0.6)
      const c = grid.cells
      for (let i = 0; i < c.length; i += 3) {
        const p = lv[c[i + 1]!]!
        if (p + half < p0 || p - half > p1) continue
        const a = 0.04 + 0.88 * (c[i + 2]! / grid.max) ** 0.7
        g.fillStyle = rgba(C.heat, Math.min(0.92, a))
        const yt = y(p + half)
        g.fillRect(x(grid.cols[c[i]!]!), yt, cw, Math.max(1, y(p - half) - yt + 0.6))
      }
    }

    // cluster çizgileri
    const labels: Array<{ y: number; text: string }> = []
    g.lineWidth = 1
    for (const [list, dir] of [
      [view.up, '↑'],
      [view.dn, '↓'],
    ] as const) {
      list.forEach((cl, i) => {
        const inside = cl.price >= p0 && cl.price <= p1
        const yy = inside ? Math.round(y(cl.price)) + 0.5 : cl.price > p1 ? T + 8 : B - 8
        if (inside) {
          g.strokeStyle = rgba(C.text, cl.rank === 1 ? 0.85 : 0.5)
          g.beginPath()
          g.moveTo(L, yy)
          g.lineTo(R, yy)
          g.stroke()
        }
        labels.push({ y: yy, text: `${dir}${cl.rank} ${fmtP.format(cl.price)}, ${usd(cl.usd)}${inside ? '' : ' (grafiğin dışında)'}` })
      })
    }

    // mumlar; snapshot'tan sonrası heatmap'te yok
    const slot = x(t0 + tfMs) - x(t0)
    const bw = Math.max(1, Math.min(9, slot * 0.66))
    for (const k of rows) {
      const [t, o, h, l, c] = k
      const xx = Math.round(x(t + tfMs / 2))
      const up = c >= o
      const col = up ? C.up : C.down
      // ısının üstünde seçilsin diye ince zemin payı
      g.fillStyle = C.surface
      g.fillRect(xx - bw / 2 - 1, y(Math.max(o, c)) - 1, bw + 2, Math.max(1, y(Math.min(o, c)) - y(Math.max(o, c))) + 2)
      g.strokeStyle = col
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(xx + 0.5, y(h))
      g.lineTo(xx + 0.5, y(l))
      g.stroke()
      g.fillStyle = col
      g.fillRect(xx - bw / 2, y(Math.max(o, c)), bw, Math.max(1, y(Math.min(o, c)) - y(Math.max(o, c))))
    }

    // heatmap anı
    const xs = Math.round(x(snapAt)) + 0.5
    g.strokeStyle = rgba(C.text, 0.45)
    g.beginPath()
    g.moveTo(xs, T)
    g.lineTo(xs, B)
    g.stroke()
    // son fiyat çizgisi
    if (price !== null && price >= p0 && price <= p1) {
      g.strokeStyle = rgba(C.text, 0.7)
      g.beginPath()
      g.moveTo(L, Math.round(y(price)) + 0.5)
      g.lineTo(R, Math.round(y(price)) + 0.5)
      g.stroke()
    }
    g.restore()

    // etiketler: cluster'lar sağda, çakışan atlanır
    g.textAlign = 'right'
    const used: number[] = []
    for (const lb of labels) {
      if (used.some((u) => Math.abs(u - lb.y) < 15)) continue
      used.push(lb.y)
      const w = g.measureText(lb.text).width
      g.fillStyle = rgba(C.surface, 0.88)
      g.fillRect(R - w - 12, lb.y - 8, w + 12, 16)
      g.fillStyle = C.text
      g.fillText(lb.text, R - 8, lb.y)
    }
    g.textAlign = xs > R - 120 ? 'right' : 'left'
    g.fillStyle = C.muted
    g.fillText(`heatmap ${hm.format(snapAt)}`, xs + (xs > R - 120 ? -6 : 6), T - 6 < 8 ? 8 : T - 6)
    if (price !== null && price >= p0 && price <= p1) {
      const label = fmtP.format(price)
      const w = g.measureText(label).width
      const yy = y(price)
      g.fillStyle = C.text
      g.fillRect(R + 2, yy - 9, w + 12, 18)
      g.fillStyle = C.surface
      g.textAlign = 'left'
      g.fillText(label, R + 8, yy)
    }
  }, [view, price])

  useEffect(() => {
    draw()
    const box = wrap.current
    if (!box) return
    const ro = new ResizeObserver(() => draw())
    ro.observe(box)
    return () => ro.disconnect()
  }, [draw])

  // imleç: dikey ve yatay çizgi, ipucunda mum ve o hücrenin likidasyonu
  const onMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const ov = over.current
      const gm = geo.current
      const tp = tip.current
      if (!ov || !gm || !tp || !view) return
      const r = ov.getBoundingClientRect()
      const px = e.clientX - r.left
      const py = e.clientY - r.top
      const g = ov.getContext('2d')!
      const dpr = window.devicePixelRatio || 1
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, ov.width, ov.height)
      if (px < gm.L || px > gm.R || py < gm.T || py > gm.B) {
        tp.hidden = true
        return
      }
      const C = readColors(wrap.current!)
      const t = gm.t0 + ((px - gm.L) / (gm.R - gm.L)) * (gm.t1 - gm.t0)
      const p = gm.p1 - ((py - gm.T) / (gm.B - gm.T)) * (gm.p1 - gm.p0)
      const rows = view.candles.rows
      const tfMs = rows.length > 1 ? rows[1]![0] - rows[0]![0] : 15 * 60_000
      let k = rows[0]!
      for (const q of rows) if (Math.abs(q[0] + tfMs / 2 - t) < Math.abs(k[0] + tfMs / 2 - t)) k = q
      g.strokeStyle = rgba(C.text, 0.4)
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(Math.round(gm.x(k[0] + tfMs / 2)) + 0.5, gm.T)
      g.lineTo(Math.round(gm.x(k[0] + tfMs / 2)) + 0.5, gm.B)
      g.moveTo(gm.L, Math.round(py) + 0.5)
      g.lineTo(gm.R, Math.round(py) + 0.5)
      g.stroke()
      // imlecin altındaki hücre
      let heat: number | null = null
      const grid = view.grid
      if (grid) {
        const col = Math.floor((t - grid.cols[0]!) / grid.step)
        const lv = grid.levels
        let li = -1
        let best = Infinity
        for (let i = 0; i < lv.length; i++) {
          const d = Math.abs(lv[i]! - p)
          if (d < best) {
            best = d
            li = i
          }
        }
        const half = lv.length > 1 ? Math.abs(lv[1]! - lv[0]!) / 2 : 25
        if (col >= 0 && col < grid.cols.length && best <= half) {
          const c = grid.cells
          for (let i = 0; i < c.length; i += 3) if (c[i] === col && c[i + 1] === li) heat = c[i + 2]! * 1000
        }
      }
      tp.replaceChildren()
      const add = (label: string, value: string, strong = false) => {
        const row = document.createElement('div')
        row.className = s.tipRow!
        const a = document.createElement('span')
        a.textContent = label
        const b = document.createElement(strong ? 'strong' : 'span')
        b.textContent = value
        row.append(a, b)
        tp.append(row)
      }
      const head = document.createElement('div')
      head.className = s.tipHead!
      head.textContent = dmh.format(k[0])
      tp.append(head)
      add('açılış', fmtP.format(k[1]))
      add('tepe', fmtP.format(k[2]))
      add('dip', fmtP.format(k[3]))
      add('kapanış', fmtP.format(k[4]), true)
      add('imleç', fmtP.format(p))
      if (heat !== null) add('likidasyon', usd(heat), true)
      tp.hidden = false
      const box = wrap.current!.getBoundingClientRect()
      let left = px + 16
      if (left + tp.offsetWidth > box.width - 4) left = px - tp.offsetWidth - 16
      let top = py + 14
      if (top + tp.offsetHeight > box.height - 4) top = py - tp.offsetHeight - 14
      tp.style.left = `${Math.max(4, left)}px`
      tp.style.top = `${Math.max(4, top)}px`
    },
    [view],
  )
  const onLeave = useCallback(() => {
    const ov = over.current
    if (ov) ov.getContext('2d')!.clearRect(0, 0, ov.width, ov.height)
    if (tip.current) tip.current.hidden = true
  }, [])

  const at = view ? Date.parse(view.snapshot.at) : null
  const maxUsd = view?.grid ? view.grid.max * 1000 : null

  return (
    <section className={s.card} aria-label="Fiyat ve likidasyon heatmap'i">
      <div className={s.toolbar}>
        <div className={s.seg} role="radiogroup" aria-label="Heatmap penceresi">
          {SPANS.map((sp) => (
            <button key={sp} type="button" role="radio" aria-checked={span === sp} onClick={() => latest(sp)}>
              {sp}
            </button>
          ))}
        </div>
        <div className={s.nav}>
          <button
            type="button"
            className={s.step}
            aria-label="Önceki snapshot"
            disabled={!view?.prevId || busy}
            onClick={() => view?.prevId && (setFollow(false), void load(span, view.prevId))}
          >
            ‹
          </button>
          <span className={`${s.when} num`}>{at ? dmh.format(at) : '—'}</span>
          <button
            type="button"
            className={s.step}
            aria-label="Sonraki snapshot"
            disabled={!view?.nextId || busy}
            onClick={() => view?.nextId && (setFollow(false), void load(span, view.nextId))}
          >
            ›
          </button>
          <button type="button" className={s.latest} disabled={follow || busy} onClick={() => latest(span)}>
            En yeni
          </button>
        </div>
        {maxUsd !== null && (
          <div className={s.scale} aria-label={`Isı ölçeği: 0'dan ${usd(maxUsd)}'a`}>
            <span className="num">0</span>
            <i aria-hidden="true" />
            <span className="num">{usd(maxUsd)}</span>
          </div>
        )}
      </div>
      {error && <p className={s.error}>{error}</p>}
      <div ref={wrap} className={`${s.wrap} ${busy ? s.busy : ''}`}>
        <canvas
          ref={base}
          role="img"
          aria-label={view ? `Axi BTCUSD ${view.candles.tf} mumları ve ${view.span} likidasyon heatmap'i; cluster'lar aşağıda` : 'Veri yok'}
        />
        <canvas ref={over} className={s.over} aria-hidden="true" onPointerMove={onMove} onPointerLeave={onLeave} />
        <div ref={tip} className={s.tip} hidden />
        {!view && <p className={s.empty}>Bu pencerede heatmap snapshot'ı yok.</p>}
      </div>
      {view && <Levels view={view} price={price} />}
    </section>
  )
}

function Levels({ view, price }: { view: HeatView; price: number | null }) {
  const ref = price
  const note =
    view.basis === null
      ? 'Snapshot anına ait Axi mumu olmadığı için heatmap CoinGlass fiyatıyla çiziliyor.'
      : `Heatmap ve cluster'lar Axi fiyatına baz kadar kaydırıldı: CoinGlass fiyatı Axi'nin ${fmtP.format(view.basis)} $ ${view.basis >= 0 ? 'üstünde' : 'altında'}.`
  const maxBand = Math.max(1, ...view.upLiq, ...view.dnLiq)
  return (
    <div className={s.levels}>
      <div className={s.clusters}>
        {(
          [
            ["Yukarıdaki cluster'lar", view.up, '↑'],
            ["Aşağıdaki cluster'lar", view.dn, '↓'],
          ] as const
        ).map(([title, list, dir]) => (
          <div key={title}>
            <h3 className={s.h3}>{title}</h3>
            {list.length === 0 ? (
              <p className={s.muted}>yok</p>
            ) : (
              <div className={s.scroll}>
                <table className={s.table}>
                  <tbody>
                    {list.map((c, i) => (
                      <tr key={i}>
                        <th scope="row">
                          {dir}
                          {c.rank}
                        </th>
                        <td className="num">{fmtP.format(c.price)}</td>
                        <td className="num">{usd(c.usd)}</td>
                        <td className={`num ${s.muted}`}>{ref ? pct(c.price, ref) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
        <div className={s.bandBlock}>
          <h3 className={s.h3}>Bant likiditesi</h3>
          <div className={s.scroll}>
            <table className={s.table}>
              <tbody>
                {[0, 1, 2].map((i) => (
                  <tr key={i}>
                    <td className={`num ${s.rt}`}>{usd(view.dnLiq[i] ?? 0)}</td>
                    <td className={s.divCell} aria-hidden="true">
                      <span className={s.div}>
                        <span className={s.half}>
                          <i style={{ width: `${((view.dnLiq[i] ?? 0) / maxBand) * 100}%` }} />
                        </span>
                        <span className={`${s.half} ${s.right}`}>
                          <i style={{ width: `${((view.upLiq[i] ?? 0) / maxBand) * 100}%` }} />
                        </span>
                      </span>
                    </td>
                    <td className="num">{usd(view.upLiq[i] ?? 0)}</td>
                    <th scope="row" className={s.muted}>
                      ±%{i + 1}
                    </th>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={s.muted}>solda fiyatın altı, sağda üstü</p>
        </div>
      </div>
      <p className={s.note}>
        {note} Isı CoinGlass model1 likidasyon seviyeleri; koyuluk o fiyattaki likidasyon miktarını gösteriyor. Çizgiler core'un cluster'ları: 1 en büyüğü (eski
        sistemin kullandığı), 2 ve 3 sonrakiler.
      </p>
    </div>
  )
}
