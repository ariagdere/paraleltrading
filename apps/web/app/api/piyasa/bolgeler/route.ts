import { NextResponse } from 'next/server'
import { loadZones } from '@/lib/chart-data'

// Destek/direnç bölgeleri: core'un son sürümünün bütün bölgeleri, bantları ve olayları. Oturum proxy'de.
export async function GET() {
  try {
    return NextResponse.json(await loadZones(), { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error(`[web] bölgeler okunamadı: ${(err as Error).message}`)
    return NextResponse.json({ error: 'Veritabanı okunamadı' }, { status: 503 })
  }
}
