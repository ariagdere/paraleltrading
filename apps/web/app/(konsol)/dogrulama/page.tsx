import type { Metadata } from 'next'
import { connection } from 'next/server'
import { AutoRefresh } from '@/components/AutoRefresh'
import { clock, span } from '@/lib/time'
import { calibrate, pairTrades, realR, summarize, type Calibration, type Pair, type SimDecision, type Stats } from '@/lib/validation'
import { loadValidation, type Validation } from '@/lib/validation-data'
import s from './dogrulama.module.css'

export const metadata: Metadata = { title: 'Doğrulama' }

// Naif kuralın doğrulaması: core yeni sistemin verisiyle her 12h snapshot'ında eski sistemin kuralını uygular; sayfa
// kararları eski sistemin gerçek naif işlemleriyle karşılaştırır. Yeniden oynatma eski döngülerin snapshot'larıyla
// (eski sistemden kopyalananlar), ileri izleme yeni sistemin kendi saatlik snapshot'larıyla.

const fmtP = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 })
const fmt1 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const fmt2 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const signed = (v: number, f = fmt2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${f.format(Math.abs(v))}`
const rText = (r: number | null) => (r === null ? '—' : `${signed(r)} R`)

const REASON: Record<string, string> = {
  seviye_yok: 'heatmap seviyesi yok',
  cluster_yok: 'fiyatın iki yanında cluster yok',
  bolge_yok: '4h geçmişi yetmiyor',
  bolge_farkli: 'ZLEMA bölgesi farklı',
  pencere_disi: 'pencere dışı',
  fiyat_yok: 'Axi fiyatı yok',
  gecersiz_seviye: 'TP ya da SL Axi fiyatının yanlış tarafında',
  karar_yok: 'snapshot yok',
  sinyal_yok: 'sinyal yok',
}
const ZONE: Record<string, string> = { LONG: 'long', SHORT: 'short', NO_TRADE: 'işlem yok' }
const DIR = { LONG: { glyph: '↑', text: 'Long' }, SHORT: { glyph: '↓', text: 'Short' } } as const

export default async function DogrulamaPage() {
  await connection()
  let v: Validation | null
  try {
    v = await loadValidation()
  } catch (err) {
    console.error(`[web] doğrulama okunamadı: ${(err as Error).message}`)
    return (
      <>
        <AutoRefresh everyMs={60_000} />
        <h1 className={s.title}>Veritabanına bağlanılamadı.</h1>
        <p className={s.lead}>{(err as Error).message}. Sayfa dakikada bir yeniden dener.</p>
      </>
    )
  }
  if (!v || v.decisions.length === 0) {
    return (
      <>
        <AutoRefresh everyMs={60_000} />
        <h1 className={s.title}>Doğrulama</h1>
        <p className={s.lead}>
          Henüz karar yok. Core naif kuralı her 12h heatmap snapshot&apos;ında hesaplar; ilk açılışta 18 Eylül&apos;den bu yana bütün snapshot&apos;ları bir
          turda işler.
        </p>
      </>
    )
  }

  const { now, decisions, reals } = v
  const forwardFrom = decisions.find((d) => d.source === 'collector')?.cycleAt ?? null
  const isForward = (t: number) => forwardFrom !== null && t >= forwardFrom - 10 * 60_000
  const { pairs, unmatchedSignals } = pairTrades(reals, decisions)
  const periods = [
    { key: 'replay', title: 'Yeniden oynatma', sub: "eski döngülerin snapshot'ları", fwd: false },
    { key: 'forward', title: 'İleri izleme', sub: "yeni sistemin saatlik snapshot'ları", fwd: true },
  ].map((p) => {
    const dec = decisions.filter((d) => isForward(d.cycleAt) === p.fwd)
    const pr = pairs.filter((x) => isForward(x.real.openedAt) === p.fwd)
    const un = unmatchedSignals.filter((d) => isForward(d.cycleAt) === p.fwd)
    return { ...p, stats: summarize(pr, un, dec), from: dec[0]?.cycleAt ?? null, to: dec.at(-1)?.cycleAt ?? null }
  })
  const all = summarize(pairs, unmatchedSignals, decisions)
  const cal = calibrate(pairs)

  return (
    <>
      <AutoRefresh everyMs={60_000} />
      <header className={s.hero}>
        <h1 className={s.title}>
          {all.reals === 0 ? (
            'Bu dönemde gerçek naif işlem yok.'
          ) : (
            <>
              {all.reals} gerçek naif işlemin {all.paired} tanesinde yeni sistem de aynı sinyali verdi
              {all.closedBoth > 0 && (
                <>
                  ; kapanan {all.closedBoth} işlemin {all.sameExit === all.closedBoth ? 'hepsinde' : `${all.sameExit} tanesinde`} sonuç da aynı
                </>
              )}
              .
            </>
          )}
        </h1>
        <p className={s.lead}>
          Eski sistemin naif kuralı birebir: setup heatmap cluster&apos;larından, yön ZLEMA 4h bölgesiyle aynıysa ve döngü penceredeyse emir. Tek fark bölgenin
          kaynağı: eski sistem Binance vadeli 4h, yeni sistem Axi 4h (oluşan mum 1m mumlarından). İşlemler Axi 1m mumlarıyla benzetiliyor. Son hesap{' '}
          <time className="num">{clock(v.computedAt, now)}</time>.
        </p>
      </header>

      <section className={s.section} aria-labelledby="ozet">
        <h2 id="ozet" className={s.h2}>
          Özet
        </h2>
        <div className={s.scroll}>
          <table className={`${s.table} ${s.narrow}`}>
            <thead>
              <tr>
                <th scope="col" />
                {periods.map((p) => (
                  <th key={p.key} scope="col" className={s.r}>
                    {p.title}
                    <span className={s.colSub}>{p.from !== null ? `${nb(clock(new Date(p.from), now))} – ${nb(clock(new Date(p.to!), now))}` : p.sub}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <Row label="Karar (12h snapshot)" cells={periods.map((p) => fmtP.format(p.stats.decisions))} />
              <Row label="Sinyal" note="yön bölgeyle aynı, döngü penceredeyken" cells={periods.map((p) => fmtP.format(p.stats.signals))} />
              <Row label="Gerçek naif işlem" note="eski sistem, magic 7575" cells={periods.map((p) => fmtP.format(p.stats.reals))} />
              <Row label="Karşılığında sinyal olan" cells={periods.map((p) => ratio(p.stats.paired, p.stats.reals))} />
              <Row
                label="TP ve SL aynı"
                note="eşleşenlerde, ±1 kuruş"
                cells={periods.map((p) => (p.stats.paired ? `TP ${ratio(p.stats.sameTp, p.stats.paired)}, SL ${ratio(p.stats.sameSl, p.stats.paired)}` : '—'))}
              />
              <Row label="Sonuç aynı" note="ikisi de kapanmışlarda, TP ya da SL" cells={periods.map((p) => ratio(p.stats.sameExit, p.stats.closedBoth))} />
              <Row
                label="R: gerçek, benzetim"
                note="aynı işlemler"
                cells={periods.map((p) => (p.stats.closedBoth ? `${signed(p.stats.realR)}, ${signed(p.stats.simR)}` : '—'))}
              />
              <Row label="Gerçek işlem, sinyal yok" cells={periods.map((p) => missed(p.stats))} />
              <Row
                label="Sinyal, gerçek işlem yok"
                note="benzetim R'si"
                cells={periods.map((p) => (p.stats.simOnly ? `${p.stats.simOnly} (${signed(p.stats.simOnlyR)} R)` : '0'))}
              />
            </tbody>
          </table>
        </div>
      </section>

      <Calib cal={cal} />

      <section className={s.section} aria-labelledby="gercek">
        <h2 id="gercek" className={s.h2}>
          Gerçek naif işlemler ve karşılıkları
        </h2>
        <div className={s.scroll}>
          <table className={`${s.table} ${s.list}`}>
            <thead>
              <tr>
                <th scope="col">Açılış</th>
                <th scope="col">Yön</th>
                <th scope="col" className={s.r}>
                  Dolum
                </th>
                <th scope="col" className={s.r}>
                  TP / SL
                </th>
                <th scope="col">Gerçek</th>
                <th scope="col">Benzetim</th>
                <th scope="col" className={s.r}>
                  Giriş farkı
                </th>
                <th scope="col">Eşleşme</th>
              </tr>
            </thead>
            <tbody>
              {[...pairs].reverse().map((p) => (
                <RealRow key={p.real.id} p={p} now={now} />
              ))}
            </tbody>
          </table>
        </div>
        <p className={s.note}>
          Giriş farkı gerçek dolumla benzetimin girişi arasında, aleyhe pozitif: BUY ask&apos;tan, SELL bid&apos;den; benzetimde fiyat karar anındaki
          (heatmap&apos;in son sütunu + 45 sn) Axi 1m mumunun açılışı. Eşleşme: aynı Apify çalıştırması ya da (eski sistemin snapshot&apos;ı kopyalanmadıysa)
          ±20 dk içindeki karar.
        </p>
      </section>

      <section className={s.section} aria-labelledby="fazla">
        <h2 id="fazla" className={s.h2}>
          Gerçek işlemi olmayan sinyaller
        </h2>
        {unmatchedSignals.length === 0 ? (
          <p className={s.muted}>Yok: her sinyalin gerçek bir karşılığı var.</p>
        ) : (
          <>
            <div className={s.scroll}>
              <table className={`${s.table} ${s.list}`}>
                <thead>
                  <tr>
                    <th scope="col">Döngü</th>
                    <th scope="col">Yön</th>
                    <th scope="col" className={s.r}>
                      Giriş
                    </th>
                    <th scope="col" className={s.r}>
                      TP / SL
                    </th>
                    <th scope="col">Benzetim</th>
                    <th scope="col">Dönem</th>
                  </tr>
                </thead>
                <tbody>
                  {[...unmatchedSignals].reverse().map((d) => (
                    <tr key={d.snapshotId}>
                      <td className="num">{clock(new Date(d.cycleAt), now)}</td>
                      <td>
                        <Dir d={d.direction} />
                      </td>
                      <td className={`num ${s.r}`}>{d.entryPrice !== null ? fmtP.format(d.entryPrice) : '—'}</td>
                      <td className={`num ${s.r}`}>{levels(d.tp, d.sl)}</td>
                      <td>
                        <Sim d={d} />
                      </td>
                      <td className={s.muted}>{d.source === 'old_db' ? 'eski döngü' : 'yeni sistem'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={s.note}>
              Eski döngüde (yeniden oynatma) gerçek işlem yoksa ya eski sistemin bölgesi (Binance) farklıydı ya da sinyal emre dönüşmedi. Yeni sistemin
              snapshot&apos;ları saatlik; eski sistem her saat döngü çalıştırmıyor, bu yüzden ileri izlemede gerçek karşılığı olmayan sinyal daha çok olur.
            </p>
          </>
        )}
      </section>

      <section className={s.section} aria-labelledby="kural">
        <h2 id="kural" className={s.h2}>
          Kural
        </h2>
        <ul className={s.rules}>
          <li>
            <strong>Setup:</strong> heatmap&apos;in referans fiyatı ile üst ve alt cluster (core&apos;un 1. cluster&apos;ları, iki ondalık) arasında yakın olan
            yön. TP yakın cluster&apos;a mesafenin %75&apos;i, SL uzak cluster&apos;a mesafenin %75&apos;i; fiyatlar heatmap fiyatıyla, eski sistemin gönderdiği
            gibi.
          </li>
          <li>
            <strong>Bölge:</strong> karar anındaki ZLEMA 4h bölgesi, son 150 mum (oluşan mum o ana kadar kapanmış Axi 1m mumlarından). Yön bölgeyle aynıysa
            hizalı.
          </li>
          <li>
            <strong>Pencere:</strong> eski sistemin o tarihteki kuralı: 9 Ekim 15:40&apos;a kadar yalnız hafta içi (pazartesi–cuma, bütün gün), sonra pazartesi
            00:00 – cuma 15:05 (İstanbul, döngünün başladığı an).
          </li>
          <li>
            <strong>İşlem:</strong> karar anı heatmap&apos;in son sütunu + 45 sn (eski sistemde ölçülen gecikme). Axi 1m mumları bid; BUY ask&apos;tan girer
            bid&apos;le çıkar, SELL bid&apos;den girer ask&apos;la çıkar. TP ve SL aynı 1m mumundaysa SL sayılır.
          </li>
        </ul>
      </section>
    </>
  )
}

// dar ekranda "53 / 61" ve "18 Eyl 07:00" bölünmesin
const nb = (x: string) => x.replace(/ /g, ' ')

function ratio(a: number, b: number) {
  return b === 0 ? '—' : `${a} / ${b}`
}

function missed(st: Stats) {
  const parts = Object.entries(st.missedByReason)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${REASON[k] ?? k}`)
  const total = Object.values(st.missedByReason).reduce((a, b) => a + b, 0)
  return total === 0 ? '0' : `${total} (${parts.join(', ')})`
}

