// Ekranda bütün saatler İstanbul (UTC+3, yaz/kış yok).

const TZ = 'Europe/Istanbul'
const hm = new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
const dayMonth = new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, day: 'numeric', month: 'short' })
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })

const hms = new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' })
const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', hourCycle: 'h23' })
const DOW: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

export const istanbulDay = (d: Date) => dayKey.format(d) // 'YYYY-MM-DD'

// İstanbul'da haftanın günü (1 pazartesi … 7 pazar) ve saat (0–23).
export function istanbulWeekHour(d: Date): { dow: number; hour: number } {
  const p = Object.fromEntries(parts.formatToParts(d).map((x) => [x.type, x.value]))
  return { dow: DOW[p.weekday ?? ''] ?? 0, hour: Number(p.hour) }
}

export const clockSec = (d: Date) => hms.format(d) // "09:31:20"

// Bugünse "09:30", dünse "dün 21:00", yarınsa "yarın 00:00", değilse "15 Eki 21:00".
export function clock(d: Date | null, now = new Date()): string {
  if (!d) return '—'
  const day = istanbulDay(d)
  if (day === istanbulDay(now)) return hm.format(d)
  if (day === istanbulDay(new Date(now.getTime() - 86_400_000))) return `dün ${hm.format(d)}`
  if (day === istanbulDay(new Date(now.getTime() + 86_400_000))) return `yarın ${hm.format(d)}`
  return `${dayMonth.format(d)} ${hm.format(d)}`
}

// "40 sn", "3 dk", "2 sa 5 dk", "3 gün"
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} sn`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} dk`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 ? `${h} sa ${m % 60} dk` : `${h} sa`
  return `${Math.floor(h / 24)} gün`
}
