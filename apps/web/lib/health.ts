// Sağlık sayfasının kuralları: collector_status'un her satırından kaynağın durumu. Saf hesap; veritabanına
// dokunmaz (okuma lib/health-data.ts'te), bu yüzden sahte satırlarla test edilebilir.
//
// Ölçü "sonraki veri ne zaman gelmeliydi". Son veriden bir dönem sonra yenisi beklenir: mumda dilim (son mumun
// kapanışından bir dilim sonra sıradaki kapanır), heatmap'te saat (bütçe kısınca iki saat), L/S'de 5 dakika,
// bakım işlerinde işin aralığı. Beklenen andan sonra bir pay kadar gelmezse "gecikmeli", iki pay geçerse "durdu".
// Pay mumlarda dilimin %10'u (en az 3 dk), heatmap'te 15 dk, L/S'de 7 dk, işlerde aralığın %10'u (en az 2 dk).
// Hata veren kaynak (consecutive_failures > 0) her zaman görünür. Veri hâlâ zamanındaysa ve hata üç kez üst
// üste olmadıysa sarı (geçici: zaman aşımı, tekrar deneniyor), değilse kırmızı.
// Bakım işleri (boşluk denetimi, sembol bilgisi, geçmiş doldurma, bütçe bekçisi, eski DB kopyası) canlı veriyi
// doğrudan etkilemez: en çok sarı.
// Bias: rutin hafta içi 09:07'de. Hafta içi 12:00'ye kadar bugünkü rapor gelmediyse kırmızı, öncesinde
// "bekleniyor", hafta sonu rapor beklenmez. Okuma hatası (GitHub) rapor gecikmedikçe sarı.
// Core satırının sorunu kaynağından geliyorsa (Axi 15m mumu gelmiyorsa 15m göstergesi de gecikir) özette
// yalnız kaynak sayılır.

import { clock, istanbulDay, istanbulWeekHour, span } from './time'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export type StatusRow = {
  source: string
  everyMs: number
  lastRunAt: Date | null
  lastSuccessAt: Date | null
  lastSourceTime: Date | null
  failures: number
  lastError: string | null
  lastErrorAt: Date | null
}

export type GroupKey = 'axi' | 'heatmap' | 'lsr' | 'bias' | 'strategy' | 'legacy' | 'other'

export const GROUPS: Array<{ key: GroupKey; title: string; about: string }> = [
  { key: 'axi', title: 'Axi BTCUSD', about: "MetaApi'den kapanmış mumlar; göstergeleri ve destek/direnç bölgelerini core hesaplar." },
  { key: 'heatmap', title: "Likidasyon heatmap'i", about: "CoinGlass model1, Apify ile saatte bir; seviyeleri core hesaplar." },
  { key: 'lsr', title: 'Long/Short oranı', about: "Binance futures, 5 dakikada bir; açıları core hesaplar." },
  { key: 'bias', title: 'Günlük bias', about: 'Claude rutini, hafta içi her gün 09:07; GitHub bias-data dalından.' },
  { key: 'strategy', title: 'Strateji', about: "Naif kuralın kararları ve benzetilen işlemleri (doğrulama); core her 12h snapshot'ında hesaplar." },
  { key: 'legacy', title: 'Eski sistem', about: "Eski DB'den işlemler ve olaylar, saatte bir (salt okunur)." },
  { key: 'other', title: 'Diğer', about: 'Bu sayfanın tanımadığı kaynaklar.' },
]

type Kind = 'candle' | 'snapshot' | 'point' | 'job' | 'backfill' | 'bias'

type Def = {
  source: string
  group: GroupKey
  section?: string
  label: string
  name: string // cümle içinde: "Axi 1m mumları gecikmeli."
  kind: Kind
  critical: boolean
  stepMs?: number
  dataWord?: string
  upstream?: string[]
}

const TIMEFRAMES: Array<[string, number]> = [
  ['1m', MIN],
  ['5m', 5 * MIN],
  ['15m', 15 * MIN],
  ['1h', HOUR],
  ['4h', 4 * HOUR],
  ['1d', DAY],
]
const SPANS = ['12h', '24h', '48h']

