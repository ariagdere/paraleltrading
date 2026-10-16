import { NextResponse, type NextRequest } from 'next/server'
import { MAX_CANDLES, isChartTf, loadCandles, loadForming } from '@/lib/chart-data'

// Grafiğin Axi mumları: ?tf=5m|15m|1h|4h|1d; isteğe bağlı &before=<ms> (o andan önceki n mum, geçmişe kaydırınca)
// ya da &after=<ms> (o andan sonrakiler, yeni kapanışlar); &n=<adet> (varsayılan 600, en çok 2000). Oturum proxy'de.
// rows kayıtlı (kapanmış) mumlar; forming henüz kaydedilmemiş oluşan mumlar, 1m mumlarından (before'da yok).
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const tf = p.get('tf')
  if (!isChartTf(tf)) return json({ error: 'tf 5m, 15m, 1h, 4h ya da 1d olmalı' }, 400)
  const num = (k: string) => {
    const v = p.get(k)
    return v === null ? undefined : /^\d{1,15}$/.test(v) ? Number(v) : NaN
  }
  const before = num('before')
  const after = num('after')
  const n = num('n') ?? 600
  if ([before, after, n].some((v) => Number.isNaN(v)) || (before !== undefined && after !== undefined) || n < 1 || n > MAX_CANDLES)
    return json({ error: `before ya da after (ms) ve 1–${MAX_CANDLES} arası n` }, 400)
  try {
    const [rows, forming] = await Promise.all([loadCandles(tf, { before, after, n }), before === undefined ? loadForming(tf) : Promise.resolve([])])
    return json({ tf, rows, forming })
  } catch (err) {
    console.error(`[web] mumlar okunamadı: ${(err as Error).message}`)
    return json({ error: 'Veritabanı okunamadı' }, 503)
  }
}
