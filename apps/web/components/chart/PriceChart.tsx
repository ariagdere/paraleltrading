'use client'

import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  TickMarkType,
  createChart,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CHART_TFS, TF_MS, type CandleRow, type ChartTf, type ChartTokens, type ChartZone, type PrevLevels, type Zones } from '@/lib/chart-shared'
import type { HeatView, Span } from '@/lib/market-data'
import { HeatLevels, PrevList, ZoneList } from './details'
import { dmh, fmt1, fmtP, hm, usd } from './format'
import { HeatLayer, TimeAxis, ZoneLayer, bandAt, rgba } from './layers'
import s from './price-chart.module.css'

// Temel fiyat grafiği: Axi mumları (5m–1d, sürükleyerek geçmişe kaydırılır, tekerlekle yakınlaştırılır) ve
// düğmeyle açılıp kapanan katmanlar: heatmap (ısı ve sağ kenarda likidasyon profili), cluster'lar, destek/direnç
// bölgeleri, önceki gün/hafta seviyeleri. Veriyi API'den okur; sayfanın dakikalık yenilemesi yalnız "değişti mi"
// işaretlerini getirir: yeni 1m mumu gelince son mumlar, bölgeler yeniden hesaplanınca bölgeler, seçili pencerede
// yeni snapshot olunca heatmap okunur. Seçimler (dilim, katmanlar, pencere) tarayıcıda hatırlanır.

// İstanbul UTC+3 ve yaz saati yok: zamanlar 3 saat kaydırılır, kütüphanenin UTC ekseni İstanbul saatini gösterir.
const SHIFT = 3 * 3600
const toChart = (ms: number) => (ms / 1000 + SHIFT) as UTCTimestamp
const toBar = (r: CandleRow): CandlestickData<Time> => ({ time: toChart(r[0]), open: r[1], high: r[2], low: r[3], close: r[4] })
const VISIBLE: Record<ChartTf, number> = { '5m': 144, '15m': 192, '1h': 168, '4h': 180, '1d': 180 } // açılışta görünen mum
const LOAD = 600 // bir okumada mum
const SPANS: Span[] = ['12h', '24h', '48h']

type LayerKey = 'heat' | 'clusters' | 'zones' | 'prev'
type Prefs = { tf: ChartTf; span: Span; layers: Record<LayerKey, boolean> }
const DEFAULT_PREFS: Prefs = { tf: '15m', span: '24h', layers: { heat: true, clusters: true, zones: true, prev: false } }
const PREFS_KEY = 'hakari2.piyasa.grafik.v1'
const LAYERS: Array<[LayerKey, string, keyof typeof s]> = [
  ['heat', 'Heatmap', 'markHeat'],
  ['clusters', "Cluster'lar", 'markCluster'],
  ['zones', 'Destek/direnç', 'markZone'],
  ['prev', 'Önceki gün/hafta', 'markPrev'],
]

function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null')
    if (!raw || typeof raw !== 'object') return DEFAULT_PREFS
    const layers = { ...DEFAULT_PREFS.layers }
    for (const k of Object.keys(layers) as LayerKey[]) if (typeof raw.layers?.[k] === 'boolean') layers[k] = raw.layers[k]
    return {
      tf: (CHART_TFS as readonly string[]).includes(raw.tf) ? raw.tf : DEFAULT_PREFS.tf,
      span: SPANS.includes(raw.span) ? raw.span : DEFAULT_PREFS.span,
      layers,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

type Colors = Record<'surface' | 'line' | 'grid' | 'text' | 'muted' | 'up' | 'down' | 'heat' | 'zone', string>
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
    zone: v('--zone'),
  }
}

