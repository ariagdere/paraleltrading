import type { Metadata } from 'next'
import Link from 'next/link'
import { connection } from 'next/server'
import type { ReactNode } from 'react'
import { AutoRefresh } from '@/components/AutoRefresh'
import { loadSim, type RunDetail, type RunRow, type RuleCheck, type Side, type SideResult, type SimResults, type Verdict } from '@/lib/sim-data'
import { clock } from '@/lib/time'
import s from './simulasyon.module.css'

export const metadata: Metadata = { title: 'Simülasyon' }

// Kombinasyon simülasyonu: core her ayın 1'inde 04:00'te (ve buradaki düğmeyle) naif setup'ın değişken taramasını
// çalıştırır; Claude rutini sonucu yorumlar. Sayfa seçilen koşunun (yoksa son bitenin) sonucunu, önceki bulgunun arada
// geçen dönemdeki denetimini ve yorumu gösterir.

const fmt0 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 })
const fmt1 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const fmt2 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pct = new Intl.NumberFormat('tr-TR', { style: 'percent', maximumFractionDigits: 0 })
const signed = (v: number, f = fmt1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${f.format(Math.abs(v))}`
const day = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', day: 'numeric', month: 'short' })
const monthName = new Intl.DateTimeFormat('tr-TR', { timeZone: 'UTC', month: 'long', year: 'numeric' })
const nb = (x: string) => x.replace(/ /g, ' ')

const SIDE: Record<Side, string> = { LONG: 'Long', SHORT: 'Short' }
const SIDE_IN: Record<Side, string> = { LONG: "Long'da", SHORT: "Short'ta" }
const VERDICT: Record<Verdict, { word: string; level: string }> = {
  tutuyor: { word: 'Tutuyor', level: 'ok' },
  tutmuyor: { word: 'Tutmuyor', level: 'down' },
  veri_az: { word: 'Veri az', level: 'idle' },
  gecersiz: { word: 'Geçersiz', level: 'late' },
}
const STATUS: Record<RunRow['status'], string> = { istendi: 'sırada', calisiyor: 'çalışıyor', bitti: 'bitti', hata: 'hata' }
const KIND: Record<RunRow['kind'], string> = { aylik: 'Aylık', elle: 'Elle' }
const REQUEST: Record<string, string> = {
  istendi: 'İstek alındı; core bir dakika içinde başlatır, birkaç dakika sürer.',
  zaten: 'Zaten sırada ya da çalışan bir koşu var.',
  hata: 'İstek kaydedilemedi; sayfayı yenileyip tekrar dene.',
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

export default async function SimulasyonPage({ searchParams }: Props) {
  await connection()
  const sp = await searchParams
  const pick = typeof sp.kosu === 'string' && /^\d+$/.test(sp.kosu) ? Number(sp.kosu) : null
  const request = typeof sp.istek === 'string' ? (REQUEST[sp.istek] ?? null) : null
  let data: Awaited<ReturnType<typeof loadSim>>
  try {
    data = await loadSim(pick)
  } catch (err) {
    console.error(`[web] simülasyon okunamadı: ${(err as Error).message}`)
    return (
      <>
        <AutoRefresh everyMs={60_000} />
        <h1 className={s.title}>Veritabanına bağlanılamadı.</h1>
        <p className={s.lead}>{(err as Error).message}. Sayfa dakikada bir yeniden dener.</p>
      </>
    )
  }
  const { now, runs, run } = data
  const pending = runs.find((r) => r.status === 'istendi' || r.status === 'calisiyor') ?? null
  const res = run?.results ?? null

  return (
    <>
      <AutoRefresh everyMs={pending ? 15_000 : 300_000} />
      <header className={s.hero}>
        <div className={s.heroTop}>
          <h1 className={s.title}>{res ? <Headline r={res} /> : 'Simülasyon'}</h1>
          <form method="post" action="/api/simulasyon" className={s.runForm}>
            <button className={s.runButton} type="submit" disabled={pending !== null}>
              {pending ? (pending.status === 'calisiyor' ? `Koşu #${pending.id} çalışıyor…` : `Koşu #${pending.id} sırada…`) : 'Şimdi çalıştır'}
            </button>
          </form>
        </div>
        <p className={s.lead}>
          Naif setup&apos;ın değişken taraması: her 5m kapanışında yakın cluster yönüne 75/75 setup; long ve short ayrı ayrı ZLEMA, L/S açısı ve yakın/uzak cluster
          oranının 1–4 koşullu kombinasyonları, şans testi ve önceki bulgunun denetimi. Her ayın 1&apos;inde 04:00&apos;te kendiliğinden çalışır; Claude&apos;un yorumu
          aynı sabah gelir.
        </p>
        {request && <p className={s.notice}>{request}</p>}
        {run && <RunMeta run={run} now={now} />}
      </header>

      {!run && (
        <p className={s.empty}>Henüz koşu yok. &quot;Şimdi çalıştır&quot;la ilk koşuyu başlat; core bir dakika içinde başlatır, birkaç dakika sürer.</p>
      )}
      {run && run.status === 'hata' && <p className={s.error}>Koşu hata verdi: {run.error ?? 'bilinmiyor'}</p>}

      {run && res && (
        <>
          <CommentCard run={run} now={now} />
          {res.validation && <ValidationSection v={res.validation} />}
          <Summary r={res} />
          <section className={s.section} aria-labelledby="egri">
            <h2 id="egri" className={s.h2}>
              Toplam R, işlem kapandıkça
            </h2>
            <CurveChart
              series={[
                ...(res.combined ? [{ name: 'Birleşik', pts: res.combined.curve, cls: s.lineMain! }] : []),
                { name: 'Filtresiz, iki yön ayrı', pts: res.base2.curve, cls: s.lineMuted! },
              ]}
            />
            <p className={s.note}>
              Birleşik: en iyi long ve en iyi short ayrı yuvalarda; biri açıkken diğerinin sinyali gelirse o da açılır (iki yön birlikte{' '}
              {res.combined ? `${fmt0.format(res.combined.overlapHours)} saat` : '—'} açık kaldı). Düşüşler eğrinin bir önceki zirvesinden inişleri; en büyüğü max DD.
            </p>
          </section>
          <section className={s.section} aria-labelledby="enler">
            <h2 id="enler" className={s.h2}>
              Her yönün en iyi 10 kombinasyonu
            </h2>
            <div className={s.pair}>
              <TopTable side="LONG" r={res.sides.LONG} />
              <TopTable side="SHORT" r={res.sides.SHORT} />
            </div>
          </section>
          <Months r={res} />
        </>
      )}

      <History runs={runs} selected={run?.id ?? null} now={now} />

      <section className={s.section} aria-labelledby="yontem">
        <h2 id="yontem" className={s.h2}>
          Nasıl hesaplanıyor
        </h2>
        <ul className={s.rules}>
          <li>
            Her Axi 5m kapanışında o saatin 12h heatmap&apos;i geldiyse ve bütün değişkenler doluysa: yön yakın cluster&apos;a, TP yakın mesafenin %75&apos;i, SL uzak
            mesafenin %75&apos;i, o anki fiyattan. Fiyat cluster&apos;lardan birine değince bir sonraki heatmap&apos;e kadar setup yok.
          </li>
          <li>Giriş sonraki 1m mumunun açılışında; BUY ask&apos;tan, SELL bid&apos;den; aynı mumda TP ve SL olursa SL. Her yönde aynı anda tek pozisyon.</li>
          <li>
            Değişkenler işlem yönüne göre: ZLEMA 15m, 1h, 4h, 1d (oluşan mumla; aynı, ters, nötr), L/S açısı global ve TT × 5m, 15m, 1h, 4h (0–15°, 15–30°, 30°+;
            aynı ya da ters), yakın/uzak cluster mesafesi oranı (0–0,4, 0,4–0,7, 0,7–1).
          </li>
          <li>
            Kombinasyonlar en az 30 işlemle, toplam R&apos;ye göre sıralı. Şans testi: işlem sonuçları karar anları arasında rastgele kaydırılıp aynı arama 200 kez
            tekrarlanır; en iyi kombinasyon tekrarların %95&apos;inin bulduğundan iyi değilse şansla açıklanabilir.
          </li>
          <li>
            Önceki bulgu: bir önceki aylık koşunun (yoksa bir önceki koşunun) her yöndeki en iyi 10 kombinasyonundan toplam R&apos;si artıda olanlar, o koşunun
            verisinin bittiği andan sonraki kararlarla. En az 10 işlem, toplam R artıda ve işlem başına ortalama aynı dönemin filtresiz tabanından aşağı değilse
            &quot;tutuyor&quot;; kural kazandırsa da filtresiz tabandan kötüyse &quot;tutmuyor&quot;.
          </li>
        </ul>
      </section>
    </>
  )
}

