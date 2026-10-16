// CoinGlass heatmap çıktısını grafiğin okuyacağı sıkı biçime çevirir. Saf; veritabanına dokunmaz.
//
// Çıktı (heatmap_snapshots.payload_gz, gzip'li JSON):
//   y_axis: fiyat seviyeleri (CoinGlass fiyatı), liquidation_leverage_data: [sütun, seviye, $] hücreleri,
//   price_candlesticks: [zaman (sn), açılış, tepe, dip, kapanış, hacim] sütun mumları.
// Grafik Axi fiyatıyla çizildiği için seviyeler bazla kaydırılır: Axi'deki seviye = seviye − baz
// (baz = heatmap referansı − Axi fiyatı, core'un heatmap_levels'ında).

export type HeatGrid = {
  cols: number[] // sütun başlangıçları (ms)
  step: number // sütun süresi (ms)
  levels: number[] // seviyeler, Axi fiyatına kaydırılmış (baz yoksa CoinGlass fiyatı)
  cells: number[] // düz dizi: sütun, seviye, değer (bin $) …
  max: number // en büyük hücre (bin $)
  shifted: boolean
}

const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

export function decodeHeatmap(payload: unknown, basis: number | null): HeatGrid | null {
  const p = payload as { y_axis?: unknown; liquidation_leverage_data?: unknown; price_candlesticks?: unknown } | null
  if (!p || !Array.isArray(p.y_axis) || !Array.isArray(p.liquidation_leverage_data) || !Array.isArray(p.price_candlesticks)) return null
  const shift = basis ?? 0
  const levels: number[] = []
  for (const y of p.y_axis) {
    const v = num(y)
    if (v === null) return null
    levels.push(Math.round((v - shift) * 100) / 100)
  }
  const cols: number[] = []
  for (const k of p.price_candlesticks as unknown[]) {
    const t = num((k as unknown[] | null)?.[0])
    if (t === null) return null
    cols.push(t < 1e12 ? t * 1000 : t)
  }
  if (cols.length === 0 || levels.length === 0) return null
  const step = cols.length > 1 ? cols[1]! - cols[0]! : 5 * 60_000
  const cells: number[] = []
  let max = 0
  for (const c of p.liquidation_leverage_data as unknown[]) {
    const x = num((c as unknown[] | null)?.[0])
    const y = num((c as unknown[] | null)?.[1])
    const v = num((c as unknown[] | null)?.[2])
    if (x === null || y === null || v === null || v <= 0) continue
    if (x < 0 || x >= cols.length || y < 0 || y >= levels.length) continue
    const k = Math.round(v / 1000)
    if (k <= 0) continue
    cells.push(x, y, k)
    if (k > max) max = k
  }
  return { cols, step, levels, cells, max, shifted: basis !== null }
}
