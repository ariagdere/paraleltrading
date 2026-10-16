import type { Metadata } from 'next'
import { connection } from 'next/server'
import { AutoRefresh } from '@/components/AutoRefresh'
import { GROUPS, evaluate, sourceName, verdict, type Health } from '@/lib/health'
import { loadHealth, type HealthData } from '@/lib/health-data'
import { clock, clockSec } from '@/lib/time'
import s from './saglik.module.css'

export const metadata: Metadata = { title: 'Sağlık' }

const REFRESH_MS = 30_000
const anchor = (source: string) => `k-${source.replace(/[^a-z0-9]+/gi, '-')}`
// Hata metni cümlenin sonunda: harf ya da rakamla bitiyorsa nokta eklenir.
const sentence = (t: string) => (/[\p{L}\p{N}]$/u.test(t.trim()) ? `${t.trim()}.` : t.trim())

const COUNT_WORD = [
  ['ok', 'zamanında'],
  ['problems', 'sorunlu'],
  ['caused', 'kaynağı yüzünden gecikmeli'],
  ['idle', 'beklemede'],
] as const

export default async function SaglikPage() {
  await connection() // her istekte veritabanından; derlemede önceden çizilmez

  let data: HealthData
  try {
    data = await loadHealth()
  } catch (err) {
    console.error(`[web] sağlık okunamadı: ${(err as Error).message}`)
    return (
      <>
        <AutoRefresh everyMs={REFRESH_MS} />
        <header className={s.hero} data-level="down">
          <h1 className={s.verdict}>
            <span className={s.dot} aria-hidden="true" />
            Veritabanına bağlanılamadı.
          </h1>
          <p className={s.summary}>
            Sağlık tablosu okunamadı: {(err as Error).message}. Railway&apos;de web servisinin DATABASE_URL değişkenini ve
            Postgres servisinin çalıştığını kontrol et. Sayfa 30 saniyede bir yeniden dener.
          </p>
        </header>
      </>
    )
  }

  const { now } = data
  const all = evaluate(data.rows, now, data.fails24h)
  const v = verdict(all)
  const counts = COUNT_WORD.filter(([k]) => v.counts[k] > 0).map(([k, w]) => `${v.counts[k]} ${w}`)
  const last = data.recent[0]

  return (
    <>
      <AutoRefresh everyMs={REFRESH_MS} />

      <header className={s.hero} data-level={v.level}>
        <h1 className={s.verdict}>
          <span className={s.dot} aria-hidden="true" />
          {v.title}
        </h1>
        <p className={s.summary}>
          {all.length} kaynak izleniyor: {counts.join(', ')}.{' '}
          {last ? (
            <>
              Son hata <time className="num" dateTime={last.at.toISOString()}>{clock(last.at, now)}</time>, {sourceName(last.source)}: {sentence(last.error)}
            </>
          ) : (
            'Son 7 günde hata yok.'
          )}
        </p>
        <p className={s.checked}>
          Son kontrol <time className="num" dateTime={now.toISOString()}>{clockSec(now)}</time>, sayfa 30 saniyede bir yenilenir.
        </p>
      </header>

      {v.problems.length > 0 && (
        <section className={s.problems} aria-label="Sorunlar">
          <ul>
            {v.problems.map((p) => (
              <li key={p.source} className={s.problem} data-level={p.level}>
                <p className={s.problemHead}>
                  <a href={`#${anchor(p.source)}`}>{p.name}</a>
                  <span className={s.word}>{p.word}</span>
                </p>
                <p className={s.problemText}>
                  {p.error ? (
                    <ErrorText h={p} now={now} />
                  ) : (
                    <>
                      {p.data}
                      {p.next ? `; ${p.next}` : ''}
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className={s.legend}>
        Çubuk son veriden bu yana geçen süreyi gösterir. Çentikte sıradaki veri beklenir; sarı bölgeye geçerse kaynak
        gecikmeli, sona dayanırsa durdu sayılır.
      </p>

      <div className={s.groups}>
        {GROUPS.map((g) => {
          const rows = all.filter((h) => h.group === g.key)
          if (rows.length === 0) return null
          const sections = [...new Set(rows.map((h) => h.section))]
          return (
            <section key={g.key} className={s.group} aria-labelledby={`g-${g.key}`}>
              <h2 id={`g-${g.key}`} className={s.groupTitle}>
                {g.title}
              </h2>
              <p className={s.about}>{g.about}</p>
              {sections.map((sec) => (
                <div key={sec ?? '-'} className={s.section}>
                  {sections.length > 1 && sec && <h3 className={s.sectionTitle}>{sec}</h3>}
                  <ul className={s.rows}>
                    {rows
                      .filter((h) => h.section === sec)
                      .map((h) => (
                        <Row key={h.source} h={h} now={now} />
                      ))}
                  </ul>
                </div>
              ))}
            </section>
          )
        })}
      </div>

      <section className={s.errors} aria-labelledby="son-hatalar">
        <h2 id="son-hatalar" className={s.groupTitle}>
          Son hatalar
        </h2>
        <p className={s.about}>Son 7 günün en yeni 12 hatası. Heatmap&apos;te her başarısız deneme ayrı satır.</p>
        {data.recent.length === 0 ? (
          <p className={s.empty}>Son 7 günde hata yok.</p>
        ) : (
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Zaman</th>
                <th scope="col">Kaynak</th>
                <th scope="col">Hata</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((e, i) => (
                <tr key={`${e.source}-${e.at.getTime()}-${i}`}>
                  <td className="num">{clock(e.at, now)}</td>
                  <td>{sourceName(e.source)}</td>
                  <td className={s.errorCell}>{e.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  )
}

function ErrorText({ h, now }: { h: Health; now: Date }) {
  const times = h.failures > 1 ? ` (${h.failures} kez üst üste)` : ''
  return (
    <>
      Son hata{' '}
      <time className="num" dateTime={h.errorAt?.toISOString()}>
        {clock(h.errorAt, now)}
      </time>
      {times}: {h.error}
    </>
  )
}

function Row({ h, now }: { h: Health; now: Date }) {
  return (
    <li id={anchor(h.source)} className={s.row} data-level={h.level}>
      <span className={s.label}>{h.label}</span>
      <span className={s.word}>{h.word}</span>
      {h.gauge === null ? (
        <span className={s.gaugeNone} aria-hidden="true" />
      ) : (
        <span className={s.gauge} aria-hidden="true">
          <span className={s.fill} style={{ width: `${Math.max(1.5, h.gauge * 100).toFixed(1)}%` }} />
        </span>
      )}
      <span className={s.detail}>
        <span className="num">{h.data}</span>
        {h.next && <span className={`${s.next} num`}>{h.next}</span>}
      </span>
      {h.error && (
        <p className={s.rowNote} data-kind="error">
          <ErrorText h={h} now={now} />
        </p>
      )}
      {h.cause && <p className={s.rowNote}>Kaynakta sorun var: {h.cause}.</p>}
    </li>
  )
}
