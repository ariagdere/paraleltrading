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
import { CHART_TFS, TF_MS, type CandleRow, type ChartTf, type ChartTokens, type ManualZone, type PrevLevels } from '@/lib/chart-shared'
import type { HeatView, Span } from '@/lib/market-data'
import { ZONE_DEFAULT_BREAKS_FROM, zoneConflicts, zoneWarnings, type ZoneRule } from '@/lib/zone-rules'
import { useLive, type LiveQuote } from '../live'
import { applyQuote, mergeTail, type CandleBody } from './bars'
import { HeatLevels, ManualList, PrevList } from './details'
import { dmh, fmtP, hm, usd } from './format'
import { HeatLayer, ManualZoneLayer, TimeAxis, rgba } from './layers'
import s from './price-chart.module.css'
import { attachZoneEditor, type EditMode } from './zone-editor'
import { ZonePanel } from './ZonePanel'

// Temel fiyat grafiği: Axi mumları (5m–1d, sürükleyerek geçmişe kaydırılır, tekerlekle yakınlaştırılır) ve
// düğmeyle açılıp kapanan katmanlar: heatmap (ısı ve sağ kenarda likidasyon profili), cluster'lar, elle zonlar
// (geçerli olanların hepsi), önceki gün/hafta seviyeleri. Otomatik destek/direnç bölgeleri gösterilmez (Ari, 18 Kasım:
// Piyasa'da yalnız elle zonlar). Sondaki mumlar oluşan mumlar: kayıtlı son mumdan sonrası 1m mumlarından; canlı akış
// varken her quote'la (bid) güncellenir, dilim dolunca yeni mum açılır. Veriyi API'den okur; sayfanın dakikalık
// yenilemesi yalnız "değişti mi" işaretlerini getirir: yeni 1m mumu gelince son mumlar, elle zonlar değişince zonlar,
// seçili pencerede yeni snapshot olunca heatmap okunur. Seçimler (dilim, katmanlar, pencere) tarayıcıda hatırlanır.
// Elle zon ekleme ve düzenleme (Ari, 18 Kasım): "Zon ekle" ile grafikte çizilir, numarasına tıklanan zon düzenlenir ya
// da pasife alınır (zone-editor.ts, ZonePanel.tsx; kayıt /api/piyasa/elle-zonlar, kurallar lib/zone-rules.ts).

// İstanbul UTC+3 ve yaz saati yok: zamanlar 3 saat kaydırılır, kütüphanenin UTC ekseni İstanbul saatini gösterir.
const SHIFT = 3 * 3600
const toChart = (ms: number) => (ms / 1000 + SHIFT) as UTCTimestamp
const toBar = (r: CandleRow): CandlestickData<Time> => ({ time: toChart(r[0]), open: r[1], high: r[2], low: r[3], close: r[4] })
const VISIBLE: Record<ChartTf, number> = { '5m': 144, '15m': 192, '1h': 168, '4h': 180, '1d': 180 } // açılışta görünen mum
const LOAD = 600 // bir okumada mum
const SPANS: Span[] = ['12h', '24h', '48h']
const LIST_PRICE_MS = 5000 // alttaki listelerde fiyat en çok bu sıklıkta değişir
const ZONE_PREFS_KEY = 'hakari2.piyasa.zon.v1' // mıknatıs
const DEFAULT_BREAKS_DAY = new Date(Date.parse(ZONE_DEFAULT_BREAKS_FROM) + SHIFT * 1000).toISOString().slice(0, 10) // İstanbul günü
type ZoneEdit = { mode: EditMode; first: number | null; draft: { lo: number; hi: number } | null; editId: number | null }
const ZONE_OFF: ZoneEdit = { mode: 'off', first: null, draft: null, editId: null }

