import Link from 'next/link'
import type { ReactNode } from 'react'
import { NavLinks } from '@/components/NavLinks'
import s from '@/components/nav.module.css'

// Girişten sonraki bütün sayfaların çerçevesi (oturum kontrolü proxy.ts'te).
export default function KonsolLayout({ children }: { children: ReactNode }) {
  return (
    <div className={s.shell}>
      <nav className={s.nav} aria-label="Ana menü">
        <Link className={s.mark} href="/piyasa">
          Hakari 2
        </Link>
        <NavLinks />
        <form className={s.logout} method="post" action="/api/auth/logout">
          <button className={s.logoutButton} type="submit">
            Çıkış yap
          </button>
        </form>
      </nav>
      <main className={s.main}>{children}</main>
    </div>
  )
}
