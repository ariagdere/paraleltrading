import type { Metadata } from 'next'
import { authCredentials, safeNextPath } from '@/lib/session'
import s from './login.module.css'

export const metadata: Metadata = { title: 'Giriş' }

// Düz HTML formu: şifre yöneticileri tanısın, JavaScript'siz de çalışsın. Gönderim /api/auth/login'e.
const ERRORS: Record<string, string> = {
  '1': 'Kullanıcı adı ya da şifre hatalı.',
  locked: 'Çok fazla hatalı deneme yapıldı. 15 dakika sonra yeniden dene.',
  origin: 'Form başka bir sayfadan gönderilmiş. Bu sayfayı yenileyip yeniden dene.',
  config: "Giriş ayarlanmamış. Railway'de web servisine WEB_USER ve WEB_PASSWORD değişkenlerini ekle.",
}

type Search = { error?: string | string[]; next?: string | string[]; out?: string | string[] }
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function LoginPage({ searchParams }: { searchParams: Promise<Search> }) {
  const q = await searchParams
  const configured = authCredentials() !== null
  const error = configured ? ERRORS[one(q.error) ?? ''] : ERRORS.config
  const next = safeNextPath(one(q.next))
  const out = one(q.out) === '1' && !error

  return (
    <main className={s.page}>
      <div className={s.panel}>
        <p className={s.mark}>Hakari 2</p>
        <h1 className={s.title}>Giriş yap</h1>

        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
        {out && (
          <p className={s.info} role="status">
            Çıkış yapıldı.
          </p>
        )}

        <form className={s.form} method="post" action="/api/auth/login">
          <input type="hidden" name="next" value={next} />
          <label className={s.field}>
            <span>Kullanıcı adı</span>
            <input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required />
          </label>
          <label className={s.field}>
            <span>Şifre</span>
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <button className={s.submit} type="submit" disabled={!configured}>
            Giriş yap
          </button>
        </form>
      </div>
    </main>
  )
}
