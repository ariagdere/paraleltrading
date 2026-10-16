'use client'

import { useSyncExternalStore } from 'react'

// Canlı fiyat (tarayıcı): sekme başına tek EventSource (/api/piyasa/canli), abonelere son quote'u ve akışın
// durumunu dağıtır. Sekme 30 sn arka planda kalınca kapanır, dönünce yeniden açılır. Akış kapalıysa (web'de
// MetaApi ayarı yok) ya da hatadaysa sayfa fiyatı dakikalık 1m mumlarından gösterir.

export type LiveQuote = { bid: number; ask: number; t: number }
// connecting: bağlanıyor; live: quote geliyor; quiet: akış hazır ama 30 sn'dir quote yok; off: web'de MetaApi
// ayarı yok; error: sunucu MetaApi'ye bağlanamadı (kendisi yeniden dener)
export type LiveState = 'connecting' | 'live' | 'quiet' | 'off' | 'error'
export type LiveSnapshot = { state: LiveState; quote: LiveQuote | null; error: string | null }

const QUIET_MS = 30_000
const HIDDEN_CLOSE_MS = 30_000
const REOPEN_MS = 30_000

type ServerStatus = { state: 'off' | 'idle' | 'connecting' | 'ready' | 'error'; error: string | null }

let snap: LiveSnapshot = { state: 'connecting', quote: null, error: null }
const subs = new Set<() => void>()
let es: EventSource | null = null
let gotAt = 0 // son quote'un tarayıcıya geldiği an
let server: ServerStatus['state'] = 'connecting'
let quietTimer: ReturnType<typeof setInterval> | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null
let reopenTimer: ReturnType<typeof setTimeout> | null = null

function set(next: Partial<LiveSnapshot>) {
  snap = { ...snap, ...next }
  for (const f of subs) f()
}

function stateFrom(st: ServerStatus['state']): LiveState {
  if (st === 'off') return 'off'
  if (st === 'error') return 'error'
  if (st === 'ready') return Date.now() - gotAt < QUIET_MS ? 'live' : 'quiet'
  return 'connecting'
}

const parse = (e: Event) => {
  try {
    return JSON.parse((e as MessageEvent).data)
  } catch {
    return null
  }
}

function open() {
  if (es || typeof window === 'undefined') return
  const src = new EventSource('/api/piyasa/canli')
  es = src
  src.addEventListener('hello', (e) => {
    const d = parse(e)
    if (!d) return
    server = d.status?.state ?? 'connecting'
    const q = d.quote as LiveQuote | null
    // sunucunun son quote'u eskiyse (piyasa arası) yine de gösterilir; canlılığı quote'un anı belirler
    if (q && typeof q.bid === 'number' && typeof q.t === 'number') {
      gotAt = Math.min(Date.now(), q.t)
      set({ quote: q })
    }
    set({ state: stateFrom(server), error: d.status?.error ?? null })
  })
  src.addEventListener('quote', (e) => {
    const q = parse(e) as LiveQuote | null
    if (!q || typeof q.bid !== 'number' || typeof q.t !== 'number') return
    gotAt = Date.now()
    server = 'ready'
    set({ quote: q, state: 'live', error: null })
  })
  src.addEventListener('status', (e) => {
    const d = parse(e) as ServerStatus | null
    if (!d) return
    server = d.state
    set({ state: stateFrom(server), error: d.error ?? null })
  })
  src.onerror = () => {
    // Ağ kopması: tarayıcı kendisi yeniden bağlanır. HTTP hatası (oturum bitti, sunucu yok): 30 sn sonra yeniden.
    if (src.readyState === EventSource.CLOSED) {
      close()
      set({ state: 'error', error: 'canlı fiyat bağlantısı açılamadı' })
      if (subs.size > 0 && !reopenTimer)
        reopenTimer = setTimeout(() => {
          reopenTimer = null
          if (subs.size > 0 && document.visibilityState === 'visible') open()
        }, REOPEN_MS)
    } else set({ state: 'connecting' })
  }
  quietTimer = setInterval(() => {
    const next = stateFrom(server)
    if (next !== snap.state) set({ state: next })
  }, 5000)
}

function close() {
  es?.close()
  es = null
  if (quietTimer) clearInterval(quietTimer)
  quietTimer = null
}

function onVisibility() {
  if (document.visibilityState === 'hidden') {
    if (!hideTimer) hideTimer = setTimeout(() => ((hideTimer = null), close()), HIDDEN_CLOSE_MS)
  } else {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = null
    if (subs.size > 0) open()
  }
}

// Abone olur; ilk abone akışı açar, son abone kapatır. Dönen fonksiyon aboneliği bitirir.
export function subscribeLive(fn: () => void): () => void {
  subs.add(fn)
  if (subs.size === 1) {
    document.addEventListener('visibilitychange', onVisibility)
    open()
  }
  return () => {
    subs.delete(fn)
    if (subs.size === 0) {
      document.removeEventListener('visibilitychange', onVisibility)
      close()
      if (reopenTimer) clearTimeout(reopenTimer)
      reopenTimer = null
    }
  }
}

export const liveSnapshot = () => snap
const serverSnap: LiveSnapshot = { state: 'connecting', quote: null, error: null }

export function useLive(): LiveSnapshot {
  return useSyncExternalStore(subscribeLive, liveSnapshot, () => serverSnap)
}
