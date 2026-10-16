import type { ChartZone, PrevLevels } from '@/lib/chart-shared'
import type { HeatView } from '@/lib/market-data'
import { dm, fmt1, fmtP, pct, usd } from './format'
import s from './price-chart.module.css'

// Grafiğin altındaki ayrıntılar: yalnız açık katmanlarınki.

export function ZoneList({
  zones,
  price,
  showEnded,
  onShowEnded,
}: {
  zones: ChartZone[]
  price: number | null
  showEnded: boolean
  onShowEnded: (v: boolean) => void
}) {
  const active = zones.filter((z) => z.endedAt === null)
  const ref = price
  const above = ref === null ? [] : active.filter((z) => z.lo > ref).sort((a, b) => a.lo - b.lo).slice(0, 3)
  const inside = ref === null ? [] : active.filter((z) => z.lo <= ref && z.hi >= ref)
  const below = ref === null ? [] : active.filter((z) => z.hi < ref).sort((a, b) => b.hi - a.hi).slice(0, 3)
  const row = (z: ChartZone, dir: string) => (
    <tr key={z.id}>
      <th scope="row">
        <span className={s.dir} aria-hidden="true">
          {dir}
        </span>
        <span className="num">
          {fmtP.format(z.lo)}–{fmtP.format(z.hi)}
        </span>
      </th>
      <td className={`num ${s.muted}`}>{ref !== null ? pct(dir === '↑' ? z.lo : dir === '↓' ? z.hi : ref, ref) : ''}</td>
      <td className={`num ${s.rt}`}>{fmt1.format(z.score)}</td>
      <td className={`num ${s.rt} ${s.muted}`}>{fmt1.format(z.mix[0])}</td>
      <td className={`num ${s.rt} ${s.muted}`}>{fmt1.format(z.mix[1])}</td>
      <td className={`num ${s.rt} ${s.muted}`}>{fmt1.format(z.mix[2])}</td>
      <td className={`num ${s.rt}`}>{z.touches}</td>
      <td className={`num ${s.rt}`}>{z.holds}</td>
      <td className={`num ${s.rt}`}>{z.breaks}</td>
      <td className={`num ${s.muted}`}>{dm.format(z.createdAt)}</td>
    </tr>
  )
  return (
    <section className={s.detail} aria-labelledby="sr-title">
      <h3 id="sr-title" className={s.h3}>
        Destek/direnç
      </h3>
      {zones.length === 0 ? (
        <p className={s.muted}>Henüz bölge yok; core bölgeleri her 4h kapanışında hesaplıyor.</p>
      ) : (
        <>
          <div className={s.scroll}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th scope="col">Bant</th>
                  <th scope="col">Uzaklık</th>
                  <th scope="col" className={s.rt}>
                    Puan
                  </th>
                  <th scope="col" className={s.rt}>
                    4h
                  </th>
                  <th scope="col" className={s.rt}>
                    1d
                  </th>
                  <th scope="col" className={s.rt}>
                    1w
                  </th>
                  <th scope="col" className={s.rt}>
                    Test
                  </th>
                  <th scope="col" className={s.rt}>
                    Tuttu
                  </th>
                  <th scope="col" className={s.rt}>
                    Kırıldı
                  </th>
                  <th scope="col">Oluştu</th>
                </tr>
              </thead>
              <tbody>
                {[...above].reverse().map((z) => row(z, '↑'))}
                {inside.map((z) => row(z, '•'))}
                {ref !== null && (
                  <tr className={s.priceRow}>
                    <th scope="row" colSpan={10}>
                      fiyat <span className="num">{fmtP.format(ref)}</span>
                      {inside.length > 0 ? ', bir bölgenin içinde' : ''}
                    </th>
                  </tr>
                )}
                {below.map((z) => row(z, '↓'))}
              </tbody>
            </table>
          </div>
          <label className={s.check}>
            <input type="checkbox" checked={showEnded} onChange={(e) => onShowEnded(e.target.checked)} /> Biten bölgeleri de çiz
          </label>
          <p className={s.note}>
            Fiyatın üstündeki ve altındaki en yakın üçer geçerli bölge. Puan bandındaki izlerin bugünkü ağırlığı; 4h, 1d ve 1w sütunları puanın
            hangi dilimden geldiği. Bölge kırılınca bitmez, rolü döner (destek dirence); izleri zayıflayınca biter. Core her 4h kapanışında
            günceller.
          </p>
        </>
      )}
    </section>
  )
}

