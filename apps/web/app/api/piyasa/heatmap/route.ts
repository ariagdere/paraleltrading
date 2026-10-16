import { NextResponse, type NextRequest } from 'next/server'
import { isSpan, loadHeatView } from '@/lib/market-data'

// Piyasa grafiğinin heatmap'i: ?span=12h|24h|48h, isteğe bağlı &id=<snapshot> (yoksa en yenisi). Oturum proxy'de.
export async function GET(req: NextRequest) {
  const span = req.nextUrl.searchParams.get('span')
  const idRaw = req.nextUrl.searchParams.get('id')
  if (!isSpan(span)) return NextResponse.json({ error: 'span 12h, 24h ya da 48h olmalı' }, { status: 400 })
  if (idRaw !== null && !/^\d{1,15}$/.test(idRaw)) return NextResponse.json({ error: 'id bir snapshot numarası olmalı' }, { status: 400 })
  try {
    const view = await loadHeatView(span, idRaw === null ? null : Number(idRaw))
    if (!view) return NextResponse.json({ error: 'Bu pencerede snapshot yok' }, { status: 404 })
    return NextResponse.json(view, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error(`[web] heatmap okunamadı: ${(err as Error).message}`)
    return NextResponse.json({ error: 'Veritabanı okunamadı' }, { status: 503 })
  }
}
