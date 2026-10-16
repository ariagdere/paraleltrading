import { NextResponse, type NextRequest } from 'next/server'
import {
  LOGIN_FAIL_DELAY_MS, MAX_LOGIN_FAILURES, SESSION_COOKIE, authCredentials, clientIp, createFailureLimiter,
  createSessionToken, isHttpsRequest, isSameOrigin, safeEqual, safeNextPath, sessionCookieOptions,
} from '@/lib/session'

// /login formunun gönderildiği yer (düz HTML form POST'u; şifre yöneticileri en iyi bunu tanır). Başarılı
// girişte oturum çerezi yazılıp istenen sayfaya, hatada /login'e geri yönlendirilir (303, göreli adres).
// Kaba kuvvete karşı: aynı IP'den 15 dakikada 10 hatalı denemede o IP 15 dakika kilitlenir.

const limiter = createFailureLimiter()

function redirect(location: string) {
  return new NextResponse(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } })
}

function backToLogin(error: string, next: string) {
  const q = new URLSearchParams({ error })
  if (next !== '/') q.set('next', next)
  return redirect(`/login?${q.toString()}`)
}

export async function POST(req: NextRequest) {
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return backToLogin('1', '/')
  }
  const username = String(form.get('username') ?? '')
  const password = String(form.get('password') ?? '')
  const next = safeNextPath(String(form.get('next') ?? '/'))

  // Başka bir siteden gönderilen form (giriş CSRF'i). Origin göndermeyen istemciye izin verilir.
  const origin = isSameOrigin(req)
  if (origin.origin && !origin.ok) return backToLogin('origin', next)

  const creds = authCredentials()
  if (!creds) return backToLogin('config', next)

  const ip = clientIp(req)
  if (limiter.isLocked(ip)) {
    console.warn(`[web] giriş: kilitli IP'den deneme (${ip})`)
    return backToLogin('locked', next)
  }

  if (!(safeEqual(username, creds.user) && safeEqual(password, creds.pass))) {
    const locked = limiter.fail(ip)
    console.warn(`[web] giriş: hatalı (${ip}, ${limiter.count(ip)}/${MAX_LOGIN_FAILURES})`)
    await new Promise((r) => setTimeout(r, LOGIN_FAIL_DELAY_MS))
    return backToLogin(locked ? 'locked' : '1', next)
  }

  limiter.reset(ip)
  const token = await createSessionToken()
  if (!token) return backToLogin('config', next)
  console.log(`[web] giriş yapıldı (${ip})`)
  const res = redirect(next)
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(isHttpsRequest(req)))
  return res
}
