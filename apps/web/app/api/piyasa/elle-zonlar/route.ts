import { NextResponse } from 'next/server'
import { loadManualZones } from '@/lib/chart-data'
import { zoneTokenOk } from '@/lib/zone-token'
import { ZoneWriteError, loadZoneRule, parseSaveRequest, saveZone } from '@/lib/zone-write'

// Elle zonlar. GET: şu an geçerli olanların hepsi ve ekleme kuralları (çakışma eşiği, uyarı sınırları; Piyasa grafiği ve
// eski sistemin /live grafiği). POST: zon ekleme ya da düzenleme (lib/zone-write.ts). Oturum ya da /live'ın gizli
// anahtarı (ZONE_API_TOKEN) proxy.ts'te.
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET() {
  try {
    const [zones, rule] = await Promise.all([loadManualZones(), loadZoneRule()])
    return NextResponse.json({ zones, rule }, { headers: NO_STORE })
  } catch (err) {
    console.error(`[web] elle zonlar okunamadı: ${(err as Error).message}`)
    return NextResponse.json({ error: 'Veritabanı okunamadı' }, { status: 503, headers: NO_STORE })
  }
}

export async function POST(req: Request) {
  const source = zoneTokenOk(req) ? 'live' : 'piyasa'
  try {
    const input = parseSaveRequest(await req.json().catch(() => null))
    const r = await saveZone(input, source)
    console.log(
      `[web] elle zon #${r.zone.id} ${r.zone.lo}–${r.zone.hi} eklendi (${source})${r.ended.length ? `; pasif: ${r.ended.map((x) => `#${x}`).join(', ')}` : ''}`,
    )
    return NextResponse.json(r, { headers: NO_STORE })
  } catch (err) {
    if (err instanceof ZoneWriteError) {
      return NextResponse.json({ error: err.message, conflicts: err.conflicts }, { status: err.status, headers: NO_STORE })
    }
    console.error(`[web] elle zon kaydedilemedi: ${(err as Error).message}`)
    return NextResponse.json({ error: 'Zon kaydedilemedi (veritabanı)' }, { status: 503, headers: NO_STORE })
  }
}
