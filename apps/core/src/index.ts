// core: collector'ın ham verilerinden hesaplanan değerleri Postgres'e yazan süreç. Axi göstergeleri (ZLEMA bölgesi,
// RSI, ATR; 15m, 1h, 4h, 1d) ve heatmap seviyeleri (cluster'lar, bant likiditesi, baz). Açılışta migration'ları
// uygular ve eksikleri hesaplar; sonra dakikada bir (saniye 20, collector'ın mum turundan sonra) yeni ya da
// düzeltilmiş mumları ve yeni heatmap snapshot'larını işler.
import { createPool, every, migrate, type Job, type Pool } from '@pt/db'
import { syncHeatmapLevels } from './heatmap.js'
import { syncIndicators } from './sync.js'

// Deploy sırasında eski ve yeni süreç kısa süre birlikte açık kalabilir; bu kilitle yalnız biri çalışır.
const CORE_LOCK = 72026103
const MINUTE = 60_000

// Ayar hatalarında yığın dökümü yerine tek satır (Railway loglarında okunur kalsın).
function fatal(err: unknown): never {
  console.error(`[core] başlatılamadı: ${(err as Error).message}`)
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
  console.error(`[core] kilit bağlantısı koptu, yeniden başlatılıyor: ${err.message}`)
  process.exit(1)
})
let waited = false
while (!(await lock.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [CORE_LOCK])).rows[0]?.ok) {
  if (!waited) console.log('[core] başka bir core çalışıyor; kilit bekleniyor')
  waited = true
  await new Promise((r) => setTimeout(r, 10_000))
}
console.log('[core] başladı')

const jobs: Job[] = []
const turn = () => syncIndicators(pool).then(() => syncHeatmapLevels(pool))
const first = turn()

async function stop(signal: string) {
  console.log(`[core] ${signal} alındı, kapanıyor`)
  for (const job of jobs) job.stop()
  await Promise.race([Promise.all([first, ...jobs.map((j) => j.idle())]), new Promise((r) => setTimeout(r, 20_000))])
  lock.release()
  await pool.end()
  process.exit(0)
}
process.once('SIGTERM', () => void stop('SIGTERM'))
process.once('SIGINT', () => void stop('SIGINT'))

await first
jobs.push(every('core', MINUTE, 20_000, turn))
