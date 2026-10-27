import { logRun, markFail, markOk, type Pool } from '@pt/db'
import { loadInputs } from './data.js'
import { SIM_ENGINE, runSim, type Pause, type PrevRule, type SimResults } from './engine.js'
import { branchHead, gh, listDir, putFile, readFile } from './github.js'

// Simülasyon işi (dakikada bir): her ayın 1'inde 04:00'te (İstanbul) o ayın koşusunu sıraya koyar (core o an
// kapalıysa sonraki 7 gün içinde), sıradaki koşuyu (aylık ya da web'den istenen) çalıştırır. Hesap olay döngüsünü
// bekletmesin diye arada bir nefes alır; core'un diğer işleri sürer.
// Dakikada bir sim-data dalıyla eşitlenir: yazılamamış sonuçları yeniden dener, dalın ucu değiştiyse yeni yorumları
// alır (rutin yorumu koyduktan en geç bir dakika sonra sayfada).
// Yarıda kalan koşu (core yeniden başladı) "hata" olur; web'den yeniden istenebilir.

const IST = 3 * 3_600_000
const MONTHLY_GRACE_MS = 7 * 86_400_000
const GIT_EVERY_MS = 60_000

// Ayın 1'i 04:00 İstanbul (01:00 UTC).
export function monthlySlot(now: number): number {
  const d = new Date(now + IST)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 4) - IST
}

let recovered = false
let lastGit = 0

export async function simTick(pool: Pool) {
  if (!recovered) {
    await pool.query(`UPDATE sim_runs SET status = 'hata', error = 'core yeniden başladı; koşu yarıda kaldı', finished_at = now() WHERE status = 'calisiyor'`)
    recovered = true
  }
  const now = Date.now()
  const slot = monthlySlot(now)
  if (now >= slot && now - slot < MONTHLY_GRACE_MS) {
    const ins = await pool.query(`INSERT INTO sim_runs (kind, slot) VALUES ('aylik', $1) ON CONFLICT (slot) WHERE slot IS NOT NULL DO NOTHING`, [new Date(slot)])
    if (ins.rowCount) console.log('[core] simülasyon: aylık koşu sıraya kondu')
  }
  const {
    rows: [next],
  } = await pool.query<{ id: string }>(`SELECT id FROM sim_runs WHERE status = 'istendi' ORDER BY requested_at, id LIMIT 1`)
  if (next) await runOne(pool, Number(next.id))
  if (Date.now() - lastGit >= GIT_EVERY_MS) {
    lastGit = Date.now()
    await syncGit(pool)
  }
}

// Önceki bulgu: bir önceki aylık koşu, yoksa bir önceki koşu (bitmiş).
async function previousRun(pool: Pool, id: number): Promise<{ id: number; dataTo: number; rules: PrevRule[] } | null> {
  const {
    rows: [p],
  } = await pool.query<{ id: string; data_to: Date; rules: PrevRule[] | null }>(
    `SELECT id, data_to, results->'rules' AS rules FROM sim_runs
     WHERE status = 'bitti' AND id < $1 AND data_to IS NOT NULL AND results ? 'rules'
     ORDER BY (kind = 'aylik') DESC, data_to DESC, id DESC LIMIT 1`,
    [id],
  )
  return p && Array.isArray(p.rules) ? { id: Number(p.id), dataTo: p.data_to.getTime(), rules: p.rules } : null
}

function pauser(): Pause {
  let last = performance.now()
  return async () => {
    if (performance.now() - last < 25) return
    await new Promise((r) => setImmediate(r))
    last = performance.now()
  }
}

export async function runOne(pool: Pool, id: number, opts: { to?: Date; nullRuns?: number } = {}) {
  const source = 'core:sim'
  const startedAt = new Date()
  const claimed = await pool.query(`UPDATE sim_runs SET status = 'calisiyor', started_at = now(), engine = $2, error = NULL WHERE id = $1 AND status = 'istendi'`, [
    id,
    SIM_ENGINE,
  ])
  if (!claimed.rowCount) return
  console.log(`[core] simülasyon #${id} başladı`)
  try {
    const to = opts.to ?? new Date()
    const prev = await previousRun(pool, id)
    const inp = await loadInputs(pool, to)
    const res = await runSim(inp, { to: to.getTime(), previous: prev, nullRuns: opts.nullRuns, seed: id }, pauser())
    await pool.query(
      `UPDATE sim_runs SET status = 'bitti', finished_at = now(), data_from = $2, data_to = $3, previous_id = $4, results = $5 WHERE id = $1`,
      [id, res.data.from === null ? null : new Date(res.data.from), to, prev?.id ?? null, JSON.stringify(res)],
    )
    const secs = (Date.now() - startedAt.getTime()) / 1000
    console.log(`[core] simülasyon #${id} bitti (${secs.toFixed(0)} sn): ${res.data.candidates.LONG} long, ${res.data.candidates.SHORT} short aday`)
    await logRun(pool, { source, startedAt, ok: true, detail: summary(res) })
    await markOk(pool, source, '32 days', to)
    await pushRun(pool, id)
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[core] simülasyon #${id}: ${msg}`)
    await pool.query(`UPDATE sim_runs SET status = 'hata', error = $2, finished_at = now() WHERE id = $1`, [id, msg])
    await logRun(pool, { source, startedAt, ok: false, error: msg })
    await markFail(pool, source, '32 days', msg)
  }
}

