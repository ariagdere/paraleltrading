import type { Metadata } from 'next'
import { connection } from 'next/server'
import { AutoRefresh } from '@/components/AutoRefresh'
import { LivePrice } from '@/components/LivePrice'
import { PriceChart } from '@/components/chart/PriceChart'
import { loadChartTokens, loadPrevLevels, type ChartTokens, type PrevLevels } from '@/lib/chart-data'
import { loadMarket, type BiasRow, type IndicatorRow, type Market, type Zone } from '@/lib/market-data'
import { clock } from '@/lib/time'
import { LongShort } from './LongShort'
import s from './piyasa.module.css'

export const metadata: Metadata = { title: 'Piyasa' }

const fmtP = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 })
const fmt1 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const signed = (v: number, f: Intl.NumberFormat) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${f.format(Math.abs(v))}`
const TF_MS: Record<string, number> = { '15m': 15 * 60_000, '1h': 3_600_000, '4h': 4 * 3_600_000, '1d': 86_400_000 }
const ZONE: Record<Zone, { text: string; glyph: string; cls: string }> = {
  LONG: { text: 'Long', glyph: '▲', cls: 'long' },
  SHORT: { text: 'Short', glyph: '▼', cls: 'short' },
  NO_TRADE: { text: 'İşlem yok', glyph: '–', cls: 'flat' },
}
const BIAS: Record<BiasRow['bias'], string> = { LONG: 'Long', NEUTRAL: 'Nötr', SHORT: 'Short' }
const CONF: Record<BiasRow['confidence'], string> = { LOW: 'düşük güven', MEDIUM: 'orta güven', HIGH: 'yüksek güven' }

export default async function PiyasaPage() {
  await connection() // her istekte veritabanından

  let market: Market
  let tokens: ChartTokens
  let prev: PrevLevels
  try {
    ;[market, tokens, prev] = await Promise.all([loadMarket(), loadChartTokens(), loadPrevLevels(new Date())])
  } catch (err) {
    console.error(`[web] piyasa okunamadı: ${(err as Error).message}`)
    return (
      <>
        <AutoRefresh everyMs={60_000} />
        <h1 className={s.errorTitle}>Veritabanına bağlanılamadı.</h1>
        <p className={s.muted}>
          {(err as Error).message}. Railway&apos;de web servisinin DATABASE_URL değişkenini ve Postgres servisinin çalıştığını kontrol et. Sayfa dakikada bir
          yeniden dener.
        </p>
      </>
    )
  }

  const { now, quote } = market
  const atr4h = market.indicators.find((r) => r.tf === '4h')?.atr ?? null

  return (
    <>
      <AutoRefresh everyMs={60_000} />
      <header className={s.head}>
        <div className={s.quote}>
          <p className={s.sym}>Axi BTCUSD</p>
          <LivePrice
            price={quote?.price ?? null}
            at={quote?.at.toISOString() ?? null}
            prevClose={quote?.prevClose ?? null}
            priceClass={s.price!}
            changeClass={s.change!}
          />
        </div>
        <dl className={s.facts}>
          <div>
            <dt>Baz</dt>
            <dd className="num">{market.basis !== null ? `${signed(market.basis, fmtP)} $` : '—'}</dd>
          </div>
          <div>
            <dt>ATR 4h</dt>
            <dd className="num">{atr4h !== null ? `${fmtP.format(atr4h)} $` : '—'}</dd>
          </div>
          <div>
            <dt>Bias</dt>
            <dd>{market.bias ? `${BIAS[market.bias.bias]}, ${CONF[market.bias.confidence]}` : '—'}</dd>
          </div>
        </dl>
      </header>

      <div className={s.grid}>
        <PriceChart tokens={tokens} price={quote?.price ?? null} prev={prev} />
        <aside className={s.side} aria-label="Göstergeler">
          <Indicators rows={market.indicators} now={now} />
          <LongShort angles={market.angles} ratios={market.ratios} series={market.lsSeries} now={now} />
          <Bias bias={market.bias} now={now} />
        </aside>
      </div>
    </>
  )
}

function Indicators({ rows, now }: { rows: IndicatorRow[]; now: Date }) {
  const order = ['15m', '1h', '4h', '1d']
  const sorted = order.map((tf) => rows.find((r) => r.tf === tf)).filter((r): r is IndicatorRow => !!r)
  return (
    <section className={s.panel} aria-labelledby="ind-title">
      <h2 id="ind-title" className={s.h2}>
        ZLEMA, RSI ve ATR
      </h2>
      {sorted.length === 0 ? (
        <p className={s.muted}>Henüz gösterge yok.</p>
      ) : (
        <div className={s.scroll}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Dilim</th>
                <th scope="col">ZLEMA bölgesi</th>
                <th scope="col" className={s.r}>
                  RSI 14
                </th>
                <th scope="col" className={s.r}>
                  ATR 14
                </th>
                <th scope="col" className={s.r}>
                  Mum
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const z = r.zone ? ZONE[r.zone] : null
                return (
                  <tr key={r.tf}>
                    <th scope="row">{r.tf}</th>
                    <td>
                      {z ? (
                        <span className={`${s.zone} ${s[z.cls]}`}>
                          <span aria-hidden="true">{z.glyph}</span> {z.text}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={`${s.r} num`}>
                      {r.rsi !== null ? fmt1.format(r.rsi) : '—'}
                      {r.rsi !== null && (r.rsi >= 70 || r.rsi <= 30) && <span className={s.flag}>{r.rsi >= 70 ? ' aşırı alım' : ' aşırı satım'}</span>}
                    </td>
                    <td className={`${s.r} num`}>{r.atr !== null ? fmtP.format(r.atr) : '—'}</td>
                    <td className={`${s.r} num ${s.muted}`}>{clock(new Date(r.openTime.getTime() + TF_MS[r.tf]!), now)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className={s.note}>Kapanmış son mumun değerleri. Mum sütunu o mumun kapandığı an.</p>
    </section>
  )
}

function Bias({ bias, now }: { bias: BiasRow | null; now: Date }) {
  return (
    <section className={s.panel} aria-labelledby="bias-title">
      <h2 id="bias-title" className={s.h2}>
        Günlük bias
      </h2>
      {!bias ? (
        <p className={s.muted}>Henüz rapor yok.</p>
      ) : (
        <>
          <p className={s.biasLine}>
            <strong>{BIAS[bias.bias]}</strong>, {CONF[bias.confidence]}
          </p>
          <p className={s.muted}>
            {bias.netDirection}, skor <span className="num">{signed(bias.score, fmtP)}</span>; rapor <time className="num">{clock(bias.committedAt, now)}</time>
          </p>
          {bias.conclusion && <p className={s.conclusion}>{bias.conclusion}</p>}
        </>
      )}
    </section>
  )
}
