// Kullanım: DATABASE_URL="..." [PGSSL=true] npm run migrate
import type pg from 'pg'
import { migrate } from './migrate.js'
import { createPool } from './pool.js'

let pool: pg.Pool | undefined
try {
  pool = createPool(process.env.DATABASE_URL, 1)
  await migrate(pool)
} catch (err) {
  console.error((err as Error).message)
  process.exitCode = 1
} finally {
  await pool?.end()
}