function summary(r: SimResults) {
  const best = (s: 'LONG' | 'SHORT') => r.sides[s].top[0]
  return {
    from: r.data.from,
    to: r.data.to,
    long: { base: r.sides.LONG.base.sumR, best: best('LONG')?.label ?? null, bestR: best('LONG')?.sumR ?? null, p50: r.sides.LONG.null.p50 },
    short: { base: r.sides.SHORT.base.sumR, best: best('SHORT')?.label ?? null, bestR: best('SHORT')?.sumR ?? null, p50: r.sides.SHORT.null.p50 },
    combined: r.combined?.sumR ?? null,
  }
}

// ─── sim-data dalı ───────────────────────────────────────────────────────────────────────────────────────────
type RunRow = {
  id: string
  kind: string
  slot: Date | null
  requested_at: Date
  started_at: Date | null
  finished_at: Date | null
  engine: string | null
  data_from: Date | null
  data_to: Date | null
  previous_id: string | null
  results: SimResults
}

// Rutinin baştan sona okuyacağı biçim: nesneler girintili; kısa düz nesneler (n, sumR, avgR…) ve koşul listeleri tek
// satırda, uzun sayı listeleri (eğri, şans testi) satır başına ~150 karakter. Ondalıklar 4 haneye yuvarlanır (asıl
// değerler veritabanında).
export function readableJson(value: unknown): string {
  const flat = (v: unknown) => v === null || typeof v !== 'object'
  const fmt = (v: unknown, ind: string): string => {
    if (Array.isArray(v)) {
      const one = JSON.stringify(v)
      if (v.every((x) => flat(x) || (Array.isArray(x) && x.every(flat)))) {
        if (one.length <= 150) return one
        const lines: string[] = []
        let cur = ''
        for (const p of v.map((x) => JSON.stringify(x))) {
          if (cur && cur.length + p.length + 1 > 150) {
            lines.push(cur)
            cur = ''
          }
          cur += (cur ? ',' : '') + p
        }
        lines.push(cur)
        return `[\n${lines.map((l) => `${ind} ${l}`).join(',\n')}\n${ind}]`
      }
      return `[\n${v.map((x) => `${ind} ${fmt(x, `${ind} `)}`).join(',\n')}\n${ind}]`
    }
    if (v !== null && typeof v === 'object') {
      const one = JSON.stringify(v)
      if (Object.values(v).every(flat) && one.length <= 150) return one
      const rows = Object.entries(v).map(([k, x]) => `${ind} ${JSON.stringify(k)}: ${fmt(x, `${ind} `)}`)
      return rows.length ? `{\n${rows.join(',\n')}\n${ind}}` : '{}'
    }
    return JSON.stringify(v)
  }
  const round = (_k: string, v: unknown) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v)
  return fmt(JSON.parse(JSON.stringify(value), round), '')
}

export async function pushRun(pool: Pool, id: number) {
  const {
    rows: [r],
  } = await pool.query<RunRow>(
    `SELECT id, kind, slot, requested_at, started_at, finished_at, engine, data_from, data_to, previous_id, results FROM sim_runs WHERE id = $1 AND status = 'bitti'`,
    [id],
  )
  if (!r) return
  const file = `runs/${id}.json`
  try {
    const doc = {
      run: {
        id,
        kind: r.kind,
        slot: r.slot,
        requested_at: r.requested_at,
        started_at: r.started_at,
        finished_at: r.finished_at,
        engine: r.engine,
        data_from: r.data_from,
        data_to: r.data_to,
        previous_id: r.previous_id === null ? null : Number(r.previous_id),
      },
      results: r.results,
    }
    const sha = await putFile(file, `${readableJson(doc)}\n`, `sim: koşu #${id} (${r.kind})`)
    await pool.query(`UPDATE sim_runs SET git_path = $2, git_commit = $3, git_pushed_at = now(), git_error = NULL WHERE id = $1`, [id, file, sha])
    console.log(`[core] simülasyon #${id} ${gh.branch} dalına yazıldı (${sha.slice(0, 7)})`)
  } catch (err) {
    await pool.query(`UPDATE sim_runs SET git_error = $2 WHERE id = $1`, [id, (err as Error).message])
  }
}

