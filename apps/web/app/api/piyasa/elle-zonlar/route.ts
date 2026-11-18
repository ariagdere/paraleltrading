import { NextResponse } from 'next/server'
import { loadManualZones } from '@/lib/chart-data'

// Elle zonlar: şu an geçerli olanların hepsi (Piyasa grafiğinin "Elle zonlar" katmanı). Oturum proxy'de.
export async function GET() {
  try {
    return NextResponse.json({ zones: await loadManualZones() }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error(`[web] elle zonlar okunamadı: ${(err as Error).message}`)
    return NextResponse.json({ error: 'Veritabanı okunamadı' }, { status: 503 })
  }
}
