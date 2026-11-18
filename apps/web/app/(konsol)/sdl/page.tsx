import type { Metadata } from 'next'
import { connection } from 'next/server'
import { AutoRefresh } from '@/components/AutoRefresh'
import { loadSdl, type SdlData, type SdlRow } from '@/lib/sdl-data'
import { clock, span } from '@/lib/time'
import s from './sdl.module.css'

export const metadata: Metadata = { title: 'SDL' }

// SDL v3, elle zonlar: core her 3m kapanışında kurulum arar ve kural kararını yazar; emir Railway'deki anahtar
// (SDL_TRADING_ENABLED) ve bu sayfadaki NO TRADE düğmesi açıksa gider (magic 15033; eski sistemin /live ekranında
// "SDL_v3 - Manuel Zone No Cap"). Geçmişin tekrarı aynı kurallarla saatte bir.

const fmt2 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtLot = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const signed = (v: number, unit = '') => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt2.format(Math.abs(v))}${unit}`
const usd = (v: number) => `${v < 0 ? '−' : v > 0 ? '+' : ''}$${fmt2.format(Math.abs(v))}`

const REASON: Record<string, string> = {
  hafta_sonu: 'hafta sonu',
  donusum: 'dönüşüm şartı',
  haber: 'haber',
  lot: 'en küçük lotta risk sınırı aşılıyor',
  golge: 'gölge mod',
  no_trade: 'NO TRADE',
  gec: 'kapanıştan 60 sn geçti',
  belirsiz_emir: 'sonucu belirsiz emir var',
  emir_hatasi: 'emir gönderilemedi',
}
const ORDER: Record<string, string> = { FILLED: 'doldu', REJECTED: 'reddedildi', UNKNOWN: 'sonucu belirsiz', SUBMITTING: 'gönderiliyor' }
const NOTICE: Record<string, string> = {
  acildi: 'Düğme açıldı: Railway anahtarı da açıksa bir sonraki kurulumda emir gider.',
  kapandi: 'NO TRADE: yeni işlem açılmaz; açık işlemler SL/TP’leriyle sürüyor.',
  hata: 'Düğme değiştirilemedi; sayfayı yenileyip tekrar dene.',
}
const STREAM: Record<string, string> = { ready: 'bağlı', connecting: 'bağlanıyor', error: 'hata', off: 'kapalı (MetaApi değişkenleri yok)' }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

export default async function SdlPage({ searchParams }: Props) {
  await connection()
  const sp = await searchParams
  const notice = typeof sp.dugme === 'string' ? (NOTICE[sp.dugme] ?? null) : null
  let d: SdlData
  try {
    d = await loadSdl()
  } catch (err) {
    console.error(`[web] SDL okunamadı: ${(err as Error).message}`)
    return (
      <>
        <AutoRefresh everyMs={60_000} />
        <h1 className={s.title}>Veritabanına bağlanılamadı.</h1>
        <p className={s.lead}>{(err as Error).message}. Sayfa dakikada bir yeniden dener.</p>
      </>
    )
  }
  const { now, status } = d
  const health = new Map(d.health.map((h) => [h.source, h]))
  const karar = health.get('sdl:karar')
  const tekrar = health.get('sdl:tekrar')
  const emir = health.get('sdl:emir')
  const coreAlive = status !== null && now.getTime() - new Date(status.updatedAt).getTime() < 10 * 60_000
  const mode = !status ? 'yok' : !status.tradingEnabled ? 'golge' : d.switchOn ? 'acik' : 'notrade'
  const level = mode === 'acik' ? 'ok' : mode === 'notrade' ? 'late' : 'idle'

  return (
    <>
      <AutoRefresh everyMs={30_000} />
      <header className={s.hero}>
        <div className={s.heroTop}>
          <h1 className={s.title} data-level={level}>
            <span className={s.dot} aria-hidden="true" />
            {mode === 'acik'
              ? 'SDL işlemde: kurallardan geçen kurulumda emir gider.'
              : mode === 'notrade'
                ? 'NO TRADE: yeni işlem açılmıyor.'
                : mode === 'golge'
                  ? 'Gölge mod: kararlar yazılıyor, emir gitmiyor.'
                  : 'SDL henüz çalışmadı.'}
          </h1>
          <form method="post" action="/api/sdl/dugme" className={s.switchForm}>
            <input type="hidden" name="durum" value={d.switchOn ? 'kapat' : 'ac'} />
            <button className={s.switchButton} data-on={d.switchOn ? 'true' : 'false'} type="submit">
              {d.switchOn ? 'NO TRADE’e al' : 'İşleme aç'}
            </button>
          </form>
        </div>
        <p className={s.lead}>
          SDL v3, elle çizilen zonlarla: hafta içi 07:00–20:00, günün bias yönünde 3m iFVG dönüşü; SL iğne ± 15 $, TP sonraki zonun 15 $ önü; giriş zonu dönüşüm
          zonu olmalı; haberden 1 saat önce dur, 30 dk sonra başla. İşlem sınırı ve 3 kayıp kuralı yok. Risk{' '}
          {status ? `${fmt2.format(status.riskUsd)} $` : '10 $'} (lot aşağı yuvarlanır; en küçük lotta en çok{' '}
          {status ? `${fmt2.format(status.minLotMaxRiskUsd)} $` : '20 $'}), magic {status?.magic ?? 15033}; eski sistemin /live ekranında “SDL_v3 - Manuel Zone No
          Cap”.
        </p>
        {notice && <p className={s.notice}>{notice}</p>}
        <dl className={s.facts}>
          <div>
            <dt>Railway anahtarı</dt>
            <dd>{!status ? 'core henüz yazmadı' : status.tradingEnabled ? 'açık (SDL_TRADING_ENABLED=true)' : 'kapalı: gölge mod'}</dd>
          </div>
          <div>
            <dt>NO TRADE düğmesi</dt>
            <dd>
              {d.switchOn ? 'işlem açık' : 'NO TRADE'}
              {d.switchChangedAt && <span className={s.sub}>son değişiklik {clock(new Date(d.switchChangedAt), now)}</span>}
            </dd>
          </div>
          <div>
            <dt>Fiyat akışı</dt>
            <dd>
              {status ? (STREAM[status.streamState] ?? status.streamState) : '—'}
              {status?.lastQuoteAt && <span className={s.sub}>son fiyat {span(now.getTime() - new Date(status.lastQuoteAt).getTime())} önce</span>}
              {status?.streamError && status.streamState !== 'ready' && <span className={s.sub}>{status.streamError}</span>}
            </dd>
          </div>
          <div>
            <dt>Son karar</dt>
            <dd>
              {karar?.lastSourceTime ? `${clock(new Date(new Date(karar.lastSourceTime).getTime() + 180_000), now)} kapanışı` : '—'}
              {!coreAlive && status && <span className={s.warn}>core 10 dakikadır yazmıyor</span>}
              {karar && karar.failures > 0 && <span className={s.warn}>{karar.lastError}</span>}
            </dd>
          </div>
          <div>
            <dt>Emir hatası</dt>
            <dd>{emir && emir.failures > 0 ? <span className={s.warn}>{emir.lastError}</span> : 'yok'}</dd>
          </div>
          <div>
            <dt>Geçmişin tekrarı</dt>
            <dd>
              {tekrar?.lastSuccessAt ? `son ${clock(new Date(tekrar.lastSuccessAt), now)}, saatte bir` : '—'}
              {tekrar && tekrar.failures > 0 && <span className={s.warn}>{tekrar.lastError}</span>}
            </dd>
          </div>
        </dl>
      </header>

      <section className={s.section} aria-labelledby="canli">
        <h2 id="canli" className={s.h2}>
          Canlı kararlar, son 14 gün
        </h2>
        {d.live.length === 0 ? (
          <p className={s.muted}>Henüz kurulum yok.</p>
        ) : (
          <div className={s.scroll}>
            <Table rows={d.live} now={now} live />
          </div>
        )}
        <p className={s.note}>
          Sonuç eski sistemin kaydından (saatte bir kopyalanıyor); R = gerçekleşen kâr / (|dolum − SL| × lot). Benzetim: aynı SL/TP’yle resmi 1m mumlarında ne
          olurdu.
        </p>
      </section>

      <Replay rows={d.replay} now={now} />

      <section className={s.section} aria-labelledby="zonlar">
        <h2 id="zonlar" className={s.h2}>
          Elle zonlar
        </h2>
        <div className={s.scroll}>
          <table className={`${s.table} ${s.narrow}`}>
            <thead>
              <tr>
                <th scope="col">No</th>
                <th scope="col" className={s.r}>
                  Alt
                </th>
                <th scope="col" className={s.r}>
                  Üst
                </th>
                <th scope="col">Geçerli</th>
              </tr>
            </thead>
            <tbody>
              {d.zones.map((z) => (
                <tr key={z.id}>
                  <th scope="row" className="num">
                    #{z.id}
                  </th>
                  <td className={`num ${s.r}`}>{fmt2.format(z.lo)}</td>
                  <td className={`num ${s.r}`}>{fmt2.format(z.hi)}</td>
                  <td>
                    {clock(new Date(z.createdAt), now)}’dan {z.endedAt ? `${clock(new Date(z.endedAt), now)}’a` : 'beri'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={s.note}>Zon eklemek ya da kapatmak şimdilik veritabanından (elle_zones; kapatırken ended_at, yeni zon yeni numarayla).</p>
      </section>
    </>
  )
}

function reasonText(r: SdlRow): string {
  if (r.decision === 'emir') return 'emir'
  const base = REASON[r.reason ?? ''] ?? r.reason ?? ''
  const dt = r.detail as Record<string, any> | null
  if (r.reason === 'donusum') {
    const lb = dt?.sonKirilma as { t: number; yon: string } | null | undefined
    return lb ? `${base}: son kırılma ${lb.yon === 'up' ? 'yukarı' : 'aşağı'}` : `${base}: zon hiç kırılmamış`
  }
  if (r.reason === 'haber' && typeof dt?.haber === 'number') return `${base} ${clock(new Date(dt.haber))}`
  if ((r.reason === 'emir_hatasi' || r.reason === 'lot') && typeof dt?.hata === 'string') return `${base}: ${dt.hata}`
  return base
}

function Table({ rows, now, live }: { rows: SdlRow[]; now: Date; live?: boolean }) {
  return (
    <table className={s.table}>
      <thead>
        <tr>
          <th scope="col">Giriş</th>
          <th scope="col">Yön</th>
          <th scope="col">Zon</th>
          <th scope="col" className={s.r}>
            Giriş fiyatı
          </th>
          <th scope="col" className={s.r}>
            SL
          </th>
          <th scope="col" className={s.r}>
            TP
          </th>
          <th scope="col" className={s.r}>
            R:R
          </th>
          <th scope="col" className={s.r}>
            Lot · risk
          </th>
          <th scope="col">Karar</th>
          {live && <th scope="col">Emir · sonuç</th>}
          <th scope="col">Benzetim</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <th scope="row" className="num">
              {clock(new Date(r.entryT), now)}
              {live && r.bars && <span className={s.sub}>{r.bars === 'akis' ? 'fiyat akışı' : 'resmi mumlar'}</span>}
            </th>
            <td className={r.side === 'LONG' ? s.long : s.short}>{r.side === 'LONG' ? '↑ Long' : '↓ Short'}</td>
            <td className="num">
              #{r.zoneId} → #{r.tpZoneId}
            </td>
            <td className={`num ${s.r}`}>{fmt2.format(r.entryRef)}</td>
            <td className={`num ${s.r}`}>{fmt2.format(r.sl)}</td>
            <td className={`num ${s.r}`}>{fmt2.format(r.tp)}</td>
            <td className={`num ${s.r}`}>1:{fmt2.format(r.rr)}</td>
            <td className={`num ${s.r}`}>
              {r.volume !== null ? `${fmtLot.format(r.volume)} · ${fmt2.format(r.riskUsd ?? 0)} $` : '—'}
            </td>
            <td className={`${s.reason} ${r.decision === 'emir' ? s.go : s.muted}`}>{reasonText(r)}</td>
            {live && (
              <td className={s.reason}>
                <OrderCell r={r} now={now} />
              </td>
            )}
            <td className="num">
              {r.simExitKind ? (
                <>
                  <span className={r.simExitKind === 'TP' ? s.tp : s.sl}>{r.simExitKind}</span> {signed(r.simR ?? 0, ' R')}
                  {r.simExitAt && <span className={s.sub}>{clock(new Date(r.simExitAt), now)}</span>}
                </>
              ) : (
                <span className={s.muted}>açık</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function OrderCell({ r, now }: { r: SdlRow; now: Date }) {
  const o = r.order
  if (!o) return <span className={s.muted}>—</span>
  const status = ORDER[o.status] ?? o.status
  if (o.status !== 'FILLED') {
    return (
      <>
        <span className={o.status === 'REJECTED' || o.status === 'UNKNOWN' ? s.warn : undefined}>{status}</span>
        {(o.code || o.error) && <span className={s.sub}>{[o.code, o.message, o.error].filter(Boolean).join(' · ')}</span>}
      </>
    )
  }
  const fill = o.legacyFill ?? o.fillPrice
  const vol = o.legacyVolume ?? o.volume
  const sl = o.legacySl ?? r.sl
  const oneR = fill !== null ? Math.abs(fill - sl) * vol : null
  if (o.legacyStatus === 'CLOSED' && o.realizedPnl !== null) {
    return (
      <>
        <span className={o.realizedPnl >= 0 ? s.tp : s.sl}>{usd(o.realizedPnl)}</span>
        {oneR ? ` ${signed(o.realizedPnl / oneR, ' R')}` : ''}
        <span className={s.sub}>
          {o.exitReason ?? 'kapandı'}
          {o.closedAt ? `, ${clock(o.closedAt, now)}` : ''}
        </span>
      </>
    )
  }
  return (
    <>
      {status}
      {fill !== null ? `, ${fmt2.format(fill)}` : ''}
      <span className={s.sub}>pozisyon {o.positionId ?? '?'}{o.legacyStatus ? ` · ${o.legacyStatus === 'OPEN' ? 'açık' : o.legacyStatus}` : ' · eski sistemde henüz yok'}</span>
    </>
  )
}

function Replay({ rows, now }: { rows: SdlRow[]; now: Date }) {
  const trades = rows.filter((r) => r.decision === 'emir')
  const closed = trades.filter((r) => r.simExitKind !== null && r.simR !== null).sort((a, b) => +new Date(a.simExitAt!) - +new Date(b.simExitAt!))
  let cum = 0
  let peak = 0
  let dd = 0
  let dollars = 0
  for (const r of closed) {
    cum += r.simR!
    peak = Math.max(peak, cum)
    dd = Math.max(dd, peak - cum)
    dollars += r.simR! * (r.riskUsd ?? 0)
  }
  const wins = closed.filter((r) => r.simExitKind === 'TP').length
  const first = rows.length ? rows[rows.length - 1]!.day : null
  const skipped = new Map<string, number>()
  for (const r of rows) if (r.decision === 'atla') skipped.set(r.reason ?? '?', (skipped.get(r.reason ?? '?') ?? 0) + 1)
  return (
    <section className={s.section} aria-labelledby="tekrar">
      <h2 id="tekrar" className={s.h2}>
        Geçmişin tekrarı{first ? `, ${first.slice(8, 10)}.${first.slice(5, 7)}’den bu yana` : ''}
      </h2>
      {rows.length === 0 ? (
        <p className={s.muted}>Henüz tekrar yok; core açılışta ve saatte bir hesaplar.</p>
      ) : (
        <>
          <p className={s.summary}>
            {rows.length} kurulumdan {trades.length} işlem
            {closed.length < trades.length ? ` (${trades.length - closed.length} açık)` : ''}: {wins} hedef, {closed.length - wins} stop, toplam{' '}
            <strong className={cum >= 0 ? s.tp : s.sl}>{signed(cum, ' R')}</strong>, en büyük düşüş {fmt2.format(dd)} R; {fmt2.format(10)} $ riskle {usd(dollars)}.
            {skipped.size > 0 &&
              ` Elenen: ${[...skipped.entries()].map(([k, n]) => `${n} ${REASON[k] ?? k}`).join(', ')}.`}
          </p>
          <div className={s.scroll}>
            <Table rows={rows} now={now} />
          </div>
          <p className={s.note}>
            Aynı kurallar resmi mumlarla; bias raporu üretildiği andan geçerli (canlıda rapor tabloya düştüğü anda). Lot en son sembol bilgisiyle, giriş anındaki
            kapanış ve spread’le.
          </p>
        </>
      )}
    </section>
  )
}