export function HeatLevels({ view, price, clusters }: { view: HeatView; price: number | null; clusters: boolean }) {
  const ref = price
  const note =
    view.basis === null
      ? 'Snapshot anına ait Axi mumu olmadığı için heatmap CoinGlass fiyatıyla çiziliyor.'
      : `Heatmap ve cluster'lar Axi fiyatına baz kadar kaydırıldı: CoinGlass fiyatı Axi'nin ${fmtP.format(Math.abs(view.basis))} $ ${view.basis >= 0 ? 'üstünde' : 'altında'}.`
  const maxBand = Math.max(1, ...view.upLiq, ...view.dnLiq)
  return (
    <section className={s.detail} aria-labelledby="heat-title">
      <h3 id="heat-title" className={s.h3}>
        Likidasyon
      </h3>
      <div className={s.clusters}>
        {clusters &&
          (
            [
              ["Yukarıdaki cluster'lar", view.up, '↑'],
              ["Aşağıdaki cluster'lar", view.dn, '↓'],
            ] as const
          ).map(([title, list, dir]) => (
            <div key={title}>
              <h4 className={s.h4}>{title}</h4>
              {list.length === 0 ? (
                <p className={s.muted}>yok</p>
              ) : (
                <div className={s.scroll}>
                  <table className={s.table}>
                    <tbody>
                      {list.map((c) => (
                        <tr key={c.rank}>
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
          <h4 className={s.h4}>Bant likiditesi</h4>
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
        {note} Isı CoinGlass model1 likidasyon seviyeleri; koyuluk o fiyattaki likidasyon miktarı, sağ kenardaki çubuklar fiyat seviyesine göre
        toplamı. {clusters ? "Çizgiler core'un cluster'ları: 1 en büyüğü (eski sistemin kullandığı), 2 ve 3 sonrakiler." : ''}
      </p>
    </section>
  )
}

export function PrevList({ prev, price }: { prev: PrevLevels; price: number | null }) {
  const cell = (v: number | undefined) => (
    <td className="num">
      {v === undefined ? '—' : fmtP.format(v)}
      {v !== undefined && price !== null && <span className={s.muted}> {pct(v, price)}</span>}
    </td>
  )
  return (
    <section className={s.detail} aria-labelledby="prev-title">
      <h3 id="prev-title" className={s.h3}>
        Önceki gün ve hafta
      </h3>
      <div className={s.scroll}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col">Açılış</th>
              <th scope="col">Tepe</th>
              <th scope="col">Dip</th>
              <th scope="col">Kapanış</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Dün{prev.day ? <span className={s.muted}> {dm.format(prev.day.at)}</span> : ''}</th>
              <td className={s.muted}>—</td>
              {cell(prev.day?.h)}
              {cell(prev.day?.l)}
              {cell(prev.day?.c)}
            </tr>
            <tr>
              <th scope="row">Geçen hafta{prev.week ? <span className={s.muted}> {`${dm.format(prev.week.at)}'den`}</span> : ''}</th>
              {cell(prev.week?.o)}
              {cell(prev.week?.h)}
              {cell(prev.week?.l)}
              {cell(prev.week?.c)}
            </tr>
          </tbody>
        </table>
      </div>
      <p className={s.note}>
        {"Axi günlük mumlarından; gün 00:00'da, hafta pazartesi 00:00'da (İstanbul) başlar. Grafikte kesik çizgiler: pdh, pdl, pwh, pwl, pwo, pwc."}
      </p>
    </section>
  )
}