function Headline({ r }: { r: SimResults }) {
  const parts = (['LONG', 'SHORT'] as Side[]).map((side) => {
    const x = r.sides[side]
    const best = x.top[0]
    if (!best) return `${SIDE_IN[side]} 30 işleme ulaşan kombinasyon yok`
    return `${SIDE_IN[side]} en iyi kombinasyon ${best.sumR > x.null.p95 ? 'şanstan ayrışıyor' : 'şansla açıklanabilir'}`
  })
  return <>{parts.join('; ')}.</>
}

function RunMeta({ run, now }: { run: RunDetail; now: Date }) {
  const range = run.dataFrom && run.dataTo ? `veri ${nb(clock(run.dataFrom, now))} – ${nb(clock(run.dataTo, now))}` : null
  return (
    <p className={s.meta}>
      Koşu #{run.id} · {KIND[run.kind].toLocaleLowerCase('tr')} · {STATUS[run.status]}
      {run.finishedAt && ` ${nb(clock(run.finishedAt, now))}`}
      {range && ` · ${range}`}
      {run.gitError && <span className={s.warn}> · sim-data dalına yazılamadı: {run.gitError}</span>}
    </p>
  )
}

function CommentCard({ run, now }: { run: RunDetail; now: Date }) {
  const c = run.comment
  if (!c)
    return (
      <section className={s.comment} aria-labelledby="yorum">
        <h2 id="yorum" className={s.h2}>
          Claude&apos;un yorumu
        </h2>
        <p className={s.muted}>
          {run.gitCommit
            ? "Bekleniyor: Claude rutini her gün 09:37'de yorumsuz koşulara bakar; istersen Claude uygulamasında zamanlanmış görevi şimdi çalıştırabilirsin."
            : 'Sonuç henüz sim-data dalına yazılmadı; yazılınca Claude rutini yorumlar.'}
        </p>
      </section>
    )
  return (
    <section className={s.comment} aria-labelledby="yorum">
      <div className={s.commentHead}>
        <h2 id="yorum" className={s.h2}>
          Claude&apos;un yorumu
        </h2>
        <span className={s.badge} data-level={c.guven === 'Yüksek' ? 'ok' : c.guven === 'Orta' ? 'late' : 'idle'}>
          Güven: {c.guven.toLocaleLowerCase('tr')}
        </span>
      </div>
      <p className={s.commentLead}>{c.ozet}</p>
      {c.gecerlilik && (
        <p>
          <strong>Önceki bulgu: </strong>
          {c.gecerlilik}
        </p>
      )}
      <ul className={s.list}>
        {c.bulgular.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>
      {c.oneriler.length > 0 && (
        <>
          <h3 className={s.h3}>Öneriler</h3>
          <ul className={s.list}>
            {c.oneriler.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </>
      )}
      <p className={s.muted}>Claude, {clock(new Date(c.generated_at), now)}</p>
    </section>
  )
}

function Badge({ v }: { v: Verdict }) {
  return (
    <span className={s.badge} data-level={VERDICT[v].level}>
      {VERDICT[v].word}
    </span>
  )
}

function ValidationSection({ v }: { v: NonNullable<SimResults['validation']> }) {
  const shown = v.rules.filter((r) => r.rank <= 3)
  const rest = v.rules.filter((r) => r.rank > 3)
  const held = v.rules.filter((r) => r.verdict === 'tutuyor').length
  const judged = v.rules.filter((r) => r.verdict === 'tutuyor' || r.verdict === 'tutmuyor').length
  return (
    <section className={s.section} aria-labelledby="denetim">
      <h2 id="denetim" className={s.h2}>
        Önceki bulgunun denetimi
      </h2>
      <p className={s.note}>
        Koşu #{v.previousRunId}&apos;in seçtiği kurallar, {nb(day.format(new Date(v.from)))} – {nb(day.format(new Date(v.to)))} arasındaki kararlarla.{' '}
        {v.rules.length === 0
          ? "O koşuda toplam R'si artıda kural yoktu; denetlenecek bulgu yok."
          : judged === 0
            ? 'Hiçbir kuralda karar verecek kadar işlem yok.'
            : `Karar verilebilen ${judged} kuraldan ${held} tanesi tutuyor.`}
      </p>
      {v.rules.length > 0 && (
        <div className={s.scroll}>
          <RuleTable rules={shown} combined={v.combined} />
        </div>
      )}
      {rest.length > 0 && (
        <details className={s.more}>
          <summary>Diğer {rest.length} kural</summary>
          <div className={s.scroll}>
            <RuleTable rules={rest} combined={null} />
          </div>
        </details>
      )}
    </section>
  )
}

function RuleTable({ rules, combined }: { rules: RuleCheck[]; combined: NonNullable<SimResults['validation']>['combined'] }) {
  return (
    <table className={`${s.table} ${s.list2}`}>
      <thead>
        <tr>
          <th scope="col">Kural</th>
          <th scope="col" className={`${s.r} ${s.wide}`}>
            Önce
            <span className={s.colSub}>işlem · toplam R</span>
          </th>
          <th scope="col" className={s.r}>
            Sonra işlem
          </th>
          <th scope="col" className={s.r}>
            Toplam R
          </th>
          <th scope="col" className={`${s.r} ${s.wide}`}>
            Ort. R
          </th>
          <th scope="col" className={`${s.r} ${s.wide}`}>
            Max DD
          </th>
          <th scope="col" className={`${s.r} ${s.wide}`}>
            Filtresiz ort. R
          </th>
          <th scope="col">Durum</th>
        </tr>
      </thead>
      <tbody>
        {rules.map((r) => (
          <tr key={`${r.side}-${r.rank}`}>
            <th scope="row" className={s.ruleCell}>
              <span className={r.side === 'LONG' ? s.long : s.short}>
                {SIDE[r.side]} #{r.rank}
              </span>{' '}
              {r.label}
            </th>
            <td className={`num ${s.r} ${s.wide}`}>
              {fmt0.format(r.previous.n)} · {signed(r.previous.sumR)}
            </td>
            <td className={`num ${s.r}`}>{r.forward ? fmt0.format(r.forward.n) : '—'}</td>
            <td className={`num ${s.r}`}>{r.forward ? signed(r.forward.sumR) : '—'}</td>
            <td className={`num ${s.r} ${s.wide}`}>{r.forward && r.forward.n ? signed(r.forward.avgR, fmt2) : '—'}</td>
            <td className={`num ${s.r} ${s.wide}`}>{r.forward ? fmt1.format(r.forward.maxDD) : '—'}</td>
            <td className={`num ${s.r} ${s.wide}`}>{r.baseForward.n ? signed(r.baseForward.avgR, fmt2) : '—'}</td>
            <td>
              <Badge v={r.verdict} />
            </td>
          </tr>
        ))}
        {combined && (
          <tr className={s.combinedRow}>
            <th scope="row" className={s.ruleCell}>
              Birleşik <span className={s.muted}>long #1 ve short #1, ayrı yuvalarda</span>
            </th>
            <td className={`num ${s.r} ${s.wide}`}>—</td>
            <td className={`num ${s.r}`}>{fmt0.format(combined.n)}</td>
            <td className={`num ${s.r}`}>{signed(combined.sumR)}</td>
            <td className={`num ${s.r} ${s.wide}`}>{combined.n ? signed(combined.avgR, fmt2) : '—'}</td>
            <td className={`num ${s.r} ${s.wide}`}>{fmt1.format(combined.maxDD)}</td>
            <td className={`num ${s.r} ${s.wide}`}>{combined.baseForward.n ? signed(combined.baseForward.avgR, fmt2) : '—'}</td>
            <td>
              <Badge v={combined.verdict} />
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: ReactNode }) {
  return (
    <div className={s.kpi}>
      <div className={s.kpiLabel}>{label}</div>
      <div className={`num ${s.kpiValue}`}>{value}</div>
      <div className={s.kpiSub}>{sub}</div>
    </div>
  )
}

function Summary({ r }: { r: SimResults }) {
  const L = r.sides.LONG
  const S = r.sides.SHORT
  const best = (x: SideResult) => x.top[0]
  return (
    <section className={s.section} aria-labelledby="sonuc">
      <h2 id="sonuc" className={s.h2}>
        Sonuç
      </h2>
      <div className={s.kpis}>
        {r.combined ? (
          <Kpi
            label="Birleşik, toplam R"
            value={`${signed(r.combined.sumR)} R`}
            sub={
              <>
                {fmt0.format(r.combined.n)} işlem · max DD {fmt1.format(r.combined.maxDD)} R
                <br />
                şans ortancası {signed(r.combined.nullSumP50)} R
              </>
            }
          />
        ) : (
          <Kpi label="Birleşik" value="—" sub="İki yönde de 30 işlemli kombinasyon yok." />
        )}
        {(['LONG', 'SHORT'] as Side[]).map((side) => {
          const x = r.sides[side]
          const b = best(x)
          return (
            <Kpi
              key={side}
              label={`En iyi ${SIDE[side].toLocaleLowerCase('tr')}, toplam R`}
              value={b ? `${signed(b.sumR)} R` : '—'}
              sub={
                b ? (
                  <>
                    {fmt0.format(b.n)} işlem · max DD {fmt1.format(b.maxDD)} R · şans ortancası {signed(x.null.p50)} R
                    <br />
                    {b.label}
                  </>
                ) : (
                  '30 işleme ulaşan kombinasyon yok.'
                )
              }
            />
          )
        })}
        <Kpi
          label="Filtresiz, iki yön ayrı, toplam R"
          value={`${signed(r.base2.sumR)} R`}
          sub={
            <>
              {fmt0.format(r.base2.n)} işlem · max DD {fmt1.format(r.base2.maxDD)} R
              <br />
              long {signed(L.base.sumR)} R · short {signed(S.base.sumR)} R
            </>
          }
        />
      </div>
    </section>
  )
}

function TopTable({ side, r }: { side: Side; r: SideResult }) {
  return (
    <div className={s.card}>
      <h3 className={s.h3}>
        <span className={side === 'LONG' ? s.long : s.short}>{SIDE[side]}</span>
      </h3>
      <p className={s.note}>
        {fmt0.format(r.tested)} kombinasyon, {fmt0.format(r.enough)} tanesi 30+ işlemli. Filtresiz {signed(r.base.sumR)} R ({fmt0.format(r.base.n)} işlem). Şans
        tekrarlarının yarısı {signed(r.null.p50)} R&apos;yi, %5&apos;i {signed(r.null.p95)} R&apos;yi geçiyor.
      </p>
      {r.top.length === 0 ? (
        <p className={s.muted}>30 işleme ulaşan kombinasyon yok.</p>
      ) : (
        <div className={s.scroll}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col" className={s.r}>
                  #
                </th>
                <th scope="col">Koşullar</th>
                <th scope="col" className={s.r}>
                  İşlem
                </th>
                <th scope="col" className={`${s.r} ${s.wide}`}>
                  Kazanma
                </th>
                <th scope="col" className={s.r}>
                  Toplam R
                </th>
                <th scope="col" className={s.r}>
                  Max DD
                </th>
              </tr>
            </thead>
            <tbody>
              {r.top.map((t, i) => (
                <tr key={i}>
                  <td className={`num ${s.r}`}>{i + 1}</td>
                  <td className={s.conds}>{t.label}</td>
                  <td className={`num ${s.r}`}>{fmt0.format(t.n)}</td>
                  <td className={`num ${s.r} ${s.wide}`}>{pct.format(t.win)}</td>
                  <td className={`num ${s.r}`}>{signed(t.sumR)}</td>
                  <td className={`num ${s.r}`}>{fmt1.format(t.maxDD)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Months({ r }: { r: SimResults }) {
  if (r.data.months.length === 0) return null
  return (
    <section className={s.section} aria-labelledby="veri">
      <h2 id="veri" className={s.h2}>
        Veri
      </h2>
      <p className={s.note}>
        Yalnız bütün değişkenlerin dolu olduğu saatler: o saatin 12h heatmap&apos;i gelmiş, ZLEMA ve L/S açıları var. 15 Ekim&apos;e kadar 12h heatmap eski
        döngülerden günde birkaç kez geliyordu; o dönemde yalnız heatmap&apos;in geldiği saatler sayılır.
      </p>
      <div className={s.scroll}>
        <table className={`${s.table} ${s.narrow}`}>
          <thead>
            <tr>
              <th scope="col">Ay</th>
              <th scope="col" className={s.r}>
                Gün
              </th>
              <th scope="col" className={s.r}>
                Heatmap&apos;li saat
              </th>
              <th scope="col" className={`${s.r} ${s.wide}`}>
                Karar noktası
              </th>
              <th scope="col" className={s.r}>
                Filtresiz işlem
              </th>
              <th scope="col" className={s.r}>
                Toplam R
              </th>
            </tr>
          </thead>
          <tbody>
            {r.data.months.map((m) => {
              const [y, mo] = m.month.split('-').map(Number) as [number, number]
              return (
                <tr key={m.month}>
                  <th scope="row">{monthName.format(new Date(Date.UTC(y, mo - 1, 15)))}</th>
                  <td className={`num ${s.r}`}>{fmt1.format(m.days)}</td>
                  <td className={`num ${s.r}`}>{fmt0.format(m.heatmapHours)}</td>
                  <td className={`num ${s.r} ${s.wide}`}>{fmt0.format(m.decisions)}</td>
                  <td className={`num ${s.r}`}>{fmt0.format(m.baseTrades)}</td>
                  <td className={`num ${s.r}`}>{signed(m.baseSumR)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function History({ runs, selected, now }: { runs: RunRow[]; selected: number | null; now: Date }) {
  if (runs.length === 0) return null
  return (
    <section className={s.section} aria-labelledby="gecmis">
      <h2 id="gecmis" className={s.h2}>
        Koşular
      </h2>
      <div className={s.scroll}>
        <table className={`${s.table} ${s.narrow} ${s.list2}`}>
          <thead>
            <tr>
              <th scope="col">Koşu</th>
              <th scope="col" className={s.wide}>
                Tür
              </th>
              <th scope="col" className={s.wide}>
                İstendi
              </th>
              <th scope="col">Durum</th>
              <th scope="col">Veri sonu</th>
              <th scope="col" className={s.r}>
                Birleşik R
              </th>
              <th scope="col">Yorum</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} aria-current={r.id === selected ? 'true' : undefined} className={r.id === selected ? s.current : undefined}>
                <td>{r.status === 'bitti' ? <Link href={`/simulasyon?kosu=${r.id}`}>#{r.id}</Link> : `#${r.id}`}</td>
                <td className={s.wide}>{KIND[r.kind]}</td>
                <td className={`num ${s.wide}`}>{clock(r.requestedAt, now)}</td>
                <td>{r.status === 'hata' ? <span className={s.warn}>hata</span> : STATUS[r.status]}</td>
                <td className="num">{r.dataTo ? clock(r.dataTo, now) : '—'}</td>
                <td className={`num ${s.r}`}>{r.combinedR === null ? '—' : signed(r.combinedR)}</td>
                <td>{r.hasComment ? 'var' : r.status === 'bitti' ? <span className={s.muted}>bekleniyor</span> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// Basamaklı toplam R eğrisi: çizgiler ölçeklenen bir SVG'de, yazılar HTML'de (dar ekranda da okunur kalsın).
function CurveChart({ series }: { series: Array<{ name: string; pts: Array<[number, number]>; cls: string }> }) {
  const all = series.flatMap((x) => x.pts)
  if (all.length === 0) return <p className={s.muted}>İşlem yok.</p>
  const t0 = Math.min(...all.map((p) => p[0]))
  const t1 = Math.max(...all.map((p) => p[0]))
  const vals = [0, ...all.map((p) => p[1])]
  const step = niceStep(Math.max(...vals) - Math.min(...vals))
  const lo = Math.floor(Math.min(...vals) / step) * step
  const hi = Math.ceil(Math.max(...vals) / step) * step || step
  const X = (t: number) => ((t - t0) / (t1 - t0 || 1)) * 1000
  const Y = (v: number) => ((hi - v) / (hi - lo || 1)) * 100
  const ticks: number[] = []
  for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(Math.round(v * 1000) / 1000)
  // İstanbul gece yarıları
  const DAY = 86_400_000
  const IST = 3 * 3_600_000
  const days: number[] = []
  for (let d = (Math.floor((t0 + IST) / DAY) + 1) * DAY - IST; d < t1; d += DAY) days.push(d)
  const every = Math.max(1, Math.ceil(days.length / 6))
  const xTicks = days.filter((_, i) => i % every === 0)
  const path = (pts: Array<[number, number]>) => {
    let d = `M0,${Y(0).toFixed(2)}`
    let y = 0
    for (const [t, v] of pts) {
      d += `H${X(t).toFixed(2)}V${Y(v).toFixed(2)}`
      y = v
    }
    return `${d}H1000V${Y(y).toFixed(2)}`
  }
  return (
    <figure className={s.chart}>
      <div className={s.plotArea}>
        <div className={s.yAxis} aria-hidden="true">
          {ticks.map((v) => (
            <span key={v} className="num" style={{ top: `${Y(v)}%` }}>
              {signed(v, fmt0)}
            </span>
          ))}
        </div>
        <svg className={s.plot} viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label="Toplam R, işlem kapandıkça">
          {ticks.map((v) => (
            <line key={v} x1="0" x2="1000" y1={Y(v)} y2={Y(v)} className={v === 0 ? s.zero : s.grid} vectorEffect="non-scaling-stroke" />
          ))}
          {series.map((x) => (
            <path key={x.name} d={path(x.pts)} className={x.cls} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
        <div className={s.xAxis} aria-hidden="true">
          {xTicks.map((t) => (
            <span key={t} style={{ left: `${X(t) / 10}%` }}>
              {nb(day.format(new Date(t)))}
            </span>
          ))}
        </div>
      </div>
      <figcaption className={s.legend}>
        {series.map((x) => {
          const last = x.pts.at(-1)?.[1] ?? 0
          return (
            <span key={x.name}>
              <i className={`${s.swatch} ${x.cls}`} aria-hidden="true" />
              {x.name}: <strong className="num">{signed(last)} R</strong>
            </span>
          )
        })}
      </figcaption>
    </figure>
  )
}

function niceStep(range: number): number {
  const raw = Math.max(range, 1) / 5
  const p = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p
  return 10 * p
}

