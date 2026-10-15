import type { Pool } from '@pt/db'
import { config } from './config.js'
import { logRun, markFail, markOk } from './status.js'

// Günlük bias: Claude rutininin hakari-dashboard reposunun bias-data dalına yazdığı raporlar (data/daily-bias/*.json).
// 5 dakikada bir dalın ucu git üzerinden okunur (GitHub API kotası harcamaz). Uç değiştiyse ya da açılışta klasör
// listelenir; tabloda olmayan her rapor için onu ekleyen commit bulunur (committed_at, simülasyonda as-of ölçütü) ve
// içerik o commit'ten okunur. Rapor sonradan değiştirilirse ilk hali kalır.
// Etiketler eski ingest'teki gibi normalize edilir. Çekirdek alanlar (tarihler, yön, skor, bias, güven) geçersizse
// rapor yazılmaz; diğer alanlar geçersizse boş bırakılır ve uyarı kaydedilir. Dosyanın tamamı raw'da durur.

// ─── Normalizasyon (eski ingest/ingest.mjs ile aynı eşlemeler) ───────────────────────────────────────────────
const fold = (s: unknown) =>
  String(s ?? '')
    .trim()
    .toLocaleLowerCase('tr')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[\s_-]+/g, ' ')

const NET_DIRECTION: Record<string, [string, number]> = {
  'guclu pozitif': ['Güçlü Pozitif', 3],
  pozitif: ['Pozitif', 2],
  'hafif pozitif': ['Hafif Pozitif', 1],
  notr: ['Nötr', 0],
  'hafif negatif': ['Hafif Negatif', -1],
  negatif: ['Negatif', -2],
  'guclu negatif': ['Güçlü Negatif', -3],
}
const CHANGE: Record<string, string> = { iyilesti: 'IMPROVED', improved: 'IMPROVED', degismedi: 'UNCHANGED', unchanged: 'UNCHANGED', kotulesti: 'WORSENED', worsened: 'WORSENED' }
const DIVERGENCE: Record<string, string> = { 'relative strength': 'RELATIVE_STRENGTH', 'relative weakness': 'RELATIVE_WEAKNESS', aligned: 'ALIGNED', uyumlu: 'ALIGNED' }
const LIQUIDITY: Record<string, string> = { sikilasiyor: 'TIGHTENING', tightening: 'TIGHTENING', notr: 'NEUTRAL', neutral: 'NEUTRAL', gevsiyor: 'EASING', easing: 'EASING', 'guclu sekilde genisliyor': 'STRONG_EXPANSION', 'strong expansion': 'STRONG_EXPANSION' }
const RISK: Record<string, string> = { 'risk on': 'RISK_ON', 'temkinli risk on': 'CAUTIOUS_RISK_ON', 'cautious risk on': 'CAUTIOUS_RISK_ON', notr: 'NEUTRAL', neutral: 'NEUTRAL', 'temkinli risk off': 'CAUTIOUS_RISK_OFF', 'cautious risk off': 'CAUTIOUS_RISK_OFF', 'risk off': 'RISK_OFF' }
const BIAS: Record<string, string> = { long: 'LONG', neutral: 'NEUTRAL', notr: 'NEUTRAL', short: 'SHORT' }
const CONFIDENCE: Record<string, string> = { dusuk: 'LOW', low: 'LOW', orta: 'MEDIUM', medium: 'MEDIUM', yuksek: 'HIGH', high: 'HIGH' }
const IMPACT: Record<string, string> = { pozitif: 'POSITIVE', positive: 'POSITIVE', notr: 'NEUTRAL', neutral: 'NEUTRAL', negatif: 'NEGATIVE', negative: 'NEGATIVE' }
const ASSET_ORDER = ['BTC', 'DXY', 'XAUUSD', 'VIX', 'NASDAQ', 'SPX', 'BRENT']
const ASSETS: Record<string, string> = {
  btc: 'BTC', bitcoin: 'BTC', btcusd: 'BTC', 'btc/usd': 'BTC', btcusdt: 'BTC',
  dxy: 'DXY', 'dolar endeksi': 'DXY', 'dollar index': 'DXY', 'us dollar index': 'DXY',
  xauusd: 'XAUUSD', 'xau/usd': 'XAUUSD', xau: 'XAUUSD', altin: 'XAUUSD', gold: 'XAUUSD',
  vix: 'VIX',
  nasdaq: 'NASDAQ', 'nasdaq 100': 'NASDAQ', nasdaq100: 'NASDAQ', ndx: 'NASDAQ', nq: 'NASDAQ', ixic: 'NASDAQ', 'nasdaq composite': 'NASDAQ',
  spx: 'SPX', 's&p 500': 'SPX', 's&p500': 'SPX', sp500: 'SPX', 'sp 500': 'SPX', es: 'SPX',
  brent: 'BRENT', 'brent petrol': 'BRENT', 'brent crude': 'BRENT', 'brent oil': 'BRENT', ukoil: 'BRENT',
}

