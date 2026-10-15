// Duvar saatine hizalı tekrar: her `everyMs`'de bir, sınırdan `offsetMs` sonra çalışır. Önceki tur bitmemişse
// yeni tur atlanır; aynı iş üst üste binmez. fn'e turun ait olduğu sınır anı (ör. 14:00:00) verilir.

export type Job = { stop: () => void; idle: () => Promise<void> }

export function every(name: string, everyMs: number, offsetMs: number, fn: (slot: Date) => Promise<void>): Job {
  let timer: NodeJS.Timeout | undefined
  let current: Promise<void> | null = null
  let stopped = false

  const schedule = () => {
    if (stopped) return
    const now = Date.now()
    const slot = Math.floor((now - offsetMs) / everyMs) * everyMs + everyMs
    timer = setTimeout(() => {
      schedule()
      if (current) {
        console.warn(`[${name}] önceki tur sürüyor, bu tur atlandı`)
        return
      }
      current = fn(new Date(slot))
        .catch((err) => console.error(`[${name}] ${(err as Error).message}`))
        .finally(() => {
          current = null
        })
    }, slot + offsetMs - now)
  }

  schedule()
  return {
    stop: () => {
      stopped = true
      clearTimeout(timer)
    },
    idle: () => current ?? Promise.resolve(),
  }
}
