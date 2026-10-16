'use client'

import { clock, clockSec } from '@/lib/time'
import { useLive } from './live'

// Sayfa başındaki fiyat: canlı akış varken son quote (bid; Axi mumları bid'den), yoksa son 1m kapanışı.
// Değişim dünkü günlük kapanışa göre.

const fmtP = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 })
const fmt2 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtP.format(Math.abs(v))}`

const NOTE: Record<string, string> = {
  off: ' (canlı fiyat kapalı)',
  error: ' (canlı fiyata bağlanılamadı)',
}

export function LivePrice({
  price,
  at,
  prevClose,
  priceClass,
  changeClass,
}: {
  price: number | null // son 1m kapanışı
  at: string | null // o mumun kapanış anı
  prevClose: number | null
  priceClass: string
  changeClass: string
}) {
  const live = useLive()
  const now = new Date()
  const q = live.quote
  const useQuote = q !== null && (live.state === 'live' || live.state === 'quiet') && (at === null || q.t >= Date.parse(at))
  const shown = useQuote ? q.bid : price
  return (
    <>
      <h1 className={priceClass}>
        <span className="visually-hidden">Axi BTCUSD </span>
        {shown !== null ? fmtP.format(shown) : '—'}
      </h1>
      {shown !== null && (
        <p className={changeClass}>
          {prevClose !== null && (
            <>
              <span className="num">
                {signed(shown - prevClose)} (%{fmt2.format(Math.abs(((shown - prevClose) / prevClose) * 100))}
                {shown >= prevClose ? ' yukarı' : ' aşağı'})
              </span>{' '}
              dünkü kapanıştan,{' '}
            </>
          )}
          {useQuote ? (
            live.state === 'live' ? (
              <>
                canlı <time className="num">{clockSec(new Date(q.t))}</time>
              </>
            ) : (
              <>
                son quote <time className="num">{clock(new Date(q.t), now)}</time>
              </>
            )
          ) : (
            <>
              son 1m mumu <time className="num">{clock(at ? new Date(at) : null, now)}</time>
              <span title={live.error ?? undefined}>{NOTE[live.state] ?? ''}</span>
            </>
          )}
        </p>
      )}
    </>
  )
}