const utc = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('tr-TR', { timeZone: 'UTC', ...o })
const fTime = utc({ hour: '2-digit', minute: '2-digit' })
const fDay = utc({ day: 'numeric', month: 'short' })
const fMonth = utc({ month: 'short' })
const fYear = utc({ year: 'numeric' })
const fFull = utc({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
  if (res.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`
    throw new HttpError(401, 'oturum yok')
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new HttpError(res.status, body?.error ?? `HTTP ${res.status}`)
  return body as T
}

export function PriceChart({ tokens, price, prev }: { tokens: ChartTokens; price: number | null; prev: PrevLevels }) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  const [ready, setReady] = useState(false) // tarayıcıdaki seçimler okundu
  const [count, setCount] = useState<number | null>(null) // yüklü mum sayısı; null: henüz okunmadı
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [zones, setZones] = useState<ChartZone[]>([])
  const [heat, setHeat] = useState<HeatView | null>(null)
  const [follow, setFollow] = useState(true) // en yeni snapshot izleniyor
  const [heatBusy, setHeatBusy] = useState(false)

  const box = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const axis = useRef(new TimeAxis())
  const heatLayer = useRef<HeatLayer | null>(null)
  const zoneLayer = useRef<ZoneLayer | null>(null)
  const colors = useRef<Colors | null>(null)
  const rows = useRef<CandleRow[]>([]) // yüklü mumlar, eskiden yeniye
  const tfRef = useRef<ChartTf>(DEFAULT_PREFS.tf)
  const seq = useRef(0) // dilim değişince süren okumalar yok sayılır
  const older = useRef({ busy: false, done: false })
  const lines = useRef<{ clusters: IPriceLine[]; prev: IPriceLine[]; live: IPriceLine | null }>({ clusters: [], prev: [], live: null })
  const prefsRef = useRef(prefs)
  const zonesRef = useRef<ChartZone[]>([])
  prefsRef.current = prefs
  zonesRef.current = zones

  useEffect(() => {
    setPrefs(readPrefs())
    setReady(true)
  }, [])
  useEffect(() => {
    if (!ready) return
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      // gizli pencere ya da kapalı depolama: seçimler yalnız bu sekmede kalır
    }
  }, [prefs, ready])

  // Mumları seriye ve katmanların zaman eksenine aktarır.
  const applyRows = useCallback((resetView: boolean) => {
    const se = series.current
    const ch = chart.current
    if (!se || !ch) return
    const tf = tfRef.current
    axis.current.set(
      rows.current.map((r) => r[0]),
      TF_MS[tf],
    )
    se.setData(rows.current.map(toBar))
    if (resetView) {
      const n = rows.current.length
      ch.timeScale().setVisibleLogicalRange({ from: n - VISIBLE[tf], to: n + 6 })
    }
    heatLayer.current?.update()
    zoneLayer.current?.update()
  }, [])

  // Geçmişe kaydırınca daha eski mumlar.
  const loadOlder = useCallback(
    (r: LogicalRange | null) => {
      if (!r || r.from > 30) return
      const o = older.current
      if (o.busy || o.done || rows.current.length === 0) return
      o.busy = true
      const tf = tfRef.current
      const n = seq.current
      getJson<{ rows: CandleRow[] }>(`/api/piyasa/mumlar?tf=${tf}&before=${rows.current[0]![0]}&n=${LOAD}`)
        .then((body) => {
          if (n !== seq.current || !chart.current) return
          if (body.rows.length < LOAD) o.done = true
          if (body.rows.length === 0) return
          const ts = chart.current.timeScale()
          const range = ts.getVisibleLogicalRange()
          rows.current = [...body.rows, ...rows.current]
          applyRows(false)
          if (range) ts.setVisibleLogicalRange({ from: range.from + body.rows.length, to: range.to + body.rows.length })
          setCount(rows.current.length)
        })
        .catch(() => {
          // sonraki kaydırmada yeniden denenir
        })
        .finally(() => {
          o.busy = false
        })
    },
    [applyRows],
  )

  // İmleç: mumun değerleri, imlecin fiyatı, altındaki heatmap hücresi ve bölge.
  const onCrosshair = useCallback((p: MouseEventParams<Time>) => {
    const el = tip.current
    const se = series.current
    if (!el || !se) return
    const bar = p.point && p.logical !== undefined ? (p.seriesData.get(se) as CandlestickData<Time> | undefined) : undefined
    if (!p.point || !bar) {
      el.hidden = true
      return
    }
    const at = se.coordinateToPrice(p.point.y)
    const tReal = axis.current.time(p.logical!)
    const L = prefsRef.current.layers
    el.replaceChildren()
    const add = (parent: HTMLElement, label: string, value: string, strong = false) => {
      const row = document.createElement('div')
      row.className = s.tipRow!
      const a = document.createElement('span')
      a.textContent = label
      const b = document.createElement(strong ? 'strong' : 'span')
      b.textContent = value
      row.append(a, b)
      parent.append(row)
    }
    const head = document.createElement('div')
    head.className = s.tipHead!
    head.textContent = fFull.format(Number(bar.time) * 1000)
    el.append(head)
    add(el, 'açılış', fmtP.format(bar.open))
    add(el, 'tepe', fmtP.format(bar.high))
    add(el, 'dip', fmtP.format(bar.low))
    add(el, 'kapanış', fmtP.format(bar.close), true)
    if (at !== null) {
      add(el, 'imleç', fmtP.format(at))
      if (L.heat) {
        const v = heatLayer.current?.valueAt(tReal, at)
        if (v !== null && v !== undefined) add(el, 'likidasyon', usd(v), true)
      }
      if (L.zones) {
        const z = zonesRef.current.find((x) => {
          if (!x.shown) return false
          const b = bandAt(x, tReal)
          return b !== null && at >= b[0] && at <= b[1]
        })
        if (z) {
          const b = bandAt(z, tReal)!
          const box = document.createElement('div')
          box.className = s.tipZone!
          add(box, 'bölge', `${fmtP.format(b[0])}–${fmtP.format(b[1])}`, true)
          add(box, 'güç', fmt1.format(z.score))
          add(box, 'test, tuttu, kırıldı', `${z.touches}, ${z.holds}, ${z.breaks}`)
          el.append(box)
        }
      }
    }
    el.hidden = false
    const W = box.current!.clientWidth
    const H = box.current!.clientHeight
    let left = p.point.x + 16
    if (left + el.offsetWidth > W - 70) left = p.point.x - el.offsetWidth - 16
    let top = p.point.y + 14
    if (top + el.offsetHeight > H - 30) top = p.point.y - el.offsetHeight - 14
    el.style.left = `${Math.max(4, left)}px`
    el.style.top = `${Math.max(4, top)}px`
  }, [])

  // Grafik bir kez kurulur.
  useEffect(() => {
    const el = host.current!
    const C = readColors(box.current!)
    colors.current = C
    const font = getComputedStyle(box.current!).fontFamily
    const ch = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: C.surface }, textColor: C.muted, fontFamily: font, fontSize: 13, attributionLogo: true },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.line, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: {
        borderColor: C.line,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        tickMarkFormatter: (t: Time, type: TickMarkType) => {
          const ms = Number(t) * 1000
          return type === TickMarkType.Year
            ? fYear.format(ms)
            : type === TickMarkType.Month
              ? fMonth.format(ms)
              : type === TickMarkType.DayOfMonth
                ? fDay.format(ms)
                : fTime.format(ms)
        },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: rgba(C.text, 0.35), labelBackgroundColor: C.line },
        horzLine: { color: rgba(C.text, 0.35), labelBackgroundColor: C.line },
      },
      localization: { locale: 'tr-TR', priceFormatter: (p: number) => fmtP.format(p), timeFormatter: (t: Time) => fFull.format(Number(t) * 1000) },
      handleScroll: { vertTouchDrag: false },
    })
    const se = ch.addSeries(CandlestickSeries, {
      upColor: C.up,
      downColor: C.down,
      borderUpColor: C.up,
      borderDownColor: C.down,
      wickUpColor: C.up,
      wickDownColor: C.down,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    })
    const hl = new HeatLayer(axis.current)
    hl.color = C.heat
    hl.text = C.text
    hl.font = font
    const zl = new ZoneLayer(axis.current)
    zl.color = C.zone
    zl.text = C.text
    zl.bg = C.surface
    zl.font = font
    se.attachPrimitive(hl)
    se.attachPrimitive(zl)
    chart.current = ch
    series.current = se
    heatLayer.current = hl
    zoneLayer.current = zl
    ch.subscribeCrosshairMove(onCrosshair)
    ch.timeScale().subscribeVisibleLogicalRangeChange(loadOlder)
    return () => {
      ch.remove()
      chart.current = null
      series.current = null
      heatLayer.current = null
      zoneLayer.current = null
      lines.current = { clusters: [], prev: [], live: null }
    }
  }, [onCrosshair, loadOlder])

  // Dilim değişince (ve açılışta) en yeni mumlar.
  useEffect(() => {
    if (!ready) return
    const tf = prefs.tf
    tfRef.current = tf
    const n = ++seq.current
    older.current = { busy: false, done: false }
    setLoading(true)
    setError(null)
    getJson<{ rows: CandleRow[] }>(`/api/piyasa/mumlar?tf=${tf}&n=${LOAD}`)
      .then((body) => {
        if (n !== seq.current) return
        rows.current = body.rows
        older.current.done = body.rows.length < LOAD
        applyRows(true)
        setCount(body.rows.length)
      })
      .catch((err) => {
        if (n === seq.current) setError(`Mumlar okunamadı: ${(err as Error).message}`)
      })
      .finally(() => {
        if (n === seq.current) setLoading(false)
      })
  }, [prefs.tf, ready, applyRows])

  // Yeni 1m mumu geldi: seçili dilimin son mumları (son mum da yeniden: düzeltilmiş olabilir).
  const lastCandle = useRef(tokens.candle)
  useEffect(() => {
    if (tokens.candle === lastCandle.current) return
    lastCandle.current = tokens.candle
    const last = rows.current[rows.current.length - 1]
    const se = series.current
    if (!last || !se) return
    const tf = tfRef.current
    const n = seq.current
    getJson<{ rows: CandleRow[] }>(`/api/piyasa/mumlar?tf=${tf}&after=${last[0] - 1}&n=50`)
      .then((body) => {
        if (n !== seq.current || !series.current) return
        const cur = rows.current
        for (const r of body.rows) {
          const i = cur.length - 1
          if (r[0] === cur[i]![0]) cur[i] = r
          else if (r[0] > cur[i]![0]) cur.push(r)
          else continue
          series.current.update(toBar(r))
        }
        axis.current.set(
          cur.map((r) => r[0]),
          TF_MS[tf],
        )
        heatLayer.current?.update()
        zoneLayer.current?.update()
        setCount(cur.length)
      })
      .catch(() => {
        // bir sonraki dakika yeniden
      })
  }, [tokens.candle])

  // Bölgeler: açılışta ve core yeniden hesaplayınca.
  useEffect(() => {
    getJson<Zones>('/api/piyasa/bolgeler')
      .then((z) => setZones(z.zones))
      .catch((err) => setError(`Bölgeler okunamadı: ${(err as Error).message}`))
  }, [tokens.zones])

  // Heatmap: heatmap ya da cluster katmanı açıksa; en yeni izlenirken seçili pencerede yeni snapshot gelince.
  const heatSeq = useRef(0)
  const loadHeat = useCallback(async (span: Span, id: number | null) => {
    const n = ++heatSeq.current
    setHeatBusy(true)
    try {
      const v = await getJson<HeatView>(`/api/piyasa/heatmap?span=${span}${id !== null ? `&id=${id}` : ''}`)
      if (n === heatSeq.current) setHeat(v)
    } catch (err) {
      if (n !== heatSeq.current) return
      if (err instanceof HttpError && err.status === 404 && id === null) setHeat(null)
      else setError(`Heatmap okunamadı: ${(err as Error).message}`)
    } finally {
      if (n === heatSeq.current) setHeatBusy(false)
    }
  }, [])
  const wantHeat = prefs.layers.heat || prefs.layers.clusters
  const latestId = tokens.heat[prefs.span]
  const heatAsked = useRef<string | null>(null) // en yeni hangi pencere ve işaret için istendi
  useEffect(() => {
    if (!ready || !wantHeat || !follow) return
    const key = `${prefs.span}:${latestId}`
    if (heatAsked.current === key) return
    heatAsked.current = key
    void loadHeat(prefs.span, null)
  }, [ready, wantHeat, follow, prefs.span, latestId, loadHeat])

  useEffect(() => {
    const at = heat ? Date.parse(heat.snapshot.at) : null
    heatLayer.current?.setData(heat?.grid ?? null, at, at !== null ? `heatmap ${hm.format(at)}` : '')
  }, [heat])
  useEffect(() => {
    heatLayer.current?.setVisible(prefs.layers.heat)
  }, [prefs.layers.heat])

  // Bölgeler: yalnız core'un gösterdikleri; güç yazısı heatmap profilinin solunda.
  const shownZones = useMemo(() => zones.filter((z) => z.shown), [zones])
  useEffect(() => {
    zoneLayer.current?.setZones(shownZones)
  }, [shownZones])
  useEffect(() => {
    const zl = zoneLayer.current
    if (!zl) return
    zl.labelInset = prefs.layers.heat && heat?.grid ? 122 : 8
    zl.update()
  }, [prefs.layers.heat, heat])
  useEffect(() => {
    zoneLayer.current?.setVisible(prefs.layers.zones)
  }, [prefs.layers.zones])

  // Cluster çizgileri: 1 düz ve belirgin, 2 ve 3 kesik ve soluk; hepsi eksende fiyatıyla.
  useEffect(() => {
    const se = series.current
    const C = colors.current
    if (!se || !C) return
    for (const l of lines.current.clusters) se.removePriceLine(l)
    lines.current.clusters = []
    if (!prefs.layers.clusters || !heat) return
    for (const [list, dir] of [
      [heat.up, '↑'],
      [heat.dn, '↓'],
    ] as const) {
      for (const c of list) {
        lines.current.clusters.push(
          se.createPriceLine({
            price: c.price,
            color: rgba(C.text, c.rank === 1 ? 0.8 : 0.45),
            lineWidth: 1,
            lineStyle: c.rank === 1 ? LineStyle.Solid : LineStyle.Dashed,
            axisLabelVisible: true,
            axisLabelColor: c.rank === 1 ? C.line : C.grid,
            axisLabelTextColor: c.rank === 1 ? C.text : C.muted,
            title: `${dir}${c.rank} ${usd(c.usd)}`,
          }),
        )
      }
    }
  }, [heat, prefs.layers.clusters])

  // Fiyat ekseni en yakın cluster'ları da kapsasın (fiyatın %6'sından yakınsa).
  useEffect(() => {
    const ref = price
    if (!prefs.layers.clusters || !heat || ref === null) {
      heatLayer.current?.setExtent(null)
      return
    }
    const near = (c: { price: number } | undefined) => (c && Math.abs(c.price - ref) / ref < 0.06 ? c.price : ref)
    const up = [...heat.up].sort((a, b) => a.price - b.price).find((c) => c.price > ref)
    const dn = [...heat.dn].sort((a, b) => b.price - a.price).find((c) => c.price < ref)
    heatLayer.current?.setExtent([near(dn), near(up)])
  }, [heat, price, prefs.layers.clusters])

  // Önceki gün ve hafta seviyeleri: kesik çizgiler.
  useEffect(() => {
    const se = series.current
    const C = colors.current
    if (!se || !C) return
    for (const l of lines.current.prev) se.removePriceLine(l)
    lines.current.prev = []
    if (!prefs.layers.prev) return
    const items: Array<[string, number | undefined]> = [
      ['pdh', prev.day?.h],
      ['pdl', prev.day?.l],
      ['pwh', prev.week?.h],
      ['pwl', prev.week?.l],
      ['pwo', prev.week?.o],
      ['pwc', prev.week?.c],
    ]
    for (const [name, v] of items) {
      if (v === undefined) continue
      lines.current.prev.push(
        se.createPriceLine({
          price: v,
          color: rgba(C.muted, 0.85),
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          axisLabelColor: C.grid,
          axisLabelTextColor: C.muted,
          title: name,
        }),
      )
    }
  }, [prev, prefs.layers.prev])

  // Son fiyat (son 1m kapanışı): eksende beyaz etiket.
  useEffect(() => {
    const se = series.current
    const C = colors.current
    if (!se || !C || price === null) return
    if (!lines.current.live)
      lines.current.live = se.createPriceLine({
        price,
        color: rgba(C.text, 0.7),
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        axisLabelColor: C.text,
        axisLabelTextColor: C.surface,
        title: '',
      })
    else lines.current.live.applyOptions({ price })
  }, [price])

  const setLayer = (k: LayerKey) => setPrefs((p) => ({ ...p, layers: { ...p.layers, [k]: !p.layers[k] } }))
  const at = heat ? Date.parse(heat.snapshot.at) : null
  const maxUsd = heat?.grid ? heat.grid.max * 1000 : null
  const busy = loading || heatBusy

  return (
    <section className={s.card} aria-label="Fiyat grafiği ve katmanlar">
      <div className={s.toolbar}>
        <div className={s.seg} role="radiogroup" aria-label="Mum dilimi">
          {CHART_TFS.map((tf) => (
            <button key={tf} type="button" role="radio" aria-checked={prefs.tf === tf} onClick={() => setPrefs((p) => ({ ...p, tf }))}>
              {tf}
            </button>
          ))}
        </div>
        <div className={s.layers} role="group" aria-label="Katmanlar">
          {LAYERS.map(([k, label, mark]) => (
            <button key={k} type="button" className={s.chip} aria-pressed={prefs.layers[k]} onClick={() => setLayer(k)}>
              <span className={`${s.mark} ${s[mark]}`} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </div>
      {wantHeat && (
        <div className={s.heatbar}>
          <span className={s.heatLabel}>Heatmap</span>
          <div className={s.seg} role="radiogroup" aria-label="Heatmap penceresi">
            {SPANS.map((sp) => (
              <button
                key={sp}
                type="button"
                role="radio"
                aria-checked={prefs.span === sp}
                onClick={() => {
                  heatAsked.current = null
                  setPrefs((p) => ({ ...p, span: sp }))
                  setFollow(true)
                }}
              >
                {sp}
              </button>
            ))}
          </div>
          <div className={s.nav}>
            <button
              type="button"
              className={s.step}
              aria-label="Önceki snapshot"
              disabled={!heat?.prevId || heatBusy}
              onClick={() => heat?.prevId && (setFollow(false), void loadHeat(prefs.span, heat.prevId))}
            >
              ‹
            </button>
            <span className={`${s.when} num`}>{at ? dmh.format(at) : '—'}</span>
            <button
              type="button"
              className={s.step}
              aria-label="Sonraki snapshot"
              disabled={!heat?.nextId || heatBusy}
              onClick={() => heat?.nextId && (setFollow(false), void loadHeat(prefs.span, heat.nextId))}
            >
              ›
            </button>
            <button
              type="button"
              className={s.latest}
              disabled={follow || heatBusy}
              onClick={() => {
                heatAsked.current = null
                setFollow(true)
              }}
            >
              En yeni
            </button>
          </div>
          {prefs.layers.heat && maxUsd !== null && (
            <div className={s.scale} aria-label={`Isı ölçeği: 0'dan ${usd(maxUsd)}'a`}>
              <span className="num">0</span>
              <i aria-hidden="true" />
              <span className="num">{usd(maxUsd)}</span>
            </div>
          )}
        </div>
      )}
      {error && (
        <p className={s.error} role="status">
          {error}
        </p>
      )}
      <div ref={box} className={`${s.wrap} ${busy ? s.busy : ''}`}>
        <div ref={host} className={s.chart} role="img" aria-label={`Axi BTCUSD ${prefs.tf} mumları; açık katmanlar ve ayrıntıları aşağıda`} />
        <div ref={tip} className={s.tip} hidden />
        {count === 0 && <p className={s.empty}>Bu dilimde henüz mum yok.</p>}
      </div>
      <div className={s.details}>
        {prefs.layers.zones && <ZoneList zones={shownZones} price={price} />}
        {wantHeat && heat && <HeatLevels view={heat} price={price} clusters={prefs.layers.clusters} />}
        {wantHeat && !heat && !heatBusy && <p className={s.muted}>Bu pencerede heatmap snapshot&apos;ı yok.</p>}
        {prefs.layers.prev && <PrevList prev={prev} price={price} />}
        <p className={s.note}>
          Grafik kütüphanesi{' '}
          <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
            TradingView Lightweight Charts™
          </a>
          , Copyright © TradingView, Inc. Sürükleyerek geçmişe kaydır, tekerlekle yakınlaştır; fiyat eksenini sürükleyerek dikeyde ölçekle.
        </p>
      </div>
    </section>
  )
}
