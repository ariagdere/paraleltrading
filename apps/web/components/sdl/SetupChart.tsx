'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { ChartPayload, ChartSetup } from '@/lib/sdl-chart-shared'
import { dayLabel, drawSetup, fmt, hhmm, resWord, sgn } from './setup-chart'
import s from './setup-chart.module.css'

// Kurulumun iki grafiği (araştırma sayfasındaki gibi): 3m giriş ve çıkış, 15m geniş görünüm. Veri /api/sdl/grafik'ten;
// stamp değişince (bekleyen ve açık işlemde her 3m kapanışı) yeniden okunur. Tablonun içinde açılır: genişlik, satırın
// değil kaydırma kutusunun ([data-scroll]) görünen genişliği; kutu yatay kayarken grafik solda sabit kalır.

const when = (t: number) => `${dayLabel(t, true)} ${hhmm(t)}`

function summary(T: ChartSetup, asOf: number): string {
  const side = T.side === 'LONG' ? 'Long' : 'Short'
  const rr = `1:${fmt(Math.abs(T.tp - T.entry) / Math.abs(T.entry - T.sl), 2)}`
  if (T.kind === 'bekleyen') {
    const under = T.side === 'SHORT' ? 'altında' : 'üstünde'
    const edge = T.side === 'SHORT' ? T.fvgLo : T.fvgHi
    const trig =
      T.status === 'derin'
        ? `FVG’nin ${under} kapanan ilk 3m mumu ${fmt(T.trigger ?? 0, 2)}’nin de ${under} kapanmalı (FVG’nin kenarı ${fmt(edge, 2)}; arada kapanırsa kurulum düşer)`
        : T.status === 'zon'
          ? `önce fiyat #${T.zone} zonuna ulaşmalı, sonra bir 3m kapanışı ${fmt(T.trigger ?? 0, 2)}’nin ${under}`
          : `bir 3m kapanışı ${fmt(T.trigger ?? 0, 2)}’nin ${under}`
    return (
      `${side}, sırada: ${trig}. Zon #${T.zone} → hedef #${T.tpZone}; girişte yaklaşık SL ${fmt(T.sl, 2)}, TP ${fmt(T.tp, 2)}, ${rr}` +
      ` (iğne şimdiye kadar ${fmt(T.ext, 2)}; fiyat ilerlerse SL de kayar). ${hhmm(asOf)} kapanışına göre` +
      `${T.expiresAt ? `; en geç ${hhmm(T.expiresAt)} kapanışında dönebilir` : ''}.`
    )
  }
  const X = T.exit
  const src = X?.source === 'gercek' ? 'gerçek işlem' : X?.source === 'benzetim' ? 'benzetim' : T.real ? 'gerçek işlem' : 'benzetim'
  const res = !X
    ? ''
    : X.kind === 'OPEN'
      ? `açık, ${when(X.t)} itibarıyla ${sgn(X.r)}R (${src})`
      : `${resWord(X.kind)} ${when(X.t)}, ${sgn(X.r)}R (${src})`
  return `${side}, ${when(T.entryT)}: zon #${T.zone} → hedef #${T.tpZone}; giriş ${fmt(T.entry, 2)}${T.real ? ' (dolum)' : ''}, SL ${fmt(T.sl, 2)}, TP ${fmt(T.tp, 2)}, ${rr}. Sonuç: ${res}.`
}

export function SetupChart({ query, stamp }: { query: string; stamp?: string | number }) {
  const [data, setData] = useState<ChartPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const a = useRef<HTMLDivElement>(null)
  const b = useRef<HTMLDivElement>(null)
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')

  useEffect(() => {
    const ctl = new AbortController()
    fetch(`/api/sdl/grafik?${query}`, { cache: 'no-store', signal: ctl.signal })
      .then(async (res) => {
        const j = (await res.json().catch(() => null)) as (ChartPayload & { error?: string }) | null
        if (!res.ok || !j) throw new Error(j?.error ?? `Grafik okunamadı (HTTP ${res.status}).`)
        return j
      })
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message)
      })
    return () => ctl.abort()
  }, [query, stamp])

  useEffect(() => {
    const p = panel.current
    if (!p) return
    const box = (p.closest('[data-scroll]') as HTMLElement | null) ?? p.parentElement ?? p
    const draw = () => {
      p.style.width = `${box.clientWidth}px`
      if (!data) return
      if (a.current) drawSetup(a.current, data.setup, data.c3, 3, 'A', data.future3, uid)
      if (b.current) drawSetup(b.current, data.setup, data.c15, 15, 'B', data.future15, uid)
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(box)
    return () => ro.disconnect()
  }, [data, uid])

  const T = data?.setup
  const P = T?.kind === 'bekleyen'
  const open = T?.exit?.kind === 'OPEN'
  const span = (c: { t: number }[], tf: number, end: number) =>
    c.length ? `${when(c[0]!.t)} → ${P ? `${hhmm(end)} kapanışı` : when(open ? end : c[c.length - 1]!.t + tf)}` : 'mum yok'
  return (
    <div ref={panel} className={s.panel}>
      {error ? (
        <p className={s.error}>{error}</p>
      ) : !data || !T ? (
        <p className={s.muted}>Grafik yükleniyor…</p>
      ) : (
        <>
          <p className={s.summary}>{summary(T, data.asOf)}</p>
          <figure className={s.fig}>
            <figcaption>
              {P ? 'Sırada' : 'Giriş ve çıkış'} · 3 dakikalık, {span(data.c3, 3 * 60_000, data.asOf)}
              {open ? ' (verinin sonu; işlem açık)' : P ? '; sağda planlanan pozisyon' : ''}
            </figcaption>
            <div ref={a} className={s.chart} />
          </figure>
          <figure className={s.fig}>
            <figcaption>
              Geniş görünüm · 15 dakikalık, {span(data.c15, 15 * 60_000, data.asOf)}
              {open ? ' (verinin sonu; işlem açık)' : ''}
            </figcaption>
            <div ref={b} className={s.chart} />
          </figure>
          <p className={s.legend}>
            {P
              ? '1 iğne (şimdiye kadarki en uç fitil), 2 FVG, 3 tetik; kesik çizgi tetik seviyesi. Sağdaki soluk kutu planlanan pozisyon: yeşil giriş–hedef, kırmızı giriş–stop.'
              : '1 iğne, 2 FVG, 3 giriş (dönüş mumunun kapanışı). Yeşil alan giriş–hedef, kırmızı alan giriş–stop; kesik çizgi girişten çıkışa.'}{' '}
            Mor bantlar elle zonlar (giriş ve hedef zonu koyu). Mumlar bid; üzerine gelince ayrıntı.
          </p>
        </>
      )}
    </div>
  )
}
