import { NextResponse } from 'next/server'
import { zoneTokenOk } from '@/lib/zone-token'
import { ZoneWriteError, endZone } from '@/lib/zone-write'

// Elle zonu pasife alma (yerine zon eklenmez; end_reason kapatma). Oturum ya da /live'ın gizli anahtarı proxy.ts'te.
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: raw } = await ctx.params
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'Zon numarası geçersiz' }, { status: 400, headers: NO_STORE })
  try {
    await endZone(id)
    console.log(`[web] elle zon #${id} pasife alındı (${zoneTokenOk(req) ? 'live' : 'piyasa'})`)
    return NextResponse.json({ ended: [id] }, { headers: NO_STORE })
  } catch (err) {
    if (err instanceof ZoneWriteError) return NextResponse.json({ error: err.message }, { status: err.status, headers: NO_STORE })
    console.error(`[web] elle zon #${id} pasife alınamadı: ${(err as Error).message}`)
    return NextResponse.json({ error: 'Zon pasife alınamadı (veritabanı)' }, { status: 503, headers: NO_STORE })
  }
}
