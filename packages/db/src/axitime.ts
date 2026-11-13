// Axi'nin sunucu saati New York + 7 saat: ABD yaz saatinde UTC+3, kışın UTC+2; geçiş New York'la aynı anda (ör. 1 Kasım
// 2026 06:00 UTC, 14 Mart 2027 07:00 UTC). Axi'nin 4h mumları bu saatin 00, 04, 08 … saatlerinde, 1d mumları 00:00'ında
// açılır: yazın İstanbul'la aynı anlar, kışın İstanbul'dan bir saat sonra (01, 05, 09 …).
// MetaApi, mumların ve quote'ların UTC zamanını (time) bu hesap için sabit +3 saatle hesaplıyor; kışın bir saat erken
// çıkıyor. Sunucu saati (brokerTime) doğru; gerçek zaman ondan hesaplanır (axiToUtc).

const H = 3_600_000
const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
const cache = new Map<number, number>()

// t anında (UTC, ms) Axi sunucu saatinin UTC'den farkı (ms): yazın 3, kışın 2 saat.
export function axiOffsetMs(t: number): number {
  const hour = Math.floor(t / H) // geçişler saat başında: saat içinde fark değişmez
  let off = cache.get(hour)
  if (off === undefined) {
    const name = ny.formatToParts(new Date(hour * H)).find((p) => p.type === 'timeZoneName')?.value ?? ''
    const m = /^GMT([+-]\d+)$/.exec(name)
    if (!m) throw new Error(`New York saat farkı okunamadı (${name || 'boş'})`)
    off = (Number(m[1]) + 7) * H
    if (cache.size > 100_000) cache.clear()
    cache.set(hour, off)
  }
  return off
}

// Axi sunucu saatindeki bir an (duvar saati, UTC gibi okunmuş ms) gerçek UTC'ye. Kışa dönüşte sunucu saatinin iki kez
// yaşadığı saat (ör. 1 Kasım 2026 08:00–09:00) için iki yorum da geçerli: near verilmişse ona yakın olan, yoksa kış
// saati.
export function axiToUtc(local: number, near?: number): number {
  const winter = local - 2 * H
  const summer = local - 3 * H
  const w = axiOffsetMs(winter) === 2 * H
  const s = axiOffsetMs(summer) === 3 * H
  if (w && s) return near !== undefined && Math.abs(near - summer) < Math.abs(near - winter) ? summer : winter
  return w ? winter : summer
}

// t anını içeren Axi mumunun açılışı. 1 saate kadar dilimler UTC'ye hizalı (fark tam saat); 4h ve 1d sunucu saatine:
// aralık başı sunucu saatinde bulunup gerçek UTC'ye çevrilir (geçiş günlerinde mum 23 ya da 25 saat sürer).
export function axiOpen(t: number, step: number): number {
  if (step <= H) return Math.floor(t / step) * step
  const off = axiOffsetMs(t)
  const local = Math.floor((t + off) / step) * step
  const start = axiToUtc(local, t)
  return start <= t ? start : local - off
}