// Yorumun beklenen biçimi (Claude rutini, yorum/<id>.json). Geçersizse alınmaz.
export type Comment = {
  run_id: number
  generated_at: string
  ozet: string
  gecerlilik: string
  bulgular: string[]
  oneriler: string[]
  guven: 'Düşük' | 'Orta' | 'Yüksek'
  model: string | null
  prompt_version: string | null
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null)
const strs = (v: unknown, maxItems: number, max: number) =>
  Array.isArray(v) && v.length <= maxItems && v.every((x) => str(x, max) !== null) ? (v as string[]).map((x) => x.trim()) : null

export function parseComment(text: string, id: number): Comment {
  let j: Record<string, unknown>
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error('geçerli JSON değil')
  }
  if (j === null || typeof j !== 'object') throw new Error('nesne değil')
  if (j.run_id !== id) throw new Error(`run_id ${String(j.run_id)}, dosya adı ${id}`)
  const generated = str(j.generated_at, 40)
  if (!generated || Number.isNaN(Date.parse(generated))) throw new Error('generated_at geçersiz')
  const ozet = str(j.ozet, 3000)
  if (!ozet) throw new Error('ozet boş ya da çok uzun')
  const gecerlilik = typeof j.gecerlilik === 'string' && j.gecerlilik.length <= 3000 ? j.gecerlilik.trim() : null
  if (gecerlilik === null) throw new Error('gecerlilik metin değil ya da çok uzun')
  const bulgular = strs(j.bulgular, 8, 800)
  if (!bulgular || bulgular.length === 0) throw new Error('bulgular 1–8 madde olmalı')
  const oneriler = strs(j.oneriler ?? [], 5, 800)
  if (!oneriler) throw new Error('oneriler en çok 5 madde olmalı')
  const guven = j.guven === 'Düşük' || j.guven === 'Orta' || j.guven === 'Yüksek' ? j.guven : null
  if (!guven) throw new Error('guven Düşük, Orta ya da Yüksek olmalı')
  return {
    run_id: id,
    generated_at: generated,
    ozet,
    gecerlilik,
    bulgular,
    oneriler,
    guven,
    model: str(j.model, 200),
    prompt_version: str(j.prompt_version, 50),
  }
}

let seenHead: string | null = null
const rejected = new Map<string, string>() // yol → reddedilen sürümün sha'sı

export async function syncGit(pool: Pool) {
  const source = 'core:sim-yorum'
  const startedAt = new Date()
  try {
    if (gh.token) {
      const { rows } = await pool.query<{ id: string }>(`SELECT id FROM sim_runs WHERE status = 'bitti' AND git_pushed_at IS NULL ORDER BY id LIMIT 3`)
      for (const r of rows) await pushRun(pool, Number(r.id))
    }
    const head = await branchHead()
    if (head !== seenHead) {
      const files = (await listDir('yorum', head)).filter((f) => /^\d+\.json$/.test(f.name))
      for (const f of files) {
        const id = Number(f.name.slice(0, -5))
        const {
          rows: [run],
        } = await pool.query<{ comment_sha: string | null }>(`SELECT comment_sha FROM sim_runs WHERE id = $1`, [id])
        if (!run || run.comment_sha === f.sha || rejected.get(f.path) === f.sha) continue
        // okuma hatası (ağ, kota) bütün eşitlemeyi düşürür, uç kaydedilmez, bir sonraki turda yeniden denenir;
        // yalnız biçimi geçersiz dosya o haliyle bir daha denenmez
        const text = await readFile(f.path, head)
        let c: Comment
        try {
          c = parseComment(text, id)
        } catch (err) {
          rejected.set(f.path, f.sha)
          const msg = `${f.path}: ${(err as Error).message}`
          console.error(`[core] simülasyon yorumu alınmadı: ${msg}`)
          await logRun(pool, { source, startedAt, ok: false, error: msg })
          continue
        }
        await pool.query(`UPDATE sim_runs SET comment = $2, comment_sha = $3, comment_at = now() WHERE id = $1`, [id, JSON.stringify(c), f.sha])
        console.log(`[core] simülasyon #${id} yorumu alındı`)
      }
      seenHead = head
    }
    await markOk(pool, source, '1 minute')
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[core] simülasyon dalı: ${msg}`)
    await logRun(pool, { source, startedAt, ok: false, error: msg })
    await markFail(pool, source, '1 minute', msg)
  }
}
