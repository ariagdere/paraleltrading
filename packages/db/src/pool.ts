import pg from 'pg'

// Railway içinde DATABASE_URL özel ağ adresidir (SSL gerekmez). Dışarıdan bağlanırken
// DATABASE_PUBLIC_URL kullanılır ve PGSSL=true verilir (eski ingest'teki kuralın aynısı).
export function createPool(connectionString = process.env.DATABASE_URL, max = 5): pg.Pool {
  if (!connectionString) throw new Error('DATABASE_URL tanımlı değil')
  const useSsl = process.env.PGSSL === 'true' || /sslmode=require/.test(connectionString)
  // Adresteki sslmode, pg'de aşağıdaki ssl ayarını ezer ve Railway'in kendi imzalı sertifikasında
  // bağlantı düşer; SSL'i burada yönetiyoruz.
  const url = new URL(connectionString)
  url.searchParams.delete('sslmode')
  return new pg.Pool({
    connectionString: url.toString(),
    max,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  })
}