export const CATALOG: Def[] = [
  ...TIMEFRAMES.map(([tf, stepMs]): Def => ({
    source: `axi:${tf}`, group: 'axi', section: 'Mumlar', label: tf, name: `Axi ${tf} mumları`,
    kind: 'candle', critical: true, stepMs, dataWord: 'son kapanış',
  })),
  ...TIMEFRAMES.slice(2).map(([tf, stepMs]): Def => ({
    source: `core:${tf}`, group: 'axi', section: 'Göstergeler: ZLEMA, RSI, ATR', label: tf, name: `Axi ${tf} göstergeleri`,
    kind: 'candle', critical: true, stepMs, dataWord: 'son mum', upstream: [`axi:${tf}`],
  })),
  {
    source: 'core:sr', group: 'axi', section: 'Destek/direnç', label: 'Bölgeler', name: 'Destek/direnç bölgeleri',
    kind: 'candle', critical: true, stepMs: 4 * HOUR, dataWord: 'son 4h mumu', upstream: ['axi:4h'],
  },
  { source: 'axi:gaps', group: 'axi', section: 'Bakım', label: 'Boşluk denetimi', name: 'Mum boşluğu denetimi', kind: 'job', critical: false },
  { source: 'axi:spec', group: 'axi', section: 'Bakım', label: 'Sembol bilgisi', name: 'Axi sembol bilgisi', kind: 'job', critical: false },
  { source: 'axi:backfill', group: 'axi', section: 'Bakım', label: 'Geçmiş doldurma', name: 'Axi geçmiş doldurma', kind: 'backfill', critical: false },
  ...SPANS.map((s): Def => ({
    source: `heatmap:${s}`, group: 'heatmap', label: s, name: `Heatmap ${s}`, kind: 'snapshot', critical: true, dataWord: 'son snapshot',
  })),
  {
    source: 'core:heatmap', group: 'heatmap', label: 'Seviyeler', name: 'Heatmap seviyeleri', kind: 'snapshot', critical: true,
    dataWord: 'son snapshot', upstream: SPANS.map((s) => `heatmap:${s}`),
  },
  { source: 'heatmap:budget', group: 'heatmap', label: 'Apify bütçesi', name: 'Apify bütçe bekçisi', kind: 'job', critical: false },
  { source: 'lsr:global', group: 'lsr', label: 'Global', name: 'Global L/S', kind: 'point', critical: true, dataWord: 'son nokta' },
  { source: 'lsr:top_position', group: 'lsr', label: 'Top trader', name: 'Top trader L/S', kind: 'point', critical: true, dataWord: 'son nokta' },
  {
    source: 'core:lsr', group: 'lsr', label: 'Açılar', name: 'L/S açıları', kind: 'point', critical: true, dataWord: 'son nokta',
    upstream: ['lsr:global', 'lsr:top_position'],
  },
  { source: 'bias', group: 'bias', label: 'Rapor', name: 'Günlük bias', kind: 'bias', critical: true },
  {
    source: 'core:naif', group: 'strategy', label: 'Naif kural', name: 'Naif kural kararları', kind: 'snapshot', critical: false,
    dataWord: 'son döngü', upstream: ['core:heatmap'],
  },
  { source: 'legacy', group: 'legacy', label: 'İşlem kopyası', name: 'Eski sistem kopyası', kind: 'job', critical: false },
]

const BY_SOURCE = new Map(CATALOG.map((d) => [d.source, d]))

export const sourceName = (source: string) => BY_SOURCE.get(source)?.name ?? source

export type State = 'ok' | 'late' | 'stale' | 'fail' | 'waiting' | 'off' | 'never'
export type Level = 'ok' | 'late' | 'down' | 'idle'

