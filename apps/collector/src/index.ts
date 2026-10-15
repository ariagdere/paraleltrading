// collector: ham verileri toplayıp Postgres'e yazan tek süreç. Açılışta migration'ları uygular.
// Şimdilik: Binance L/S (5 dakikada bir) ve heatmap (saatte bir). Axi mumları ve bias sonraki adımda.
import { createPool, migrate } from '@pt/db'
import { config } from './config.js'
import { heatmapHour, SPANS } from './heatmap.js'
import { syncLsr } from './lsr.js'
import { every, type Job } from './schedule.js'
import { markFail } from './status.js'

// Deploy sırasında eski ve yeni süreç kısa süre birlikte açık kalabilir; bu kilit sayesinde
// yalnız biri çalışır (aynı saat iki kez heatmap başlatılıp iki kez ücretlenmez).
const COLLECTOR_LOCK = 72026102
const MINUTE = 60_000

const pool = createPool()
await migrate(pool)

const lock = await pool.connect()
lock.on('error', (err) => {
  console.error(`[collector] kilit bağlantısı koptu, yeniden başlatılıyor: ${err.message}`)
  process.exit(1)
})
let waited = false
while (!(await lock.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [COLLECTOR_LOCK])).rows[0]?.ok) {
  if (!waited) console.log('[collector] başka bir collector çalışıyor; kilit bekleniyor')
  waited = true
  await new Promise((r) => setTimeout(r, 10_000))
}
console.log('[collector] başladı')

const jobs: Job[] = []
const shutdown = new AbortController()

async function stop(signal: string) {
  console.log(`[collector] ${signal} alındı, kapanıyor`)
  for (const job of jobs) job.stop()
  shutdown.abort()
  await Promise.race([Promise.all(jobs.map((j) => j.idle())), new Promise((r) => setTimeout(r, 20_000))])
  lock.release()
  await pool.end()
  process.exit(0)
}
process.once('SIGTERM', () => void stop('SIGTERM'))
process.once('SIGINT', () => void stop('SIGINT'))

await syncLsr(pool)
jobs.push(every('lsr', 5 * MINUTE, 20_000, () => syncLsr(pool)))

if (config.apify.token && config.apify.actorId) {
  jobs.push(every('heatmap', 60 * MINUTE, 30_000, (slot) => heatmapHour(pool, slot, shutdown.signal)))
} else {
  console.warn('[heatmap] APIFY_TOKEN ya da APIFY_ACT_ID tanımlı değil; heatmap kapalı')
  for (const span of SPANS) await markFail(pool, `heatmap:${span}`, '1 hour', 'APIFY_TOKEN ya da APIFY_ACT_ID tanımlı değil')
}
