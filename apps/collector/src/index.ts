// collector: ham verileri toplayıp Postgres'e yazan tek süreç. Açılışta migration'ları uygular.
// Binance L/S (5 dakikada bir), heatmap (saatte bir), Axi mumları (dakikada bir), sembol bilgisi (6 saatte bir)
// ve günlük bias raporları (5 dakikada bir bias-data dalına bakar).
import { createPool, migrate, type Pool } from '@pt/db'
import { backfillAxi, EXPECTED_EVERY, syncAxi, syncSpec, TIMEFRAMES } from './axi.js'
import { syncBias } from './bias.js'
import { config } from './config.js'
import { heatmapHour, SPANS } from './heatmap.js'
import { syncLsr } from './lsr.js'
import { every, type Job } from './schedule.js'
import { markFail } from './status.js'

// Deploy sırasında eski ve yeni süreç kısa süre birlikte açık kalabilir; bu kilit sayesinde
// yalnız biri çalışır (aynı saat iki kez heatmap başlatılıp iki kez ücretlenmez).
const COLLECTOR_LOCK = 72026102
const MINUTE = 60_000

// Ayar hatalarında yığın dökümü yerine tek satır (Railway loglarında okunur kalsın).
function fatal(err: unknown): never {
  console.error(`[collector] başlatılamadı: ${(err as Error).message}`)
  process.exit(1)
}

let pool: Pool
try {
  pool = createPool()
} catch (err) {
  fatal(err)
}
await migrate(pool).catch(fatal)

const lock = await pool.connect().catch(fatal)
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

void syncBias(pool)
jobs.push(every('bias', 5 * MINUTE, 45_000, () => syncBias(pool)))

if (config.apify.token && config.apify.actorId) {
  jobs.push(every('heatmap', 60 * MINUTE, 30_000, (slot) => heatmapHour(pool, slot, shutdown.signal)))
} else {
  console.warn('[heatmap] APIFY_TOKEN ya da APIFY_ACT_ID tanımlı değil; heatmap kapalı')
  for (const span of SPANS) await markFail(pool, `heatmap:${span}`, '1 hour', 'APIFY_TOKEN ya da APIFY_ACT_ID tanımlı değil')
}

if (config.metaapi.token && config.metaapi.accountId) {
  void syncSpec(pool)
  jobs.push(every('axi', MINUTE, 3_000, () => syncAxi(pool)))
  jobs.push(every('axi-backfill', MINUTE, 30_000, () => backfillAxi(pool)))
  jobs.push(every('axi-spec', 6 * 60 * MINUTE, 7 * MINUTE, () => syncSpec(pool)))
} else {
  console.warn('[axi] METAAPI_TOKEN ya da METAAPI_ACCOUNT_ID tanımlı değil; Axi mumları kapalı')
  for (const tf of TIMEFRAMES) {
    await markFail(pool, `axi:${tf}`, EXPECTED_EVERY[tf], 'METAAPI_TOKEN ya da METAAPI_ACCOUNT_ID tanımlı değil')
  }
}