type Report = Record<string, unknown>

// Varlık güç sıralaması: 7 varlığın hepsi, her biri bir kez; sıra puana göre (eşit puanda raporun sırası).
function strength(list: unknown, problems: string[]) {
  if (list == null) return null // eski raporlarda alan yok
  if (!Array.isArray(list)) {
    problems.push('asset_strength dizi değil')
    return null
  }
  const seen = new Set<string>()
  const before = problems.length
  const items = list.map((a: Report, i) => {
    const asset = ASSETS[fold(a?.asset)]
    if (!asset) problems.push(`asset_strength[${i}].asset geçersiz: ${JSON.stringify(a?.asset)}`)
    else if (seen.has(asset)) problems.push(`asset_strength: ${asset} birden fazla`)
    if (asset) seen.add(asset)
    const score = Number(a?.score)
    if (a?.score == null || a?.score === '' || typeof a?.score === 'boolean' || !Number.isFinite(score) || score < 0 || score > 10) {
      problems.push(`asset_strength[${i}].score 0..10 değil`)
    }
    const reason = typeof a?.reason === 'string' ? a.reason.trim() : ''
    if (!reason) problems.push(`asset_strength[${i}].reason boş`)
    const pct = (v: unknown) => (v == null || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100)
    return { asset, score: Math.round(score * 10) / 10, reason, chg_24h_pct: pct(a?.chg_24h_pct), chg_7d_pct: pct(a?.chg_7d_pct) }
  })
  const missing = ASSET_ORDER.filter((a) => !seen.has(a))
  if (missing.length) problems.push(`asset_strength eksik varlık: ${missing.join(', ')}`)
  if (problems.length > before) return null
  return items.sort((x, y) => y.score - x.score).map((it, i) => ({ rank: i + 1, ...it }))
}

