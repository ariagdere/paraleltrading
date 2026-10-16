import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import '@fontsource-variable/atkinson-hyperlegible-next'
import './globals.css'

export const metadata: Metadata = {
  title: { default: 'Hakari 2', template: '%s – Hakari 2' },
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  themeColor: '#131a2a',
  colorScheme: 'dark',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  )
}
