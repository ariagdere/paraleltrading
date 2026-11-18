import { NextResponse } from 'next/server'
import { loadPendingChart, loadSetupChart } from '@/lib/sdl-chart-data'

// SDL sayfasındaki kurulum grafiğinin verisi: ?kurulum=<sdl_setups.id> ya da ?bekleyen=<SHORT|LONG>-<FVG'nin ms'si>.
// Oturum denetimi proxy.ts'te.
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams
  const kurulum = q.get('kurulum')
  const bekleyen = q.get('bekleyen')
  const m = bekleyen ? /^(LONG|SHORT)-(\d{12,14})$/.exec(bekleyen) : null
  if (!(kurulum && /^\d{1,15}$/.test(kurulum)) && !m) {
    return NextResponse.json({ error: 'kurulum ya da bekleyen parametresi gerekli' }, { status: 400 })
  }
  try {
    const data = m ? await loadPendingChart(m[1] as 'LONG' | 'SHORT', Number(m[2])) : await loadSetupChart(Number(kurulum))
    if (!data) {
      return NextResponse.json(
        { error: m ? 'Bu kurulum artık sırada değil: tetiklendi, düştü ya da süresi doldu.' : 'Kurulum bulunamadı.' },
        { status: 404, headers: { 'Cache-Control': 'no-store' } },
      )
    }
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error(`[web] SDL grafiği okunamadı: ${(err as Error).message}`)
    return NextResponse.json({ error: 'Veritabanı okunamadı.' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
