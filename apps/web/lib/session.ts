// Oturum: imzalı çerez (HMAC-SHA256, Web Crypto). Sunucuda oturum tablosu yok; çerez kendi süresini ve
// imzasını taşır. Eski dashboard'un oturumuyla aynı tasarım (hakari-dashboard lib/session.ts).
//
// Kimlik bilgileri Railway değişkenlerinden: WEB_USER, WEB_PASSWORD. İmza anahtarı kullanıcı + şifre + gizli
// değer: WEB_SESSION_SECRET (uzun rastgele bir değer önerilir), tanımlı değilse DATABASE_URL. Ele geçen bir
// çerezden şifre denenerek çözülemez; şifre ya da gizli değer değişince bütün oturumlar kapanır.
//
// Süreler: oturum 30 gün; 1 günden eski geçerli oturum her istekte 30 güne uzar (kayan süre), ama girişten
// 90 gün sonra yeniden giriş istenir.

export const SESSION_COOKIE = 'hakari2_session'
export const SESSION_TTL_SEC = 30 * 24 * 3600
export const SESSION_REFRESH_AFTER_SEC = 24 * 3600
export const SESSION_MAX_SEC = 90 * 24 * 3600

export interface SessionPayload {
  u: string // kullanıcı
  lt: number // giriş anı (uzatmalarda değişmez)
  iat: number // bu çerezin üretildiği an
  exp: number
}

export function authCredentials(): { user: string; pass: string } | null {
  const user = process.env.WEB_USER
  const pass = process.env.WEB_PASSWORD
  return user && pass ? { user, pass } : null
}

// Sabit zamanlı karşılaştırma.
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const enc = new TextEncoder()

function toB64url(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url')
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

let keyCache: { material: string; key: CryptoKey } | null = null

async function sessionKey(creds: { user: string; pass: string }): Promise<CryptoKey> {
  const secret = process.env.WEB_SESSION_SECRET || process.env.DATABASE_URL || ''
  const material = `hakari2-session-v1\n${creds.user}\n${creds.pass}\n${secret}`
  if (keyCache && keyCache.material === material) return keyCache.key
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(material))
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  keyCache = { material, key }
  return key
}

const nowSec = () => Math.floor(Date.now() / 1000)

// Yeni oturum çerezi (loginAt: ilk giriş anı, uzatmada eskisi verilir); kimlik bilgileri tanımlı değilse null.
export async function createSessionToken(now = nowSec(), loginAt = now): Promise<string | null> {
  const creds = authCredentials()
  if (!creds) return null
  const payload: SessionPayload = { u: creds.user, lt: loginAt, iat: now, exp: Math.min(now + SESSION_TTL_SEC, loginAt + SESSION_MAX_SEC) }
  const body = toB64url(enc.encode(JSON.stringify(payload)))
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await sessionKey(creds), enc.encode(body)))
  return `${body}.${toB64url(sig)}`
}

// Geçerli (imza doğru, süresi dolmamış, kullanıcı aynı) oturumun içeriği; değilse null. Hiç throw etmez.
export async function verifySessionToken(token: string | null | undefined, now = nowSec()): Promise<SessionPayload | null> {
  const creds = authCredentials()
  if (!creds || !token || token.length > 1024) return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null
  const body = token.slice(0, dot)
  try {
    const sig = fromB64url(token.slice(dot + 1))
    const ok = await crypto.subtle.verify('HMAC', await sessionKey(creds), sig, enc.encode(body))
    if (!ok) return null
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body)))
    if (typeof p?.u !== 'string' || ![p.lt, p.iat, p.exp].every((x) => typeof x === 'number' && Number.isFinite(x))) return null
    if (!safeEqual(p.u, creds.user)) return null
    if (p.exp <= now || p.iat > now + 300 || p.lt > p.iat) return null
    if (now - p.lt > SESSION_MAX_SEC) return null
    return { u: p.u, lt: p.lt, iat: p.iat, exp: p.exp }
  } catch {
    return null
  }
}

export function needsRefresh(p: SessionPayload, now = nowSec()): boolean {
  return now - p.iat >= SESSION_REFRESH_AFTER_SEC
}

