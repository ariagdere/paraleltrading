'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

// Sayfanın sunucu tarafını belli aralıkla yeniden çizer (kaydırma ve sayfa durumu korunur). Sekme arka plandayken
// istek atmaz; sekmeye dönülünce hemen yeniler.
export function AutoRefresh({ everyMs = 30_000 }: { everyMs?: number }) {
  const router = useRouter()
  useEffect(() => {
    const visible = () => document.visibilityState === 'visible'
    const timer = setInterval(() => {
      if (visible()) router.refresh()
    }, everyMs)
    const onVisible = () => {
      if (visible()) router.refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [router, everyMs])
  return null
}
