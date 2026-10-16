import { NextResponse, type NextRequest } from 'next/server'
import {
  SESSION_COOKIE, authCredentials, createSessionToken, isHttpsRequest, isSameOrigin, needsRefresh, publicUrl,
  safeNextPath, sessionCookieOptions, verifySessionToken,
} from '@/lib/session'

// Bütün sayfalar ve API için erişim kontrolü (Next 16'da middleware yerine proxy).
// - Sayfalar oturum çerezi ister; yoksa /login'e yönlendirilir.
// - API (/api/*) oturum çerezi ister; yoksa 401 JSON.
// - Yazan API istekleri başka bir siteden geliyorsa 403 (CSRF).
// - WEB_USER / WEB_PASSWORD tanımlı değilse hiçbir sayfa açılmaz: giriş sayfası yapılandırma hatasını gösterir.
// - Oturumsuz yollar: /login, /api/health (Railway sağlık kontrolü), /api/auth/login, /api/auth/logout.

const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/login', '/api/auth/logout'])
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next()

  if (pathname.startsWith('/api/') && !SAFE_METHODS.has(req.method)) {
    const o = isSameOrigin(req)
    const site = req.headers.get('sec-fetch-site')
    if (o.origin ? !o.ok : site === 'cross-site' || site === 'same-site') {
      return NextResponse.json({ error: 'Geçersiz istek kaynağı' }, { status: 403 })
    }
  }

  const session = authCredentials() ? await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value) : null

  if (pathname === '/login') {
    // Zaten giriş yapılmışsa formu gösterme, gidilmek istenen sayfaya geç
    if (session) return NextResponse.redirect(publicUrl(req, safeNextPath(req.nextUrl.searchParams.get('next'))))
    return NextResponse.next()
  }

  if (session) {
    const res = NextResponse.next()
    if (needsRefresh(session)) {
      // Kayan süre: çerez yenilenir, giriş anı (90 günlük üst sınır) korunur
      const token = await createSessionToken(undefined, session.lt)
      if (token) res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(isHttpsRequest(req)))
    }
    return res
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Oturum açılmamış ya da süresi dolmuş. Sayfayı yenileyip giriş yap.' }, { status: 401 })
  }

  // Girdikten sonra dönülecek sayfa (istemci gezintisinin _rsc parametresi atılır)
  const params = new URLSearchParams(search)
  params.delete('_rsc')
  const back = pathname + (params.toString() ? `?${params.toString()}` : '')
  return NextResponse.redirect(publicUrl(req, `/login?next=${encodeURIComponent(back)}`))
}

export const config = {
  // Next'in statik dosyaları ve simge hariç her şey.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
}
