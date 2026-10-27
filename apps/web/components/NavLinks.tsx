'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import s from './nav.module.css'

// Menü bağlantıları; bulunulan sayfa işaretli.
const LINKS = [
  { href: '/piyasa', label: 'Piyasa' },
  { href: '/dogrulama', label: 'Doğrulama' },
  { href: '/simulasyon', label: 'Simülasyon' },
  { href: '/saglik', label: 'Sağlık' },
]

export function NavLinks() {
  const path = usePathname()
  return (
    <ul className={s.links}>
      {LINKS.map((l) => {
        const here = path === l.href || path.startsWith(`${l.href}/`)
        return (
          <li key={l.href}>
            <Link className={s.link} href={l.href} aria-current={here ? 'page' : undefined}>
              {l.label}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