function Row({ label, note, cells }: { label: string; note?: string; cells: string[] }) {
  return (
    <tr>
      <th scope="row">
        {label}
        {note && <span className={s.rowNote}>{note}</span>}
      </th>
      {cells.map((c, i) => (
        <td key={i} className={`num ${s.r}`}>
          {c}
        </td>
      ))}
    </tr>
  )
}

function Calib({ cal }: { cal: Calibration }) {
  const rows: Array<[string, string, (number | null)[], (v: number) => string]> = [
    ['Giriş farkı', 'gerçek dolum − benzetim girişi, aleyhe pozitif ($)', cal.entry, (x) => signed(x, fmt1)],
    ['Gecikme', 'gerçek açılış − karar anı (sn)', cal.latency, (x) => signed(x, fmt1)],
    ['TP dolumu', "TP'de kapananlar: kapanış − TP, lehe pozitif ($)", cal.tpFill, (x) => signed(x, fmt1)],
    ['SL kayması', "SL'de kapananlar: SL − kapanış, aleyhe pozitif ($)", cal.slFill, (x) => signed(x, fmt1)],
    ['Çıkış anı farkı', 'aynı sonuçta gerçek − benzetim (dk)', cal.exitLag, (x) => signed(x, fmt1)],
  ]
  return (
    <section className={s.section} aria-labelledby="kalibrasyon">
      <h2 id="kalibrasyon" className={s.h2}>
        Benzetimin gerçeğe yakınlığı
      </h2>
      <div className={s.scroll}>
        <table className={`${s.table} ${s.narrow}`}>
          <thead>
            <tr>
              <th scope="col">
                <span className={s.colSub}>{cal.n} eşleşen sinyal</span>
              </th>
              <th scope="col" className={s.r}>
                %10
              </th>
              <th scope="col" className={s.r}>
                Medyan
              </th>
              <th scope="col" className={s.r}>
                %90
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, note, q, f]) => (
              <tr key={label}>
                <th scope="row">
                  {label}
                  <span className={s.rowNote}>{note}</span>
                </th>
                {q.map((x, i) => (
                  <td key={i} className={`num ${s.r}`}>
                    {x === null ? '—' : f(x)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={s.note}>Sanal broker bu ölçülerle ayarlanacak (giriş kayması, SL kayması, dolum gecikmesi).</p>
    </section>
  )
}

function Dir({ d }: { d: 'LONG' | 'SHORT' | null }) {
  if (!d) return <>—</>
  return (
    <span className={d === 'LONG' ? s.long : s.short}>
      <span aria-hidden="true">{DIR[d].glyph}</span> {DIR[d].text}
    </span>
  )
}

const levels = (tp: number | null, sl: number | null) => `${tp !== null ? fmtP.format(tp) : '—'} / ${sl !== null ? fmtP.format(sl) : '—'}`

function Sim({ d }: { d: SimDecision }) {
  if (!d.signal)
    return (
      <span className={s.muted}>
        sinyal yok: {REASON[d.reason ?? 'sinyal_yok']}
        {d.reason === 'bolge_farkli' && d.zone ? ` (Axi: ${ZONE[d.zone]})` : ''}
      </span>
    )
  if (d.entryPrice === null) return <span className={s.muted}>sinyal; benzetilemedi: {REASON[d.reason ?? 'sinyal_yok']}</span>
  if (d.exitReason === null) return <span>açık</span>
  return (
    <span>
      <strong className={d.exitReason === 'TP' ? s.tp : s.sl}>{d.exitReason}</strong> {rText(d.r)}
      {d.exitAt !== null && <span className={s.muted}> {span(d.exitAt - d.decidedAt)}</span>}
      {d.ambiguous ? <span className={s.muted}> (aynı mumda TP ve SL)</span> : ''}
    </span>
  )
}

function RealRow({ p, now }: { p: Pair; now: Date }) {
  const t = p.real
  const d = p.sim
  const rr = realR(t)
  const entryDiff = d?.signal && d.entryPrice !== null && t.fill !== null ? (t.direction === 'LONG' ? t.fill - d.entryPrice : d.entryPrice - t.fill) : null
  const levelsDiffer = d?.signal && (Math.abs((t.tp ?? 0) - (d.tp ?? 0)) > 0.015 || Math.abs((t.sl ?? 0) - (d.sl ?? 0)) > 0.015)
  return (
    <tr>
      <td className="num">{clock(new Date(t.openedAt), now)}</td>
      <td>
        <Dir d={t.direction} />
      </td>
      <td className={`num ${s.r}`}>{t.fill !== null ? fmtP.format(t.fill) : '—'}</td>
      <td className={`num ${s.r}`}>
        {levels(t.tp, t.sl)}
        {levelsDiffer && <span className={s.diff}>benzetim {levels(d!.tp, d!.sl)}</span>}
      </td>
      <td>
        {t.closedAt === null ? (
          'açık'
        ) : (
          <span>
            <strong className={t.exitReason === 'TP' ? s.tp : t.exitReason === 'SL' ? s.sl : undefined}>{t.exitReason ?? 'kapandı'}</strong> {rText(rr)}
            <span className={s.muted}> {span(t.closedAt - t.openedAt)}</span>
          </span>
        )}
      </td>
      <td>{d ? <Sim d={d} /> : <span className={s.muted}>{REASON.karar_yok}</span>}</td>
      <td className={`num ${s.r}`}>{entryDiff !== null ? `${signed(entryDiff, fmt1)} $` : '—'}</td>
      <td className={s.muted}>{p.match === 'run' ? 'aynı çalıştırma' : p.match === 'time' ? 'zamanla' : 'yok'}</td>
    </tr>
  )
}