export function normalize(path: string, j: Report) {
  const errors: string[] = []
  const warnings: string[] = []
  const base = path.split('/').pop()!.replace(/\.json$/, '')
  // YYYY-MM-DD (eski, günde tek) ya da YYYY-MM-DDTHHMM (İstanbul saati)
  const m = base.match(/^(\d{4}-\d{2}-\d{2})(T\d{4})?$/)
  if (!m) errors.push('dosya adı YYYY-MM-DDTHHMM.json ya da YYYY-MM-DD.json değil')
  else if (j.run_date !== m[1]) errors.push(`run_date (${String(j.run_date)}) dosya adındaki tarihle aynı değil`)
  const generatedAt = Date.parse(String(j.generated_at))
  if (Number.isNaN(generatedAt)) errors.push('generated_at geçerli bir zaman değil')

  const core = (map: Record<string, string>, field: string) => {
    const v = map[fold(j[field])]
    if (v === undefined) errors.push(`${field} geçersiz: ${JSON.stringify(j[field])}`)
    return v ?? null
  }
  const optional = (map: Record<string, string>, field: string) => {
    if (j[field] == null) return null
    const v = map[fold(j[field])]
    if (v === undefined) warnings.push(`${field} tanınmadı, boş bırakıldı: ${JSON.stringify(j[field])}`)
    return v ?? null
  }

  const nd = NET_DIRECTION[fold(j.net_direction)]
  if (!nd) errors.push(`net_direction geçersiz: ${JSON.stringify(j.net_direction)}`)
  const score = Number(j.sentiment_score)
  if (!Number.isInteger(score) || score < -100 || score > 100) errors.push('sentiment_score -100..100 arası tam sayı değil')
  const bias = core(BIAS, 'bias')
  const confidence = core(CONFIDENCE, 'confidence')

  let drivers: string[] | null = null
  if (Array.isArray(j.drivers) && j.drivers.length > 0 && j.drivers.every((d) => typeof d === 'string' && d.trim())) {
    drivers = j.drivers as string[]
  } else if (j.drivers != null) warnings.push('drivers string dizisi değil, boş bırakıldı')

  let developments: Array<{ item: string; impact: string | null }> | null = null
  if (Array.isArray(j.developments)) {
    developments = j.developments.map((d: Report, i) => {
      const impact = IMPACT[fold(d?.impact)] ?? null
      if (!impact) warnings.push(`developments[${i}].impact tanınmadı: ${JSON.stringify(d?.impact)}`)
      return { item: String(d?.item ?? '').trim(), impact }
    })
  } else if (j.developments != null) warnings.push('developments dizi değil, boş bırakıldı')

  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
  return {
    errors,
    warnings,
    row: {
      run_date: m?.[1] ?? null,
      generated_at: Number.isNaN(generatedAt) ? null : new Date(generatedAt),
      bias,
      confidence,
      net_direction: nd?.[0] ?? null,
      net_direction_level: nd?.[1] ?? null,
      sentiment_score: score,
      change_24h: optional(CHANGE, 'change_24h'),
      liquidity_regime: optional(LIQUIDITY, 'liquidity_regime'),
      risk_regime: optional(RISK, 'risk_regime'),
      divergence: optional(DIVERGENCE, 'divergence'),
      divergence_note: text(j.divergence_note),
      key_development: text(j.key_development),
      conclusion: text(j.conclusion),
      drivers,
      developments,
      asset_strength: strength(j.asset_strength, warnings),
      raw_text: text(j.raw_text),
      model: text(j.model),
      prompt_version: text(j.prompt_version),
    },
  }
}

// ─── GitHub ──────────────────────────────────────────────────────────────────────────────────────────────────
const headers = () => ({
  'User-Agent': 'paraleltrading-collector',
  ...(config.bias.token ? { Authorization: `Bearer ${config.bias.token}` } : {}),
})

