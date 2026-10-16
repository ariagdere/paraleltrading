// Heatmap seviyelerinin saf hesabı; veritabanına dokunmaz.
//
// Cluster kuralı eski sistemin computeClusters'ı (hakari-trigger-orchestrator; "browse-ai-coordinator'dan birebir"):
// her y seviyesinin bütün sütunlardaki likidasyon toplamı; referans fiyat price_candlesticks'in son kapanışı;
// $1M altı seviyeler dışarıda. Bir yöndeki en büyük seviye (eşitlikte ilk görülen) ve onun ±$300'ündeki seviyeler
// bir cluster: fiyatı likiditeyle ağırlıklı ortalama, likiditesi toplam. Eski sistem yalnız bu ilk cluster'ı
// kullanıyordu; 2. ve 3. cluster aynı kuralın kalan seviyelerde tekrarı (her seferinde kalanların en büyük
// seviyesinden; sıra tepe seviyeye göre, toplama göre değil).

export const MIN_LIQ_USD = 1_000_000
export const MERGE_DIST = 300
export const BANDS = [0.01, 0.02, 0.03] as const
export const TOP = 3

export type Cluster = { price: number; usd: number }
export type Levels = {
  ref: number
  up: Cluster[] // tepe seviyesi büyükten küçüğe, en çok 3
  dn: Cluster[]
  upLiq: number[] // BANDS sırasıyla
  dnLiq: number[]
}

type Heatmap = { y_axis?: unknown; liquidation_leverage_data?: unknown; price_candlesticks?: unknown }

// En büyük seviye ve ±MERGE_DIST'i (eski dominantCluster).
function dominant(items: Array<[number, number]>): { peak: number; mid: number; usd: number } {
  let peakPrice = items[0]![0]
  let peakUsd = items[0]![1]
  for (const [price, usd] of items) {
    if (usd > peakUsd) {
      peakUsd = usd
      peakPrice = price
    }
  }
  let total = 0
  let weighted = 0
  for (const [price, usd] of items) {
    if (Math.abs(price - peakPrice) <= MERGE_DIST) {
      total += usd
      weighted += price * usd
    }
  }
  return { peak: peakPrice, mid: weighted / total, usd: total }
}

function topClusters(items: Array<[number, number]>): Cluster[] {
  const out: Cluster[] = []
  let rest = items
  while (out.length < TOP && rest.length > 0) {
    const c = dominant(rest)
    out.push({ price: c.mid, usd: c.usd })
    rest = rest.filter(([price]) => Math.abs(price - c.peak) > MERGE_DIST)
  }
  return out
}

// Çıktı beklenen biçimde değilse ya da referans fiyat yoksa null.
export function computeLevels(h: Heatmap): Levels | null {
  const y = h?.y_axis
  const cells = h?.liquidation_leverage_data
  const candles = h?.price_candlesticks
  if (!Array.isArray(y) || !Array.isArray(cells) || !Array.isArray(candles)) return null
  if (y.length === 0 || cells.length === 0 || candles.length === 0) return null
  const ref = parseFloat((candles[candles.length - 1] as unknown[] | undefined)?.[4] as string)
  if (!(ref > 0)) return null

  const byLevel = new Map<number, number>()
  for (const cell of cells as unknown[][]) {
    const yi = cell?.[1] as number
    byLevel.set(yi, (byLevel.get(yi) || 0) + Number(cell?.[2]))
  }

  const up: Array<[number, number]> = []
  const dn: Array<[number, number]> = []
  const upLiq = BANDS.map(() => 0)
  const dnLiq = BANDS.map(() => 0)
  for (const [yi, usd] of byLevel) {
    if (y[yi] === undefined) continue
    const price = Number(y[yi])
    if (!Number.isFinite(price) || !Number.isFinite(usd)) continue
    BANDS.forEach((b, i) => {
      if (price > ref && price <= ref * (1 + b)) upLiq[i]! += usd
      else if (price < ref && price >= ref * (1 - b)) dnLiq[i]! += usd
    })
    if (usd < MIN_LIQ_USD) continue
    if (price > ref) up.push([price, usd])
    else if (price < ref) dn.push([price, usd])
  }
  return { ref, up: topClusters(up), dn: topClusters(dn), upLiq, dnLiq }
}
