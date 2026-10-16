import { createPool } from '@pt/db/pool'

type Pool = ReturnType<typeof createPool>

// Web yalnız okur: oturumlar salt okunur açılır (default_transaction_read_only), yanlışlıkla yazma imkânsız.
// Geliştirmede sıcak yeniden yüklemede havuz çoğalmasın diye globalThis'te tutulur.
const g = globalThis as unknown as { __ptWebPool?: Pool }

export function db(): Pool {
  if (!g.__ptWebPool) g.__ptWebPool = createPool(process.env.DATABASE_URL, 4, { readOnly: true })
  return g.__ptWebPool
}
