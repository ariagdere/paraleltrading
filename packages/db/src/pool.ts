import pg from 'pg'

// date sütunları (ör. daily_bias.run_date) 'YYYY-MM-DD' metni olarak gelsin. pg varsayılanı yerel gece yarısında
// bir Date üretir; süreç UTC dışında çalışırsa (İstanbul'da yerel test gibi) gün bir geri kayar.
pg.types.setTypeParser(pg.types.builtins.DATE, (v: string) => v)

// Railway içinde DATABASE_URL özel ağ adresidir (SSL gerekmez). Dışarıdan bağlanırken
// DATABASE_PUBLIC_URL kullanılır ve PGSSL=true verilir (eski ingest'teki kuralın aynısı).
// opts.ssl verilirse PGSSL yerine o geçerli (ör. eski sistemin DB'sine dışarıdan bağlanırken).
// opts.readOnly: oturum bağlantı anında salt okunur açılır (sunucuya başlangıç parametresi olarak gider).
export function createPool(
  connectionString = process.env.DATABASE_URL,
  max = 5,
  opts: { ssl?: boolean; readOnly?: boolean } = {},
): pg.Pool {
  if (!connectionString) throw new Error('DATABASE_URL tanımlı değil')
  const useSsl = opts.ssl ?? (process.env.PGSSL === 'true' || /sslmode=require/.test(connectionString))
  // Adresteki sslmode, pg'de aşağıdaki ssl ayarını ezer ve Railway'in kendi imzalı sertifikasında
  // bağlantı düşer; SSL'i burada yönetiyoruz.
  const url = new URL(connectionString)
  url.searchParams.delete('sslmode')
  const pool = new pg.Pool({
    connectionString: url.toString(),
    max,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    options: opts.readOnly ? '-c default_transaction_read_only=on' : undefined,
  })
  // Boştaki bir bağlantı koparsa (veritabanı yeniden başlarsa) süreç çökmesin; sonraki sorgu yeni bağlantı açar.
  pool.on('error', (err) => console.error(`[db] boştaki bağlantı koptu: ${err.message}`))
  return pool
}
