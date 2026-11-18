import { createPool } from '@pt/db/pool'

type Pool = ReturnType<typeof createPool>

// Web okur: oturumlar salt okunur açılır (default_transaction_read_only), yanlışlıkla yazma imkânsız. İki yazma yolu var:
// Simülasyon sayfasının "Şimdi çalıştır" isteği (sim_runs'a istek satırı) ve SDL sayfasının NO TRADE düğmesi
// (trading_switch); ikisi de ayrı, tek bağlantılık havuzdan (dbWrite).
// Geliştirmede sıcak yeniden yüklemede havuz çoğalmasın diye globalThis'te tutulur.
const g = globalThis as unknown as { __ptWebPool?: Pool; __ptWebWritePool?: Pool }

export function db(): Pool {
  if (!g.__ptWebPool) g.__ptWebPool = createPool(process.env.DATABASE_URL, 4, { readOnly: true })
  return g.__ptWebPool
}

export function dbWrite(): Pool {
  if (!g.__ptWebWritePool) g.__ptWebWritePool = createPool(process.env.DATABASE_URL, 1)
  return g.__ptWebWritePool
}