export type Health = {
  source: string
  group: GroupKey
  section: string | null
  label: string
  name: string
  critical: boolean
  state: State
  level: Level
  word: string
  // Gösterge: 0 son veri, GAUGE.next sonrakinin beklendiği an, GAUGE.late gecikme sınırı, 1 "durdu".
  gauge: number | null
  overdueMs: number | null // > 0: sonraki veri beklenen andan bu kadar sonra hâlâ yok
  data: string // "son kapanış 09:30"
  next: string | null // "sonraki 09:45" ya da "beklenen 09:45, 6 dk gecikme"
  failures: number
  error: string | null
  errorAt: Date | null
  fails24h: number
  cause: string | null // sorun kaynağından geliyorsa kaynağın adı
}

export const GAUGE = { next: 0.6, late: 0.8 }

// Parçalı doğrusal: [0, dönem] → [0, next], [dönem, dönem + pay] → [next, late], [dönem + pay, dönem + 2 pay] → [late, 1].
export function gaugePos(ageMs: number, cycleMs: number, graceMs: number): number {
  if (ageMs <= cycleMs) return (GAUGE.next * Math.max(0, ageMs)) / cycleMs
  if (ageMs <= cycleMs + graceMs) return GAUGE.next + ((GAUGE.late - GAUGE.next) * (ageMs - cycleMs)) / graceMs
  if (ageMs <= cycleMs + 2 * graceMs) return GAUGE.late + ((1 - GAUGE.late) * (ageMs - cycleMs - graceMs)) / graceMs
  return 1
}

type Timing = { lastAt: Date; cycleMs: number; graceMs: number; dataWord: string }

function timing(def: Def, r: StatusRow): Timing | null {
  const lst = r.lastSourceTime
  if (def.kind === 'candle' && lst && def.stepMs) {
    // Son mumun kapanışı; sıradaki bir dilim sonra kapanır.
    const step = def.stepMs
    return { lastAt: new Date(lst.getTime() + step), cycleMs: step, graceMs: Math.max(3 * MIN, 0.1 * step), dataWord: def.dataWord! }
  }
  if (def.kind === 'snapshot' && lst) return { lastAt: lst, cycleMs: Math.max(HOUR, r.everyMs), graceMs: 15 * MIN, dataWord: def.dataWord! }
  if (def.kind === 'point' && lst) return { lastAt: lst, cycleMs: 5 * MIN, graceMs: 7 * MIN, dataWord: def.dataWord! }
  if (def.kind === 'backfill' || def.kind === 'bias') return null
  // İş ya da henüz kaynak zamanı yazılmamış veri: son başarılı çalışmaya göre.
  if (!r.lastSuccessAt || !(r.everyMs > 0)) return null
  return { lastAt: r.lastSuccessAt, cycleMs: r.everyMs, graceMs: Math.max(2 * MIN, 0.1 * r.everyMs), dataWord: 'son çalışma' }
}

const OK_WORD: Record<Kind, string> = {
  candle: 'Zamanında',
  snapshot: 'Zamanında',
  point: 'Zamanında',
  job: 'Çalışıyor',
  backfill: 'Hata yok',
  bias: 'Geldi',
}
const WORD: Record<Exclude<State, 'ok'>, string> = {
  late: 'Gecikmeli',
  stale: 'Durdu',
  fail: 'Hata',
  waiting: 'Bekleniyor',
  off: 'Hafta sonu',
  never: 'Kayıt yok',
}

const join = (parts: Array<string | null | false | undefined>) => parts.filter(Boolean).join(', ') || null

function fallbackDef(source: string): Def {
  return { source, group: 'other', label: source, name: source, kind: 'job', critical: false }
}

