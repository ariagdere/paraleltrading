import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

// Aynı anda iki servis açılırsa migration'lar iki kez çalışmasın diye.
const LOCK_KEY = 72026101

type Log = (msg: string) => void

// Migration dosyalarını sırayla uygular; her dosya kendi transaction'ında çalışır ve
// schema_migrations'a yazılır. Uygulanmış bir dosya sonradan değişmişse yeniden çalıştırılmaz,
// yalnız uyarı verilir (değişiklik yeni bir dosyayla yapılmalı).
export async function migrate(pool: pg.Pool, log: Log = console.log): Promise<string[]> {
  const client = await pool.connect()
  const applied: string[] = []
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text        PRIMARY KEY,
        checksum    text        NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`)
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    )
    const done = new Map(rows.map((r) => [r.version, r.checksum]))
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort()

    for (const file of files) {
      const version = file.replace(/\.sql$/, '')
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8')
      // Windows satır sonları (CRLF) sağlamayı değiştirmesin.
      const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex')
      const previous = done.get(version)
      if (previous !== undefined) {
        if (previous !== checksum) log(`uyarı: ${file} uygulandıktan sonra değişmiş; değişiklik yeni bir dosyayla yapılmalı`)
        continue
      }
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [version, checksum])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`${file} uygulanamadı: ${(err as Error).message}`)
      }
      applied.push(version)
      log(`uygulandı: ${file}`)
    }
    if (applied.length === 0) log('şema güncel, uygulanacak migration yok')
    return applied
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined)
    client.release()
  }
}