async function get(url: string, accept: string): Promise<string> {
  const res = await fetch(url, { headers: { ...headers(), Accept: accept }, signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0' ? ' (GitHub API kotası doldu; GITHUB_TOKEN verilebilir)' : ''
    throw new Error(`GitHub HTTP ${res.status}${hint}: ${text.slice(0, 200)}`)
  }
  return text
}

// Dalın ucu, git'in akıllı HTTP ucundan (API kotası harcamaz).
async function branchHead(): Promise<string> {
  const { gitUrl, repo, branch } = config.bias
  const text = await get(`${gitUrl}/${repo}.git/info/refs?service=git-upload-pack`, '*/*')
  const m = text.match(new RegExp(`([0-9a-f]{40}) refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`))
  if (!m) throw new Error(`${repo} reposunda ${branch} dalı bulunamadı`)
  return m[1]!
}

async function listReports(head: string): Promise<Array<{ name: string; path: string }>> {
  const { apiUrl, repo, dir } = config.bias
  const list = JSON.parse(await get(`${apiUrl}/repos/${repo}/contents/${dir}?ref=${head}`, 'application/vnd.github+json'))
  if (!Array.isArray(list)) throw new Error('GitHub klasör listesi beklenen biçimde değil')
  return list
    .filter((f: Report) => f?.type === 'file' && String(f?.name).endsWith('.json'))
    .map((f: Report) => ({ name: String(f.name), path: String(f.path) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// Dosyayı ekleyen commit (dosyaya dokunan en eski commit) ve zamanı.
async function addingCommit(path: string): Promise<{ sha: string; at: Date }> {
  const { apiUrl, repo, branch } = config.bias
  const url = `${apiUrl}/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}&per_page=100`
  const commits = JSON.parse(await get(url, 'application/vnd.github+json'))
  const first = Array.isArray(commits) ? commits[commits.length - 1] : undefined
  const at = Date.parse(first?.commit?.committer?.date)
  if (!first?.sha || Number.isNaN(at)) throw new Error(`${path} için commit bulunamadı`)
  return { sha: String(first.sha), at: new Date(at) }
}

// ─── İş ──────────────────────────────────────────────────────────────────────────────────────────────────────
let seenHead: string | null = null
const rejected = new Map<string, string>() // içeriği geçersiz raporlar: yeni uç gelene kadar tekrar indirilmez

export async function syncBias(pool: Pool) {
  const source = 'bias'
  const startedAt = new Date()
  try {
    const head = await branchHead()
    if (head === seenHead) {
      if (rejected.size === 0) await markOk(pool, source, '1 day', await newestCommit(pool))
      return
    }
    rejected.clear()
    const { rows } = await pool.query<{ source_file: string }>('SELECT source_file FROM daily_bias')
    const known = new Set(rows.map((r) => r.source_file))
    const fresh = (await listReports(head)).filter((f) => !known.has(f.path))
    let written = 0
    let transient = false
    const failures: string[] = []
    for (const f of fresh) {
      try {
        const commit = await addingCommit(f.path)
        const { rawUrl, repo } = config.bias
        const body = await get(`${rawUrl}/${repo}/${commit.sha}/${f.path}`, '*/*')
        let report: Report
        try {
          report = JSON.parse(body)
        } catch {
          rejected.set(f.path, 'JSON okunamadı')
          continue
        }
        const { row, errors, warnings } = normalize(f.path, report)
        if (errors.length) {
          rejected.set(f.path, errors.join('; '))
          continue
        }
        await pool.query(
          `INSERT INTO daily_bias (source_file, commit_sha, committed_at, run_date, generated_at, bias, confidence,
             net_direction, net_direction_level, sentiment_score, change_24h, liquidity_regime, risk_regime, divergence,
             divergence_note, key_development, conclusion, drivers, developments, asset_strength, raw_text, model,
             prompt_version, raw)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
           ON CONFLICT (source_file) DO NOTHING`,
          [
            f.path, commit.sha, commit.at, row.run_date, row.generated_at, row.bias, row.confidence,
            row.net_direction, row.net_direction_level, row.sentiment_score, row.change_24h, row.liquidity_regime,
            row.risk_regime, row.divergence, row.divergence_note, row.key_development, row.conclusion,
            row.drivers ? JSON.stringify(row.drivers) : null,
            row.developments ? JSON.stringify(row.developments) : null,
            row.asset_strength ? JSON.stringify(row.asset_strength) : null,
            row.raw_text, row.model, row.prompt_version, JSON.stringify(report),
          ],
        )
        written++
        console.log(`[bias] ${f.name}: ${row.bias} ${row.confidence}, skor ${row.sentiment_score}`)
        if (warnings.length) {
          await logRun(pool, { source, startedAt, ok: true, rowsWritten: 1, detail: { file: f.path, warnings } })
        }
      } catch (err) {
        transient = true // ağ / GitHub hatası: sonraki turda yeniden denenir
        failures.push(`${f.name}: ${(err as Error).message}`)
      }
    }
    if (!transient) seenHead = head
    for (const [path, why] of rejected) failures.push(`${path.split('/').pop()}: ${why}`)
    if (failures.length) {
      const msg = `${failures.length} rapor yazılamadı: ${failures.join(' | ')}`
      console.error(`[bias] ${msg}`)
      await logRun(pool, { source, startedAt, ok: false, rowsWritten: written, error: msg })
      await markFail(pool, source, '1 day', msg)
    } else {
      await markOk(pool, source, '1 day', await newestCommit(pool))
    }
  } catch (err) {
    const msg = (err as Error).name === 'TimeoutError' ? 'GitHub zamanında yanıt vermedi' : (err as Error).message
    console.error(`[bias] ${msg}`)
    await logRun(pool, { source, startedAt, ok: false, error: msg })
    await markFail(pool, source, '1 day', msg)
  }
}

async function newestCommit(pool: Pool): Promise<Date | null> {
  const { rows } = await pool.query<{ at: Date | null }>('SELECT max(committed_at) AS at FROM daily_bias')
  return rows[0]?.at ?? null
}
