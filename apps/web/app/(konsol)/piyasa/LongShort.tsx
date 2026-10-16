'use client'

import {
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  TickMarkType,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import { useEffect, useRef, useState } from 'react'
import type { AngleRow, LsPeriod, LsSeries, RatioRow } from '@/lib/market-data'
import { clock } from '@/lib/time'
import s from './piyasa.module.css'

// Long/Short: global ve top trader oranının açıları (dört dilim) ve seçili dilimin son 30 noktasının grafiği, eski
// sistemin live ekranındaki gibi: oran, ortalaması (noktalı) ve açının hesaplandığı doğru (kesik). Dilim seçimi
// tarayıcıda hatırlanır; veri sayfanın dakikalık yenilemesiyle gelir.

const PERIODS: LsPeriod[] = ['5m', '15m', '1h', '4h']
const METRICS = [
  ['global', 'Global'],
  ['top_position', 'Top trader'],
] as const
const KEY = 'hakari2.piyasa.ls.v1'

const fmt0 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 })
const fmt2 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt0.format(Math.abs(v))}`
const dir = (a: number) => (a > 5 ? 'up' : a < -5 ? 'down' : 'flat')
const ARROW = { up: '↗', down: '↘', flat: '→' } as const

// İstanbul UTC+3, yaz saati yok: zamanlar 3 saat kaydırılıp kütüphanenin UTC ekseninde gösterilir.
const toChart = (ms: number) => (ms / 1000 + 3 * 3600) as UTCTimestamp
const utc = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('tr-TR', { timeZone: 'UTC', ...o })
const fTime = utc({ hour: '2-digit', minute: '2-digit' })
const fDay = utc({ day: 'numeric', month: 'short' })
const fFull = utc({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

function rgba(hex: string, a: number) {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

function Angle({ a }: { a: AngleRow | undefined }) {
  if (a?.angle == null) return <>—</>
  const d = dir(a.angle)
  return (
    <span className={s[d]}>
      <span aria-hidden="true" className={s.arrow}>
        {ARROW[d]}
      </span>
      {signed(a.angle)}°
    </span>
  )
}

export function LongShort({ angles, ratios, series, now }: { angles: AngleRow[]; ratios: RatioRow[]; series: LsSeries; now: Date }) {
  const [period, setPeriod] = useState<LsPeriod>('5m')
  useEffect(() => {
    try {
      const v = localStorage.getItem(KEY) as LsPeriod | null
      if (v && PERIODS.includes(v)) setPeriod(v)
    } catch {
      // kapalı depolama: varsayılan 5m
    }
  }, [])
  const choose = (p: LsPeriod) => {
    setPeriod(p)
    try {
      localStorage.setItem(KEY, p)
    } catch {
      // yalnız bu sekmede
    }
  }
  const angle = (m: string, p: string) => angles.find((x) => x.metric === m && x.period === p)
  const last = ratios.reduce<Date | null>((m, r) => (!m || r.ts > m ? r.ts : m), null)

  return (
    <section className={s.panel} aria-labelledby="ls-title">
      <div className={s.panelHead}>
        <h2 id="ls-title" className={s.h2}>
          Long/Short
        </h2>
        <div className={s.seg} role="radiogroup" aria-label="L/S grafik dilimi">
          {PERIODS.map((p) => (
            <button key={p} type="button" role="radio" aria-checked={period === p} onClick={() => choose(p)}>
              {p}
            </button>
          ))}
        </div>
      </div>
      <div className={s.scroll}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col" className={s.r}>
                Oran
              </th>
              {PERIODS.map((p) => (
                <th key={p} scope="col" className={`${s.r} ${p === period ? s.sel : ''}`}>
                  {p}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {METRICS.map(([m, label]) => {
              const ratio = ratios.find((r) => r.metric === m)
              return (
                <tr key={m}>
                  <th scope="row">{label}</th>
                  <td className={`${s.r} num`}>{ratio ? fmt2.format(ratio.ratio) : '—'}</td>
                  {PERIODS.map((p) => {
                    const a = angle(m, p)
                    return (
                      <td
                        key={p}
                        className={`${s.r} num ${p === period ? s.sel : ''}`}
                        title={
                          a ? `${p} açısı, ${clock(a.ts, now)} noktası${a.angle == null ? '; pencerede eksik nokta ya da referans yetersiz' : ''}` : undefined
                        }
                      >
                        <Angle a={a} />
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {METRICS.map(([m, label]) => (
        <LsChart key={m} label={label} period={period} points={series[m][period]} angle={angle(m, period)} />
      ))}
      <p className={s.note}>
        Grafikler seçili dilimin son 30 noktası: noktalı çizgi ortalama, kesik çizgi açının hesaplandığı doğru. Açı, oranın son 30 noktadaki eğimi; o ana
        kadarki eğimlerin %90&apos;lık değerine göre ölçekli (±90°); pencerede eksik nokta varsa açı yok.{' '}
        {last && (
          <>
            Son nokta <time className="num">{clock(last, now)}</time>.
          </>
        )}
      </p>
    </section>
  )
}

type Chart = { chart: IChartApi; line: ISeriesApi<'Line'>; fit: ISeriesApi<'Line'>; mean: IPriceLine | null; c: Record<string, string> }

function LsChart({ label, period, points, angle }: { label: string; period: LsPeriod; points: Array<[number, number]>; angle: AngleRow | undefined }) {
  const host = useRef<HTMLDivElement>(null)
  const ref = useRef<Chart | null>(null)

  useEffect(() => {
    const el = host.current!
    const st = getComputedStyle(el)
    const v = (n: string) => st.getPropertyValue(n).trim()
    const c = { surface: v('--ink-2'), line: v('--line'), grid: v('--ink-3'), text: v('--text'), muted: v('--muted'), up: v('--up'), down: v('--short') }
    const chart = createChart(el, {
      autoSize: true,
      // kütüphanenin atfı sayfada (fiyat grafiğinin altında); küçük grafiklerde logo yok
      layout: { background: { type: ColorType.Solid, color: c.surface }, textColor: c.muted, fontFamily: st.fontFamily, fontSize: 12, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.line, scaleMargins: { top: 0.15, bottom: 0.12 } },
      timeScale: {
        borderColor: c.line,
        timeVisible: true,
        secondsVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: (t: Time, type: TickMarkType) => (type <= TickMarkType.DayOfMonth ? fDay : fTime).format(Number(t) * 1000),
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: rgba(c.text, 0.35), labelBackgroundColor: c.line },
        horzLine: { color: rgba(c.text, 0.35), labelBackgroundColor: c.line },
      },
      localization: { locale: 'tr-TR', priceFormatter: (p: number) => fmt2.format(p), timeFormatter: (t: Time) => fFull.format(Number(t) * 1000) },
      handleScroll: false,
      handleScale: false,
    })
    const fmt = { type: 'price' as const, precision: 2, minMove: 0.01 }
    const line = chart.addSeries(LineSeries, { color: c.text, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceFormat: fmt })
    const fit = chart.addSeries(LineSeries, {
      color: c.muted,
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      priceFormat: fmt,
    })
    ref.current = { chart, line, fit, mean: null, c }
    return () => {
      chart.remove()
      ref.current = null
    }
  }, [])

  useEffect(() => {
    const r = ref.current
    if (!r) return
    r.line.setData(points.map(([t, value]) => ({ time: toChart(t), value })))
    if (r.mean) r.line.removePriceLine(r.mean)
    r.mean = null
    const n = points.length
    if (n > 0) {
      const mean = points.reduce((a, p) => a + p[1], 0) / n
      r.mean = r.line.createPriceLine({
        price: mean,
        color: rgba(r.c.muted, 0.7),
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
        title: '',
      })
      // Açının doğrusu: eski sistemin windowStats'i ortalamaya göre normalize oranlara x = 0…1 doğrusu oturtur; slope
      // pencere boyunca toplam değişim, doğru ilk noktada ortalama·(1 − slope/2), sonda ortalama·(1 + slope/2).
      const slope = angle?.slope
      const fits = n >= 2 && slope != null && angle!.ts.getTime() === points[n - 1]![0]
      const d = angle?.angle != null ? dir(angle.angle) : 'flat'
      r.fit.applyOptions({ color: d === 'up' ? r.c.up : d === 'down' ? r.c.down : r.c.muted })
      r.fit.setData(
        fits
          ? [
              { time: toChart(points[0]![0]), value: mean * (1 - slope / 2) },
              { time: toChart(points[n - 1]![0]), value: mean * (1 + slope / 2) },
            ]
          : [],
      )
    } else r.fit.setData([])
    r.chart.timeScale().fitContent()
  }, [points, angle])

  return (
    <div className={s.lsBlock}>
      <div className={s.lsHead}>
        <h3 className={s.h3}>{label}</h3>
        <span className="num">
          <Angle a={angle} />
          {angle?.r2 != null && <span className={s.muted}> R² {fmt2.format(angle.r2)}</span>}
        </span>
      </div>
      <div ref={host} className={s.lsChart} role="img" aria-label={`${label} L/S oranı, ${period}, son ${points.length} nokta`} />
    </div>
  )
}