// Secure yalnız https isteklerde (Railway TLS'i sonlandırıp x-forwarded-proto gönderir; yerel http testlerinde
// Secure çerez tarayıcıya yazılmaz).
export function sessionCookieOptions(secure: boolean, maxAge = SESSION_TTL_SEC) {
  return { httpOnly: true, secure, sameSite: 'lax' as const, path: '/', maxAge }
}

function firstHeaderValue(v: string | null): string | null {
  const first = (v ?? '').split(',')[0]!.trim()
  return first || null
}

export function isHttpsRequest(req: { headers: Headers; nextUrl?: { protocol: string } }): boolean {
  const proto = firstHeaderValue(req.headers.get('x-forwarded-proto'))
  if (proto) return proto.toLowerCase() === 'https'
  return req.nextUrl?.protocol === 'https:'
}

// İstemcinin IP'si: Railway'in kenar proxy'si X-Real-IP'yi bağlanan IP olarak yazar; yoksa X-Forwarded-For'un ilki.
export function clientIp(req: { headers: Headers }): string {
  return firstHeaderValue(req.headers.get('x-real-ip')) ?? firstHeaderValue(req.headers.get('x-forwarded-for')) ?? 'unknown'
}

// Kullanıcının tarayıcıda gördüğü adres: Next isteği localhost:PORT olarak görür, yönlendirmeler bu yüzden
// Host / X-Forwarded-* başlıklarından kurulur.
export function publicUrl(req: { headers: Headers; nextUrl: URL }, path: string): URL {
  const host = firstHeaderValue(req.headers.get('x-forwarded-host')) ?? firstHeaderValue(req.headers.get('host')) ?? req.nextUrl.host
  const proto = isHttpsRequest(req) ? 'https' : 'http'
  return new URL(path, `${proto}://${host}`)
}

// Girişten sonra gidilecek yol: yalnız bu sitedeki bir yol, yalnız yazdırılabilir ASCII. Dışarıya ya da giriş
// sayfasının kendisine yönlendirilmez.
export function safeNextPath(next: string | null | undefined): string {
  if (typeof next !== 'string' || next.length === 0 || next.length > 2000) return '/'
  if (!/^\/[\x21-\x7e]*$/.test(next)) return '/'
  if (next.startsWith('//') || next.startsWith('/\\')) return '/'
  if (next === '/login' || next.startsWith('/login?') || next.startsWith('/api/auth/')) return '/'
  return next
}

// Hatalı giriş sayacı (IP başına, bellekte; tek Railway örneği): 15 dakikada 10 hatadan sonra 15 dakika kilit.
export const MAX_LOGIN_FAILURES = 10
export const LOGIN_LOCK_MS = 15 * 60 * 1000
export const LOGIN_FAIL_DELAY_MS = 400

export function createFailureLimiter(max = MAX_LOGIN_FAILURES, windowMs = LOGIN_LOCK_MS) {
  const failures = new Map<string, { count: number; firstAt: number; lockedUntil: number }>()
  return {
    isLocked(ip: string, now = Date.now()): boolean {
      const f = failures.get(ip)
      return !!f && f.lockedUntil > now
    },
    // Hatayı kaydeder; IP kilitlendiyse true
    fail(ip: string, now = Date.now()): boolean {
      let f = failures.get(ip)
      if (!f || now - f.firstAt > windowMs) f = { count: 0, firstAt: now, lockedUntil: 0 }
      f.count++
      if (f.count >= max) f.lockedUntil = now + windowMs
      failures.set(ip, f)
      if (failures.size > 5000) {
        failures.forEach((v, k) => {
          if (v.lockedUntil <= now && now - v.firstAt > windowMs) failures.delete(k)
        })
      }
      return f.lockedUntil > now
    },
    count(ip: string): number {
      return failures.get(ip)?.count ?? 0
    },
    reset(ip: string) {
      failures.delete(ip)
    },
  }
}

// Yazan istekler için aynı köken kontrolü (CSRF): tarayıcı POST'larda Origin'i gönderir.
export function isSameOrigin(req: { headers: Headers }): { ok: boolean; origin: string | null } {
  const origin = req.headers.get('origin')
  const hosts = [req.headers.get('x-forwarded-host'), req.headers.get('host')].filter((h): h is string => !!h)
  if (!origin) return { ok: false, origin: null }
  try {
    return { ok: hosts.includes(new URL(origin).host), origin }
  } catch {
    return { ok: false, origin }
  }
}