type LayerKey = 'heat' | 'clusters' | 'manual' | 'prev'
type Prefs = { tf: ChartTf; span: Span; layers: Record<LayerKey, boolean> }
const DEFAULT_PREFS: Prefs = { tf: '15m', span: '24h', layers: { heat: true, clusters: true, manual: true, prev: false } }
const PREFS_KEY = 'hakari2.piyasa.grafik.v1'
const LAYERS: Array<[LayerKey, string, keyof typeof s]> = [
  ['heat', 'Heatmap', 'markHeat'],
  ['clusters', "Cluster'lar", 'markCluster'],
  ['manual', 'Elle zonlar', 'markManual'],
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

type Colors = Record<'surface' | 'line' | 'grid' | 'text' | 'muted' | 'up' | 'down' | 'heat' | 'manual', string>
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
    manual: v('--manual'),
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
  const [manualZones, setManualZones] = useState<ManualZone[]>([])
  const [heat, setHeat] = useState<HeatView | null>(null)
  const [heatBusy, setHeatBusy] = useState(false)
  const [zone, setZone] = useState<ZoneEdit>(ZONE_OFF)
  const [rule, setRule] = useState<ZoneRule | null>(null)
  const [keep, setKeep] = useState<Set<number>>(new Set()) // çakışıp kalacak zonlar
  const [breaksFrom, setBreaksFrom] = useState(DEFAULT_BREAKS_DAY)
  const [magnet, setMagnet] = useState(true)
  const [confirm, setConfirm] = useState<'save' | 'end' | null>(null)
  const [zoneBusy, setZoneBusy] = useState(false)
  const [zoneErr, setZoneErr] = useState<string | null>(null)
  const [zoneMsg, setZoneMsg] = useState<string | null>(null)
  const live = useLive()

  const box = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const axis = useRef(new TimeAxis())
  const heatLayer = useRef<HeatLayer | null>(null)
  const manualLayer = useRef<ManualZoneLayer | null>(null)
  const colors = useRef<Colors | null>(null)
  const rows = useRef<CandleRow[]>([]) // ekrandaki mumlar, eskiden yeniye: önce kayıtlılar, sonra oluşanlar
  const stored = useRef(0) // rows'un baştan kaçı kayıtlı (kapanmış) mum
  const drawn = useRef(0) // seride kaç mum var
  const rowsTf = useRef<ChartTf | null>(null) // rows hangi dilimin
  const quote = useRef<LiveQuote | null>(null) // son taze quote (akış canlıyken)
  const tfRef = useRef<ChartTf>(DEFAULT_PREFS.tf)
  const seq = useRef(0) // dilim değişince süren okumalar yok sayılır
  const older = useRef({ busy: false, done: false })
  const lines = useRef<{ clusters: IPriceLine[]; prev: IPriceLine[]; live: IPriceLine | null }>({ clusters: [], prev: [], live: null })
  const prefsRef = useRef(prefs)
  const manualRef = useRef<ManualZone[]>([])
  prefsRef.current = prefs
  manualRef.current = manualZones
  const zoneView = useRef({ mode: zone.mode, first: zone.first, draft: zone.draft, magnet })
  zoneView.current = { mode: zone.mode, first: zone.first, draft: zone.draft, magnet }

  useEffect(() => {
    setPrefs(readPrefs())
    try {
      const z = JSON.parse(localStorage.getItem(ZONE_PREFS_KEY) ?? 'null')
      if (typeof z?.magnet === 'boolean') setMagnet(z.magnet)
    } catch {
      // varsayılan: mıknatıs açık
    }
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
    drawn.current = rows.current.length
    if (resetView) {
      const n = rows.current.length
      ch.timeScale().setVisibleLogicalRange({ from: n - VISIBLE[tf], to: n + 6 })
    }
    heatLayer.current?.update()
    manualLayer.current?.update()
  }, [])

  // Sondaki mumları seriye işler (from'dan sona; eskiler yerinde güncellenir, yeniler eklenir).
  const redrawFrom = useCallback((from: number) => {
    const se = series.current
    if (!se) return
    const cur = rows.current
    for (let i = from; i < cur.length; i++) se.update(toBar(cur[i]!), i < drawn.current - 1)
    if (cur.length !== drawn.current) {
      axis.current.set(
        cur.map((r) => r[0]),
        TF_MS[tfRef.current],
      )
      heatLayer.current?.update()
      manualLayer.current?.update()
    }
    drawn.current = cur.length
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
      getJson<CandleBody>(`/api/piyasa/mumlar?tf=${tf}&before=${rows.current[0]![0]}&n=${LOAD}`)
        .then((body) => {
          if (n !== seq.current || !chart.current) return
          if (body.rows.length < LOAD) o.done = true
          if (body.rows.length === 0) return
          const ts = chart.current.timeScale()
          const range = ts.getVisibleLogicalRange()
          rows.current = [...body.rows, ...rows.current]
          stored.current += body.rows.length
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

  // İmleç: mumun değerleri, imlecin fiyatı, altındaki heatmap hücresi ve elle zon.
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
      if (L.manual) {
        const m = manualRef.current.find((x) => at >= x.lo && at <= x.hi)
        if (m) {
          const box = document.createElement('div')
          box.className = s.tipZone!
          add(box, `elle zon #${m.id}`, `${fmtP.format(m.lo)}–${fmtP.format(m.hi)}`, true)
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
    const ml = new ManualZoneLayer(axis.current)
    ml.color = C.manual
    ml.text = C.text
    ml.bg = C.surface
    ml.font = font
    se.attachPrimitive(hl)
    se.attachPrimitive(ml)
    chart.current = ch
    series.current = se
    heatLayer.current = hl
    manualLayer.current = ml
    ch.subscribeCrosshairMove(onCrosshair)
    ch.timeScale().subscribeVisibleLogicalRangeChange(loadOlder)
    const editor = attachZoneEditor({
      container: el,
      getChart: () => chart.current,
      getSeries: () => series.current,
      getView: () => zoneView.current,
      barAt: (x) => {
        const lg = ch.timeScale().coordinateToLogical(x)
        const r = lg === null ? undefined : rows.current[Math.round(lg)]
        return r ? { o: r[1], h: r[2], l: r[3], c: r[4] } : null
      },
      labelAt: (x, y) => ml.labelAt(x, y),
      onFirst: (price) => setZone((z) => (z.mode === 'draw' ? { ...z, first: price } : z)),
      onDraft: (lo, hi, final) =>
        setZone((z) => (z.mode === 'off' ? z : { ...z, mode: final ? 'adjust' : z.mode, first: null, draft: { lo, hi } })),
      onSelect: (id) => selectZoneRef.current(id),
    })
    return () => {
      editor.detach()
      ch.remove()
      chart.current = null
      series.current = null
      heatLayer.current = null
      manualLayer.current = null
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
    getJson<CandleBody>(`/api/piyasa/mumlar?tf=${tf}&n=${LOAD}`)
      .then((body) => {
        if (n !== seq.current) return
        const lastStored = body.rows[body.rows.length - 1]?.[0] ?? -Infinity
        rows.current = [...body.rows, ...body.forming.filter((f) => f[0] > lastStored)]
        stored.current = body.rows.length
        rowsTf.current = tf
        if (quote.current) applyQuote(rows.current, stored.current, quote.current, TF_MS[tf])
        older.current.done = body.rows.length < LOAD
        applyRows(true)
        setCount(rows.current.length)
      })
      .catch((err) => {
        if (n === seq.current) setError(`Mumlar okunamadı: ${(err as Error).message}`)
      })
      .finally(() => {
        if (n === seq.current) setLoading(false)
      })
  }, [prefs.tf, ready, applyRows])

  // Yeni 1m mumu geldi: seçili dilimin son mumları (son iki kayıtlı mumdan başlayarak: düzeltilmiş olabilirler) ve
  // oluşan mumlar; ardından son quote yeniden işlenir (kapanış geri gitmesin).
  const lastCandle = useRef(tokens.candle)
  useEffect(() => {
    if (tokens.candle === lastCandle.current) return
    lastCandle.current = tokens.candle
    const cur = rows.current
    if (cur.length === 0 || !series.current || rowsTf.current !== tfRef.current) return
    const tf = tfRef.current
    const n = seq.current
    const base = cur[Math.max(0, stored.current - 2)]![0]
    getJson<CandleBody>(`/api/piyasa/mumlar?tf=${tf}&after=${base - 1}&n=50`)
      .then((body) => {
        if (n !== seq.current || !series.current) return
        const cur = rows.current
        const m = mergeTail(cur, stored.current, body)
        stored.current = m.stored
        let from = m.from
        if (quote.current && applyQuote(cur, stored.current, quote.current, TF_MS[tf]) !== 'none')
          from = from < 0 ? cur.length - 1 : Math.min(from, cur.length - 1)
        if (m.inserted) applyRows(false)
        else if (from >= 0) redrawFrom(from)
        setCount(cur.length)
      })
      .catch(() => {
        // bir sonraki dakika yeniden
      })
  }, [tokens.candle, applyRows, redrawFrom])

  // Canlı quote: oluşan mum ve fiyat çizgisi. Akış canlı değilken (kapalı, sessiz, hata) son 1m kapanışı.
  const liveQuote = live.state === 'live' ? live.quote : null
  useEffect(() => {
    quote.current = liveQuote
    const cur = rows.current
    if (!liveQuote || !series.current || cur.length === 0 || rowsTf.current !== tfRef.current) return
    const r = applyQuote(cur, stored.current, liveQuote, TF_MS[tfRef.current])
    if (r === 'none') return
    redrawFrom(cur.length - 1)
    if (r === 'added') setCount(cur.length)
  }, [liveQuote, redrawFrom])
  const shownPrice = liveQuote ? liveQuote.bid : price

  // Alttaki listelerin fiyatı (zonlara uzaklık, cluster yüzdeleri): canlı fiyat en çok 5 sn'de bir.
  const [listPrice, setListPrice] = useState<number | null>(price)
  const listAt = useRef(0)
  useEffect(() => {
    if (shownPrice === null) return
    const now = Date.now()
    if (liveQuote && now - listAt.current < LIST_PRICE_MS) return
    listAt.current = now
    setListPrice(shownPrice)
  }, [shownPrice, liveQuote])

  // Elle zonlar: açılışta, biri eklenip kapanınca (geçerli olanların hepsi) ve bu sayfadan kaydedince; ekleme kuralları
  // (çakışma eşiği, uyarı sınırları) aynı yanıtta.
  const reloadZones = useCallback(async () => {
    try {
      const b = await getJson<{ zones: ManualZone[]; rule: ZoneRule }>('/api/piyasa/elle-zonlar')
      setManualZones(b.zones)
      setRule(b.rule)
    } catch (err) {
      setError(`Elle zonlar okunamadı: ${(err as Error).message}`)
    }
  }, [])
  useEffect(() => {
    void reloadZones()
  }, [tokens.manual, reloadZones])
  useEffect(() => {
    manualLayer.current?.setZones(manualZones)
  }, [manualZones])
  useEffect(() => {
    manualLayer.current?.setVisible(prefs.layers.manual)
  }, [prefs.layers.manual])

  // ─── Zon ekleme ve düzenleme ───
  const editZone = zone.editId === null ? null : (manualZones.find((z) => z.id === zone.editId) ?? null)
  const conflicts = useMemo(
    () => (zone.draft && rule ? zoneConflicts(manualZones, zone.draft.lo, zone.draft.hi, rule.threshold, zone.editId) : []),
    [zone.draft, zone.editId, manualZones, rule],
  )
  const warnings = useMemo(
    () => (zone.draft && rule ? zoneWarnings(zone.draft.lo, zone.draft.hi, { ...rule, price: listPrice ?? rule.price }) : []),
    [zone.draft, rule, listPrice],
  )
  useEffect(() => {
    manualLayer.current?.setEdit(
      zone.mode === 'off'
        ? null
        : {
            hideId: zone.editId,
            marks: new Map(conflicts.map((c) => [c.id, c.kind])),
            draft: zone.draft,
            first: zone.first,
            label: zone.editId === null ? 'yeni' : `#${zone.editId}`,
          },
    )
  }, [zone, conflicts])
  useEffect(() => {
    if (!ready) return
    try {
      localStorage.setItem(ZONE_PREFS_KEY, JSON.stringify({ magnet }))
    } catch {
      // yalnız bu sekmede
    }
  }, [magnet, ready])
  useEffect(() => {
    if (!zoneMsg) return
    const t = setTimeout(() => setZoneMsg(null), 10_000)
    return () => clearTimeout(t)
  }, [zoneMsg])

  const resetZoneUi = () => {
    setKeep(new Set())
    setConfirm(null)
    setZoneErr(null)
  }
  const startZone = () => {
    setPrefs((p) => (p.layers.manual ? p : { ...p, layers: { ...p.layers, manual: true } }))
    resetZoneUi()
    setZoneMsg(null)
    setBreaksFrom(DEFAULT_BREAKS_DAY)
    setZone({ mode: 'draw', first: null, draft: null, editId: null })
    if (!rule) void reloadZones()
  }
  const cancelZone = () => {
    setZone(ZONE_OFF)
    resetZoneUi()
  }
  const selectZone = (id: number) => {
    const z = manualRef.current.find((x) => x.id === id)
    if (!z) return
    setPrefs((p) => (p.layers.manual ? p : { ...p, layers: { ...p.layers, manual: true } }))
    resetZoneUi()
    setZoneMsg(null)
    setZone({ mode: 'adjust', first: null, draft: { lo: z.lo, hi: z.hi }, editId: id })
  }
  const selectZoneRef = useRef(selectZone)
  selectZoneRef.current = selectZone

  const post = async (url: string, body?: unknown) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status === 401) window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`
    return { res, body: (await res.json().catch(() => null)) as Record<string, unknown> | null }
  }
  const saveZone = async () => {
    const d = zone.draft
    if (!d || !rule || zoneBusy) return
    if (confirm !== 'save' && (zone.editId !== null || conflicts.length > 0 || warnings.length > 0)) {
      setConfirm('save')
      return
    }
    setZoneBusy(true)
    setZoneErr(null)
    try {
      const { res, body } = await post('/api/piyasa/elle-zonlar', {
        lo: d.lo,
        hi: d.hi,
        editId: zone.editId,
        seen: conflicts.map((c) => c.id),
        end: conflicts.filter((c) => !keep.has(c.id)).map((c) => c.id),
        breaksFrom: zone.editId === null ? new Date(`${breaksFrom}T00:00:00+03:00`).toISOString() : null,
      })
      if (!res.ok) {
        setConfirm(null)
        setZoneErr(String(body?.error ?? `HTTP ${res.status}`))
        if (res.status === 404 || res.status === 409) await reloadZones()
        return
      }
      const z = body!.zone as { id: number }
      const ended = body!.ended as number[]
      setZoneMsg(`#${z.id} eklendi${ended.length ? `; ${ended.map((x) => `#${x}`).join(', ')} pasife alındı` : ''}. SDL en geç 1 dakikada görür.`)
      setZone(ZONE_OFF)
      resetZoneUi()
      await reloadZones()
    } catch (err) {
      setConfirm(null)
      setZoneErr(`Kaydedilemedi: ${(err as Error).message}`)
    } finally {
      setZoneBusy(false)
    }
  }
  const endZoneNow = async () => {
    const id = zone.editId
    if (id === null || zoneBusy) return
    if (confirm !== 'end') {
      setConfirm('end')
      return
    }
    setZoneBusy(true)
    setZoneErr(null)
    try {
      const { res, body } = await post(`/api/piyasa/elle-zonlar/${id}/kapat`)
      if (!res.ok) {
        setConfirm(null)
        setZoneErr(String(body?.error ?? `HTTP ${res.status}`))
        if (res.status === 404) await reloadZones()
        return
      }
      setZoneMsg(`#${id} pasife alındı. SDL en geç 1 dakikada görür.`)
      setZone(ZONE_OFF)
      resetZoneUi()
      await reloadZones()
    } catch (err) {
      setConfirm(null)
      setZoneErr(`Pasife alınamadı: ${(err as Error).message}`)
    } finally {
      setZoneBusy(false)
    }
  }
  const keyRef = useRef({ zone, confirm, saveZone, endZoneNow, cancelZone })
  keyRef.current = { zone, confirm, saveZone, endZoneNow, cancelZone }
  useEffect(() => {
    if (zone.mode === 'off') return
    const onKey = (e: KeyboardEvent) => {
      const k = keyRef.current
      if (e.key === 'Escape') {
        e.preventDefault()
        if (k.confirm) setConfirm(null)
        else k.cancelZone()
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        if (k.confirm === 'end') void k.endZoneNow()
        else if (k.zone.mode === 'adjust') void k.saveZone()
        else return
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zone.mode])

  // Heatmap: heatmap ya da cluster katmanı açıksa, seçili pencerenin en yeni snapshot'ı; yenisi gelince yeniden.
  const heatSeq = useRef(0)
  const loadHeat = useCallback(async (span: Span) => {
    const n = ++heatSeq.current
    setHeatBusy(true)
    try {
      const v = await getJson<HeatView>(`/api/piyasa/heatmap?span=${span}`)
      if (n === heatSeq.current) setHeat(v)
    } catch (err) {
      if (n !== heatSeq.current) return
      if (err instanceof HttpError && err.status === 404) setHeat(null)
      else setError(`Heatmap okunamadı: ${(err as Error).message}`)
    } finally {
      if (n === heatSeq.current) setHeatBusy(false)
    }
  }, [])
  const wantHeat = prefs.layers.heat || prefs.layers.clusters
  const latestId = tokens.heat[prefs.span]
  const heatAsked = useRef<string | null>(null) // hangi pencere ve işaret için istendi
  useEffect(() => {
    if (!ready || !wantHeat) return
    const key = `${prefs.span}:${latestId}`
    if (heatAsked.current === key) return
    heatAsked.current = key
    void loadHeat(prefs.span)
  }, [ready, wantHeat, prefs.span, latestId, loadHeat])

  useEffect(() => {
    const at = heat ? Date.parse(heat.snapshot.at) : null
    heatLayer.current?.setData(heat?.grid ?? null, at, at !== null ? `heatmap ${hm.format(at)}` : '')
  }, [heat])
  useEffect(() => {
    heatLayer.current?.setVisible(prefs.layers.heat)
  }, [prefs.layers.heat])

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
    const ref = listPrice
    if (!prefs.layers.clusters || !heat || ref === null) {
      heatLayer.current?.setExtent(null)
      return
    }
    const near = (c: { price: number } | undefined) => (c && Math.abs(c.price - ref) / ref < 0.06 ? c.price : ref)
    const up = [...heat.up].sort((a, b) => a.price - b.price).find((c) => c.price > ref)
    const dn = [...heat.dn].sort((a, b) => b.price - a.price).find((c) => c.price < ref)
    heatLayer.current?.setExtent([near(dn), near(up)])
  }, [heat, listPrice, prefs.layers.clusters])

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

  // Son fiyat (canlı quote, yoksa son 1m kapanışı): eksende beyaz etiket.
  useEffect(() => {
    const se = series.current
    const C = colors.current
    if (!se || !C || shownPrice === null) return
    const price = shownPrice
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
  }, [shownPrice])

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
          <button
            type="button"
            className={s.chip}
            aria-pressed={zone.mode !== 'off'}
            onClick={() => (zone.mode === 'off' ? startZone() : cancelZone())}
            title="Grafikte yeni elle zon çiz"
          >
            {zone.mode === 'off' ? '+ Zon ekle' : 'Zon çizimini kapat'}
          </button>
        </div>
      </div>
      {wantHeat && (
        <div className={s.heatbar}>
          <span className={s.heatLabel}>Heatmap</span>
          <div className={s.seg} role="radiogroup" aria-label="Heatmap penceresi">
            {SPANS.map((sp) => (
              <button key={sp} type="button" role="radio" aria-checked={prefs.span === sp} onClick={() => setPrefs((p) => ({ ...p, span: sp }))}>
                {sp}
              </button>
            ))}
          </div>
          <p className={s.updated}>
            Son güncelleme <time className="num">{at ? dmh.format(at) : '—'}</time>
          </p>
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
        <div
          ref={host}
          className={`${s.chart} ${zone.mode === 'draw' ? s.drawing : ''}`}
          role="img"
          aria-label={`Axi BTCUSD ${prefs.tf} mumları; açık katmanlar ve ayrıntıları aşağıda`}
        />
        <div ref={tip} className={s.tip} hidden />
        {count === 0 && <p className={s.empty}>Bu dilimde henüz mum yok.</p>}
      </div>
      {zone.mode !== 'off' && (
        <ZonePanel
          mode={zone.mode}
          editId={zone.editId}
          editZone={editZone}
          first={zone.first}
          draft={zone.draft}
          rule={rule}
          conflicts={conflicts}
          keep={keep}
          warnings={warnings}
          breaksFrom={breaksFrom}
          magnet={magnet}
          confirm={confirm}
          busy={zoneBusy}
          error={zoneErr ?? (zone.editId !== null && !editZone ? `#${zone.editId} artık geçerli değil` : null)}
          onDraft={(lo, hi) => setZone((z) => ({ ...z, draft: { lo, hi } }))}
          onKeep={(id, k) =>
            setKeep((prev) => {
              const next = new Set(prev)
              if (k) next.add(id)
              else next.delete(id)
              return next
            })
          }
          onBreaksFrom={setBreaksFrom}
          onMagnet={setMagnet}
          onSave={() => void saveZone()}
          onEnd={() => void endZoneNow()}
          onBack={() => setConfirm(null)}
          onCancel={cancelZone}
        />
      )}
      {zoneMsg && zone.mode === 'off' && (
        <p className={s.zMsg} role="status">
          {zoneMsg}
        </p>
      )}
      <div className={s.details}>
        {prefs.layers.manual && <ManualList zones={manualZones} price={listPrice} onEdit={selectZone} />}
        {wantHeat && heat && <HeatLevels view={heat} price={listPrice} clusters={prefs.layers.clusters} />}
        {wantHeat && !heat && !heatBusy && <p className={s.muted}>Bu pencerede heatmap snapshot&apos;ı yok.</p>}
        {prefs.layers.prev && <PrevList prev={prev} price={listPrice} />}
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
