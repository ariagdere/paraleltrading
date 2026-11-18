// Emir boyutlandırma: eski sistemin panel kuralı (hakari-dashboard lib/orderMath.ts computeSizing) ve SDL'nin lot
// kuralı (Ari, 18 Kasım): hedef risk 10 $, lot adımına AŞAĞI yuvarlanır (risk hedefi aşmaz); aşağı yuvarlanan lot en
// küçük lotun altında kalıyorsa en küçük lotla girilir, yeter ki o lotta risk 20 $'ı aşmasın; aşıyorsa işlem yok.
// Risk Hakari'nin R tanımıyla aynı: 1R = |giriş − SL| × lot × contractSize ($).
//   LONG : giriş ask; SL/TP bid ile tetiklenir.  SHORT: giriş bid; SL/TP ask ile tetiklenir.

import type { Side } from './engine.js'

export type Spec = {
  contractSize: number
  minVolume: number
  maxVolume: number
  volumeStep: number
  stopsLevel: number // point
  point: number
}

export type SizingInput = {
  side: Side
  bid: number
  ask: number
  sl: number
  tp: number
  riskUsd: number // hedef
  minLotMaxRiskUsd: number // en küçük lotta izin verilen en büyük risk
  maxVolume: number // sunucu tarafı güvenlik sınırı
  spec: Spec
}

export type Sizing =
  | { ok: true; volume: number; riskUsd: number; rewardUsd: number; slDistance: number; tpDistance: number; minLot: boolean }
  | { ok: false; error: string; code: 'fiyat' | 'sembol' | 'seviye' | 'lot' | 'ust_sinir'; minRiskUsd?: number }

const isPos = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0
const clean = (x: number) => Number(x.toFixed(10)) // 0.030000000000000002 → 0.03

export function computeSizing(inp: SizingInput): Sizing {
  const { side, bid, ask, sl, tp, spec } = inp
  if (!isPos(bid) || !isPos(ask) || ask < bid) return { ok: false, code: 'fiyat', error: 'Geçerli fiyat yok' }
  if (!isPos(spec?.contractSize) || !isPos(spec?.minVolume) || !isPos(spec?.volumeStep)) {
    return { ok: false, code: 'sembol', error: 'Sembol bilgisi eksik' }
  }
  const minGap = (spec.stopsLevel > 0 ? spec.stopsLevel : 0) * (spec.point > 0 ? spec.point : 0)
  if (side === 'LONG') {
    if (!(sl < bid - minGap)) return { ok: false, code: 'seviye', error: "Long'da SL mevcut fiyatın altında olmalı" }
    if (!(tp > bid + minGap)) return { ok: false, code: 'seviye', error: "Long'da TP mevcut fiyatın üstünde olmalı" }
  } else {
    if (!(sl > ask + minGap)) return { ok: false, code: 'seviye', error: "Short'ta SL mevcut fiyatın üstünde olmalı" }
    if (!(tp < ask - minGap)) return { ok: false, code: 'seviye', error: "Short'ta TP mevcut fiyatın altında olmalı" }
  }
  const slDistance = clean(side === 'LONG' ? ask - sl : sl - bid)
  const tpDistance = clean(side === 'LONG' ? tp - ask : bid - tp)
  if (!(tpDistance > 0)) return { ok: false, code: 'seviye', error: 'TP spread içinde kalıyor' }

  const perLot = slDistance * spec.contractSize
  const minRiskUsd = clean(spec.minVolume * perLot)
  const steps = Math.floor(inp.riskUsd / perLot / spec.volumeStep + 1e-9)
  let volume = clean(steps * spec.volumeStep)
  let minLot = false
  if (volume < spec.minVolume) {
    if (minRiskUsd > inp.minLotMaxRiskUsd) {
      return {
        ok: false,
        code: 'lot',
        minRiskUsd,
        error: `En küçük lot (${spec.minVolume}) bu SL mesafesinde $${minRiskUsd.toFixed(2)} risk ediyor; sınır $${inp.minLotMaxRiskUsd}`,
      }
    }
    volume = spec.minVolume
    minLot = true
  }
  const max = Math.min(isPos(spec.maxVolume) ? spec.maxVolume : Infinity, isPos(inp.maxVolume) ? inp.maxVolume : Infinity)
  if (volume > max) return { ok: false, code: 'ust_sinir', error: `Lot üst sınırı (${max}) aşılıyor` }
  return {
    ok: true,
    volume,
    riskUsd: clean(volume * perLot),
    rewardUsd: clean(volume * tpDistance * spec.contractSize),
    slDistance,
    tpDistance,
    minLot,
  }
}

// MetaApi sembol bilgisinden (axi_symbol_spec.spec) boyutlandırmanın alanları; eksikse null.
export function specFrom(b: unknown): Spec | null {
  if (!b || typeof b !== 'object') return null
  const o = b as Record<string, unknown>
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null)
  const spec: Spec = {
    contractSize: Number(o.contractSize),
    minVolume: Number(o.minVolume),
    maxVolume: Number(o.maxVolume),
    volumeStep: Number(o.volumeStep),
    stopsLevel: n(o.stopsLevel) ?? 0,
    point: n(o.point) ?? n(o.tickSize) ?? 0.01,
  }
  return [spec.contractSize, spec.minVolume, spec.volumeStep].every(isPos) ? spec : null
}
