import { NextResponse } from 'next/server'
import { dbWrite } from '@/lib/db'

// SDL sayfasındaki NO TRADE düğmesi: durum=ac işleme açar, durum=kapat NO TRADE'e alır (yeni işlem açılmaz; açık
// işlemler SL/TP'leriyle kalır). core her kurulumda düğmeyi okur. Oturum ve aynı kaynak denetimi proxy.ts'te.
export async function POST(req: Request) {
  let result = 'hata'
  try {
    const form = await req.formData()
    const durum = form.get('durum')
    if (durum === 'ac' || durum === 'kapat') {
      await dbWrite().query(
        `INSERT INTO trading_switch (strategy, enabled, changed_at, note) VALUES ('sdl_elle', $1, now(), 'web')
         ON CONFLICT (strategy) DO UPDATE SET enabled = EXCLUDED.enabled, changed_at = now(), note = 'web'`,
        [durum === 'ac'],
      )
      result = durum === 'ac' ? 'acildi' : 'kapandi'
    }
  } catch (err) {
    console.error(`[web] NO TRADE düğmesi değiştirilemedi: ${(err as Error).message}`)
  }
  return new NextResponse(null, { status: 303, headers: { Location: `/sdl?dugme=${result}`, 'Cache-Control': 'no-store' } })
}