function evaluateOne(def: Def, r: StatusRow | undefined, now: Date, fails24h: number): Health {
  const base = {
    source: def.source,
    group: def.group,
    section: def.section ?? null,
    label: def.label,
    name: def.name,
    critical: def.critical,
    failures: r?.failures ?? 0,
    error: r && r.failures > 0 ? r.lastError : null,
    errorAt: r && r.failures > 0 ? r.lastErrorAt : null,
    fails24h,
    cause: null,
  }
  // Sık tekrarlanan hata (tekrar denemeyle düzelse de) satırda görünür; tekil hatalar "Son hatalar" tablosunda.
  const failNote = fails24h >= 3 ? `24 saatte ${fails24h} hata` : null

  if (!r) {
    return { ...base, state: 'never', level: 'idle', word: WORD.never, gauge: null, overdueMs: null, data: 'henüz kayıt yok', next: null }
  }

  if (def.kind === 'bias') return evaluateBias(def, r, now, base, failNote)

  const t = timing(def, r)
  const ageMs = t ? now.getTime() - t.lastAt.getTime() : null
  const overdueMs = t && ageMs !== null ? ageMs - t.cycleMs : null
  const fresh: 'ok' | 'late' | 'stale' =
    t === null || overdueMs === null || overdueMs < t.graceMs ? 'ok' : overdueMs < 2 * t.graceMs ? 'late' : 'stale'

  let state: State
  if (r.failures > 0) state = 'fail'
  else if (!r.lastSuccessAt && !r.lastSourceTime) state = 'never'
  else state = fresh

  let level: Level
  if (state === 'ok') level = 'ok'
  else if (state === 'never') level = 'idle'
  else if (!def.critical) level = 'late'
  else if (state === 'late') level = 'late'
  else if (state === 'stale') level = 'down'
  else level = t === null || fresh !== 'ok' || r.failures >= 3 ? 'down' : 'late' // hata

  const due = t ? new Date(t.lastAt.getTime() + t.cycleMs) : null
  let data: string
  let next: string | null
  if (def.kind === 'backfill') {
    data = r.lastSuccessAt ? `son kayıt ${clock(r.lastSuccessAt, now)}` : 'henüz kayıt yok'
    next = join(['yalnız hatalar izlenir', failNote])
  } else if (t && due) {
    data = `${t.dataWord} ${clock(t.lastAt, now)}`
    const throttled = def.kind === 'snapshot' && r.everyMs >= 2 * HOUR ? 'bütçe için iki saatte bir' : null
    next =
      overdueMs !== null && overdueMs >= t.graceMs
        ? join([`beklenen ${clock(due, now)}`, `${span(overdueMs)} gecikme`, failNote])
        : join([`sonraki ${clock(due, now)}`, throttled, failNote])
  } else {
    data = r.lastSuccessAt ? `son çalışma ${clock(r.lastSuccessAt, now)}` : 'henüz başarılı çalışma yok'
    next = failNote
  }

  return {
    ...base,
    state,
    level,
    word: state === 'ok' ? OK_WORD[def.kind] : WORD[state],
    gauge: t && ageMs !== null ? gaugePos(ageMs, t.cycleMs, t.graceMs) : null,
    overdueMs: overdueMs !== null && overdueMs > 0 ? overdueMs : null,
    data,
    next,
  }
}

// Bias: hafta içi her gün 09:07'de rapor. Kaynak zamanı en yeni raporun dala düştüğü an (commit).
function evaluateBias(
  def: Def,
  r: StatusRow,
  now: Date,
  base: Omit<Health, 'state' | 'level' | 'word' | 'gauge' | 'overdueMs' | 'data' | 'next'>,
  failNote: string | null,
): Health {
  const last = r.lastSourceTime
  const today = last !== null && istanbulDay(last) === istanbulDay(now)
  const { dow, hour } = istanbulWeekHour(now)
  const weekend = dow >= 6
  const missed = !today && !weekend && hour >= 12
  const data = today ? `bugünkü rapor ${clock(last, now)}` : last ? `son rapor ${clock(last, now)}` : 'henüz rapor yok'
  const nextDay = dow >= 5 ? 'pazartesi' : 'yarın'

  let state: State
  let next: string
  if (r.failures > 0) {
    state = 'fail'
    next = missed
      ? 'bugünkü rapor gelmedi'
      : today
        ? `sonraki ${nextDay} 09:07`
        : weekend
          ? 'hafta sonu rapor gelmez'
          : "bugünkü rapor 12:00'ye kadar bekleniyor"
  } else if (today) {
    state = 'ok'
    next = `sonraki ${nextDay} 09:07`
  } else if (weekend) {
    state = 'off'
    next = 'hafta sonu rapor gelmez'
  } else if (!missed) {
    state = 'waiting'
    next = "bugünkü rapor 12:00'ye kadar bekleniyor"
  } else {
    state = 'stale'
    next = "bugünkü rapor 12:00'ye kadar gelmedi"
  }
  // Okuma hatası rapor gecikene kadar sarı: önemli olan raporun zamanında gelmesi.
  const level: Level = state === 'ok' ? 'ok' : state === 'off' || state === 'waiting' ? 'idle' : missed ? 'down' : 'late'
  return {
    ...base,
    state,
    level,
    word: state === 'ok' ? OK_WORD.bias : state === 'stale' ? 'Gelmedi' : WORD[state],
    gauge: null,
    overdueMs: null,
    data,
    next: join([next, failNote]),
  }
}

