import { safeEqual } from './session'

// Eski sistemin /live sunucusu elle zonları sunucudan sunucuya okur ve yazar: Authorization: Bearer <ZONE_API_TOKEN>
// (en az 24 karakter; tanımlı değilse bu yol kapalı). Yalnız /api/piyasa/elle-zonlar altında geçerli (proxy.ts).
export function zoneTokenOk(req: { headers: Headers }): boolean {
  const token = process.env.ZONE_API_TOKEN
  if (!token || token.length < 24) return false
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('authorization') ?? '')
  return !!m && safeEqual(m[1]!, token)
}

export const isZoneApiPath = (pathname: string) => pathname === '/api/piyasa/elle-zonlar' || pathname.startsWith('/api/piyasa/elle-zonlar/')
