import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, isHttpsRequest, isSameOrigin, sessionCookieOptions } from '@/lib/session'

// Menüdeki "Çıkış": oturum çerezini siler, giriş sayfasına döner.
export async function POST(req: NextRequest) {
  const origin = isSameOrigin(req)
  if (origin.origin && !origin.ok) return NextResponse.json({ error: 'Geçersiz istek kaynağı' }, { status: 403 })
  const res = new NextResponse(null, { status: 303, headers: { Location: '/login?out=1', 'Cache-Control': 'no-store' } })
  res.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(isHttpsRequest(req), 0))
  return res
}