const isProblem = (h: Health) => h.level === 'late' || h.level === 'down'

// Bütün kaynaklar: bilinenler katalog sırasıyla (tabloda satırı yoksa "kayıt yok"), bilinmeyenler sonda.
export function evaluate(rows: StatusRow[], now: Date, fails24h: Record<string, number> = {}): Health[] {
  const bySource = new Map(rows.map((r) => [r.source, r]))
  const known = CATALOG.map((d) => evaluateOne(d, bySource.get(d.source), now, fails24h[d.source] ?? 0))
  const unknown = rows
    .filter((r) => !BY_SOURCE.has(r.source))
    .sort((a, b) => a.source.localeCompare(b.source))
    .map((r) => evaluateOne(fallbackDef(r.source), r, now, fails24h[r.source] ?? 0))
  const all = [...known, ...unknown]

  // Kaynağı da sorunluysa core satırının sorunu kaynaktan gelir.
  const byKey = new Map(all.map((h) => [h.source, h]))
  for (const h of all) {
    const up = BY_SOURCE.get(h.source)?.upstream
    if (!up || !isProblem(h)) continue
    const ups = up.map((s) => byKey.get(s)).filter((u): u is Health => !!u)
    if (ups.length === up.length && ups.every(isProblem)) h.cause = ups.map((u) => u.name).join(', ')
  }
  return all
}

const PHRASE: Partial<Record<State, string>> = { fail: 'hata veriyor', late: 'gecikmeli', stale: 'durdu' }
export const phrase = (h: Health) => (h.source === 'bias' && h.state === 'stale' ? 'bugün gelmedi' : PHRASE[h.state] ?? h.word.toLocaleLowerCase('tr'))

export type Verdict = {
  level: Level
  title: string
  problems: Health[]
  // ok: zamanında, problems: kök sorunlar, caused: sorunu kaynağından gelenler, idle: beklemede ya da kaydı yok
  counts: { ok: number; problems: number; caused: number; idle: number }
}

// Özet cümlesi ve kök sorunlar (kırmızılar önce).
export function verdict(all: Health[]): Verdict {
  const counts = { ok: 0, problems: 0, caused: 0, idle: 0 }
  for (const h of all) {
    if (h.level === 'ok') counts.ok++
    else if (h.level === 'idle') counts.idle++
    else if (h.cause) counts.caused++
    else counts.problems++
  }
  const problems = all
    .filter((h) => isProblem(h) && !h.cause)
    .map((h, i) => ({ h, i }))
    .sort((a, b) => (a.h.level === b.h.level ? a.i - b.i : a.h.level === 'down' ? -1 : 1))
    .map((x) => x.h)
  if (problems.length === 0) return { level: 'ok', title: 'Bütün veri akışları zamanında.', problems, counts }
  const level: Level = problems.some((h) => h.level === 'down') ? 'down' : 'late'
  const title = problems.length === 1 ? `${problems[0]!.name} ${phrase(problems[0]!)}.` : `${problems.length} akışta sorun var.`
  return { level, title, problems, counts }
}
