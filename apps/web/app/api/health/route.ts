import { NextResponse } from 'next/server'

// Railway sağlık kontrolü; oturum istemez, veri döndürmez.
export function GET() {
  return NextResponse.json({ ok: true })
}
