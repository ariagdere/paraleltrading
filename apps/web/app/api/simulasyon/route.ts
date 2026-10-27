import { NextResponse } from 'next/server'
import { dbWrite } from '@/lib/db'

// Simülasyon sayfasındaki "Şimdi çalıştır": sırada ya da çalışan koşu yoksa sim_runs'a istek satırı ekler; core bir
// dakika içinde başlatır. Oturum ve aynı kaynak denetimi proxy.ts'te.
export async function POST() {
  let result = 'istendi'
  try {
    const { rowCount } = await dbWrite().query(
      `INSERT INTO sim_runs (kind) SELECT 'elle' WHERE NOT EXISTS (SELECT 1 FROM sim_runs WHERE status IN ('istendi', 'calisiyor'))`,
    )
    if (!rowCount) result = 'zaten'
  } catch (err) {
    console.error(`[web] simülasyon isteği kaydedilemedi: ${(err as Error).message}`)
    result = 'hata'
  }
  return new NextResponse(null, { status: 303, headers: { Location: `/simulasyon?istek=${result}`, 'Cache-Control': 'no-store' } })
}
